// ─── Meeting-platform abstraction ───────────────────────────────
// Each supported platform (Google Meet today; Zoom / Teams later)
// implements `MeetingBot`. A bot's only job is to get a browser into
// the meeting with the meeting's audio playing into the system's
// audio sink. Capturing that audio and transcribing it happens one
// layer up, in `Session` — so platforms stay small and swappable.

export interface BotCallbacks {
  /** The bot has asked to join and is waiting for the host to admit it. */
  onWaitingAdmit?: () => void;
  /** The bot is now inside the meeting; audio is flowing. */
  onAdmitted?: () => void;
  /** The meeting ended, or the bot was removed / left. */
  onLeft?: () => void;
  /** A fatal problem — the session should move to the `error` state. */
  onError?: (message: string) => void;
}

export interface BotOptions {
  /** Full meeting URL (e.g. https://meet.google.com/abc-defg-hij). */
  meetingUrl: string;
  /** Name the bot appears as in the participant list. */
  displayName: string;
  /** PulseAudio sink Chromium should render into (matches AUDIO_SINK). */
  audioSink: string;
  /** Owning session id — used for log prefixes and the screenshot path. */
  sessionId: string;
  callbacks: BotCallbacks;
}

export interface MeetingBot {
  /** Human-readable platform id, e.g. "google-meet". */
  readonly platform: string;
  /** Open a browser, join the meeting, resolve once admitted. */
  join(): Promise<void>;
  /** Leave the meeting and tear the browser down. */
  leave(): Promise<void>;
}

/** Decide which platform a meeting URL belongs to. */
export function detectPlatform(meetingUrl: string): 'google-meet' | 'zoom' | 'teams' | 'unknown' {
  let host = '';
  try {
    host = new URL(meetingUrl).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (host.includes('meet.google.com')) return 'google-meet';
  if (host.includes('zoom.')) return 'zoom';
  if (host.includes('teams.microsoft.com') || host.includes('teams.live.com')) return 'teams';
  return 'unknown';
}
