// ─── Session ────────────────────────────────────────────────────
// One `Session` == one meeting. It wires together the four moving
// parts and owns the state machine:
//
//   MeetingBot  →  joins the call, makes audio play into the sink
//   AudioCapture → ffmpeg pulls PCM off the sink monitor
//   DeepgramLiveClient → PCM in, diarized transcript out
//   translate() → Claude turns each finalized turn into the target lang
//
// Everything the dashboard sees is emitted through `emit`.

import { randomUUID } from 'node:crypto';
import type { SessionEvent, SessionState, SessionSummary, StartSessionRequest } from './types.js';
import { detectPlatform, type MeetingBot } from './platforms/types.js';
import { GoogleMeetBot } from './platforms/googleMeet.js';
import { startAudioCapture, type AudioCapture } from './audio.js';
import { DeepgramLiveClient } from './deepgram.js';
import { translate } from './translate.js';

export class Session {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly meetingUrl: string;
  readonly platform: string;
  readonly sourceLang: string;
  readonly targetLang: string;

  private state: SessionState = 'joining';
  private errorMessage?: string;
  private segmentCount = 0;

  private bot: MeetingBot | null = null;
  private audio: AudioCapture | null = null;
  private deepgram: DeepgramLiveClient | null = null;

  constructor(
    req: StartSessionRequest,
    private readonly emit: (event: SessionEvent) => void,
  ) {
    this.meetingUrl = req.meetingUrl;
    this.sourceLang = req.sourceLang;
    this.targetLang = req.targetLang;
    this.platform = detectPlatform(req.meetingUrl);
  }

  get summary(): SessionSummary {
    return {
      id: this.id,
      state: this.state,
      platform: this.platform,
      meetingUrl: this.meetingUrl,
      sourceLang: this.sourceLang,
      targetLang: this.targetLang,
      startedAt: this.startedAt,
      segmentCount: this.segmentCount,
      error: this.errorMessage,
    };
  }

  /** Begin: dispatch the bot into the meeting. */
  async start(displayName: string, audioSink: string): Promise<void> {
    if (this.platform !== 'google-meet') {
      this.fail(`Unsupported platform "${this.platform}". Only Google Meet is implemented so far.`);
      return;
    }

    this.bot = new GoogleMeetBot({
      meetingUrl: this.meetingUrl,
      displayName,
      audioSink,
      callbacks: {
        onWaitingAdmit: () => this.setState('waiting-admit'),
        onAdmitted: () => {
          this.setState('live');
          this.startTranscription(audioSink);
        },
        onLeft: () => void this.stop(),
        onError: (message) => this.fail(message),
      },
    });

    await this.bot.join();
  }

  /** Once admitted: start pulling audio and transcribing it. */
  private startTranscription(audioSink: string): void {
    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    if (!deepgramKey) {
      this.fail('DEEPGRAM_API_KEY is not set');
      return;
    }

    this.deepgram = new DeepgramLiveClient(deepgramKey, {
      onInterim: (text, speaker) => this.emit({ type: 'interim', text, speaker }),
      onFinal: (text, speaker) => void this.handleFinal(text, speaker),
      onError: (message) => this.emit({ type: 'error', message }),
    });
    this.deepgram.connect();

    this.audio = startAudioCapture(audioSink);
    this.audio.stream.on('data', (chunk: Buffer) => this.deepgram?.sendAudio(chunk));
    this.audio.stream.on('error', (err: Error) =>
      this.emit({ type: 'error', message: `Audio capture error: ${err.message}` }),
    );
  }

  /** A finalized speaker turn → translate, then emit. */
  private async handleFinal(text: string, speaker: number): Promise<void> {
    this.segmentCount++;
    const ts = new Date().toISOString();
    let translated: string | null = null;
    try {
      translated = await translate(text, this.sourceLang, this.targetLang);
    } catch {
      translated = null;
    }
    this.emit({ type: 'transcript', original: text, translated, speaker, ts });
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.emit({ type: 'state', state });
  }

  private fail(message: string): void {
    this.errorMessage = message;
    this.state = 'error';
    this.emit({ type: 'state', state: 'error', error: message });
    this.emit({ type: 'error', message });
    this.cleanup();
  }

  /** Leave the meeting and release every resource. */
  async stop(): Promise<void> {
    if (this.state === 'ended' || this.state === 'error') return;
    this.cleanup();
    this.setState('ended');
  }

  private cleanup(): void {
    try { this.deepgram?.close(); } catch { /* ignore */ }
    try { this.audio?.stop(); } catch { /* ignore */ }
    try { void this.bot?.leave(); } catch { /* ignore */ }
    this.deepgram = null;
    this.audio = null;
  }
}
