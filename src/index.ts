// ─── HTTP + WebSocket entrypoint ────────────────────────────────
// REST API to start/inspect/stop meeting-bot sessions, plus a
// per-session WebSocket that streams live transcript + translation
// events to the dashboard.
//
//   POST   /sessions                  → { sessionId, ...summary }
//   GET    /sessions                  → { sessions: [...] }
//   GET    /sessions/:id              → summary
//   DELETE /sessions/:id              → { stopped: true }
//   WS     /sessions/:id/stream?token=…  → SessionEvent stream
//   GET    /healthz                   → { ok: true }   (no auth)
//
// Every HTTP route except /healthz requires `Authorization: Bearer
// <WORKER_API_TOKEN>`. The WebSocket carries the same token as a
// `?token=` query param (browsers can't set WS headers).

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { SessionManager } from './sessionManager.js';
import { screenshotPath } from './paths.js';
import type { StartSessionRequest } from './types.js';

const PORT = Number(process.env.PORT || 8080);
const WORKER_API_TOKEN = process.env.WORKER_API_TOKEN;
const BOT_DISPLAY_NAME = process.env.BOT_DISPLAY_NAME || 'LenguaLive Notetaker';
const AUDIO_SINK = process.env.AUDIO_SINK || 'meet_sink';

if (!WORKER_API_TOKEN) {
  console.error('FATAL: WORKER_API_TOKEN is not set. Refusing to start.');
  process.exit(1);
}

const manager = new SessionManager(BOT_DISPLAY_NAME, AUDIO_SINK);

const app = express();
app.use(express.json());

// ── Health check — no auth, used by Fly/Docker probes. ──
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// ── Bearer-token auth for everything below. ──
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== WORKER_API_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// ── Start a meeting bot. ──
app.post('/sessions', (req, res) => {
  const body = (req.body ?? {}) as Partial<StartSessionRequest>;
  if (!body.meetingUrl || !body.sourceLang || !body.targetLang) {
    res.status(400).json({ error: 'meetingUrl, sourceLang and targetLang are required' });
    return;
  }
  const session = manager.create({
    meetingUrl: body.meetingUrl,
    sourceLang: body.sourceLang,
    targetLang: body.targetLang,
    botName: body.botName,
  });
  console.log(`[http] session ${session.id.slice(0, 8)} created for ${body.meetingUrl}`);
  res.status(201).json({
    sessionId: session.id,
    streamToken: session.streamToken,
    ...session.summary,
  });
});

// ── List all sessions. ──
app.get('/sessions', (_req, res) => {
  res.json({ sessions: manager.list() });
});

// ── Inspect one session. ──
app.get('/sessions/:id', (req, res) => {
  const session = manager.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(session.summary);
});

// ── A bot's on-failure diagnostic screenshot, if one was captured. ──
app.get('/sessions/:id/screenshot', (req, res) => {
  if (!manager.get(req.params.id)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const file = screenshotPath(req.params.id);
  if (!existsSync(file)) {
    res.status(404).json({ error: 'No screenshot for this session' });
    return;
  }
  res.sendFile(file);
});

// ── A session's recent events (state changes + transcript lines). ──
app.get('/sessions/:id/events', (req, res) => {
  if (!manager.get(req.params.id)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ events: manager.getEvents(req.params.id) });
});

// ── Stop one session (the bot leaves the meeting). ──
app.delete('/sessions/:id', async (req, res) => {
  const stopped = await manager.stop(req.params.id);
  if (!stopped) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ stopped: true });
});

// ── HTTP server + WebSocket upgrade handling. ──
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  let url: URL;
  try {
    url = new URL(request.url || '', `http://${request.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }

  const match = url.pathname.match(/^\/sessions\/([^/]+)\/stream$/);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const session = manager.get(sessionId);
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Accept either the master token (server-to-server) or this session's
  // stream token (handed to the browser) — so the master secret never
  // has to reach a browser.
  const token = url.searchParams.get('token');
  if (token !== WORKER_API_TOKEN && token !== session.streamToken) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    manager.subscribe(sessionId, ws);
  });
});

server.listen(PORT, () => {
  console.log(`LenguaLive bot-worker listening on :${PORT}`);
});
