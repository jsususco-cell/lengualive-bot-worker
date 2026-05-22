// ─── Session manager ────────────────────────────────────────────
// In-memory registry of running sessions and their WebSocket
// subscribers. One process holds one or more sessions; each session's
// events are fanned out to every dashboard client watching it.
//
// "In-memory" means sessions do NOT survive a process restart — fine
// for the MVP. Persistence is a roadmap item (see ARCHITECTURE.md).

import WebSocket from 'ws';
import type { SessionEvent, SessionSummary, StartSessionRequest } from './types.js';
import { Session } from './session.js';

// How many recent events to replay to a late-joining subscriber.
const REPLAY_BUFFER_SIZE = 200;

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly buffers = new Map<string, SessionEvent[]>();

  constructor(
    private readonly displayName: string,
    private readonly audioSink: string,
  ) {}

  /** Create a session and dispatch its bot. */
  create(req: StartSessionRequest): Session {
    const session = new Session(req, (event) => this.dispatch(session.id, event));
    this.sessions.set(session.id, session);
    this.buffers.set(session.id, []);
    // Fire-and-forget: progress is reported through emitted events.
    void session.start(req.botName || this.displayName, this.audioSink);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary);
  }

  /** The recent event buffer for a session — lets the transcript be
   *  inspected over plain HTTP, without opening the WebSocket. */
  getEvents(id: string): SessionEvent[] {
    return this.buffers.get(id) ?? [];
  }

  /** Stop a session's bot. Returns false if the id is unknown. */
  async stop(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.stop();
    return true;
  }

  /** Attach a WebSocket client to a session's event stream. */
  subscribe(id: string, ws: WebSocket): void {
    let set = this.subscribers.get(id);
    if (!set) {
      set = new Set();
      this.subscribers.set(id, set);
    }
    set.add(ws);

    // Replay recent events so a client that connects a beat late still
    // sees the transcript so far.
    for (const event of this.buffers.get(id) ?? []) {
      this.send(ws, event);
    }

    ws.on('close', () => set?.delete(ws));
    ws.on('error', () => set?.delete(ws));
  }

  private dispatch(id: string, event: SessionEvent): void {
    const buffer = this.buffers.get(id);
    if (buffer) {
      buffer.push(event);
      if (buffer.length > REPLAY_BUFFER_SIZE) buffer.shift();
    }
    const set = this.subscribers.get(id);
    if (set) {
      for (const ws of set) this.send(ws, event);
    }
  }

  private send(ws: WebSocket, event: SessionEvent): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    } catch {
      /* dead socket — it will be pruned on 'close' */
    }
  }
}
