// ─── Shared types ───────────────────────────────────────────────

/** Lifecycle of a single meeting-bot session. */
export type SessionState =
  | 'joining'        // browser is opening / navigating to the meeting
  | 'waiting-admit'  // bot asked to join, waiting for the host to admit it
  | 'live'           // admitted; audio is being transcribed + translated
  | 'ended'          // left the meeting cleanly
  | 'error';         // something failed — see `error`

/** Body of `POST /sessions`. */
export interface StartSessionRequest {
  meetingUrl: string;
  sourceLang: string;
  targetLang: string;
  botName?: string;
}

/** Public, serialisable view of a session (returned by the HTTP API). */
export interface SessionSummary {
  id: string;
  state: SessionState;
  platform: string;
  meetingUrl: string;
  sourceLang: string;
  targetLang: string;
  startedAt: string;
  segmentCount: number;
  error?: string;
}

/** Events streamed to dashboard clients over the per-session WebSocket. */
export type SessionEvent =
  | { type: 'state'; state: SessionState; error?: string }
  | { type: 'interim'; text: string; speaker: number }
  | { type: 'transcript'; original: string; translated: string | null; speaker: number; ts: string }
  | { type: 'error'; message: string };
