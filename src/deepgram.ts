// ─── Deepgram live transcription (server-side) ──────────────────
// A Node WebSocket client to Deepgram's streaming API. Unlike the
// dashboard's browser client (lib/deepgram.ts), this runs server-side
// so it sends the master API key directly in an Authorization header
// — no short-lived token grant needed.
//
// Input audio is raw linear16 / 16 kHz / mono PCM (see audio.ts).

import WebSocket from 'ws';

export interface DeepgramCallbacks {
  onOpen?: () => void;
  /** Live, not-yet-final text for the current utterance. */
  onInterim: (text: string, speaker: number) => void;
  /** A finalized speaker turn — ready to translate and record. */
  onFinal: (text: string, speaker: number) => void;
  onError: (message: string) => void;
  onClose?: () => void;
}

interface DeepgramWord {
  speaker?: number;
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }>;
  };
}

// Pick the speaker that owns most of the words in a result.
function dominantSpeaker(words: DeepgramWord[], fallback: number): number {
  if (!words || words.length === 0) return fallback;
  const counts = new Map<number, number>();
  for (const w of words) {
    const s = typeof w.speaker === 'number' ? w.speaker : fallback;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best = fallback;
  let bestCount = -1;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = speaker;
    }
  }
  return best;
}

export class DeepgramLiveClient {
  private ws: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private finalizedText = '';
  private currentSpeaker = 0;
  private closed = false;

  constructor(
    private readonly apiKey: string,
    private readonly cb: DeepgramCallbacks,
  ) {}

  /** Open the streaming socket. nova-3 "multi" = multilingual auto-detect. */
  connect(): void {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'multi',
      diarize: 'true',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: '500',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
    });

    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      // Deepgram closes idle sockets; a periodic KeepAlive prevents that
      // during silences.
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8000);
      this.cb.onOpen?.();
    });

    ws.on('message', (raw: WebSocket.RawData) => this.handleMessage(raw));
    ws.on('error', (err) => this.cb.onError(`Deepgram socket error: ${err.message}`));
    ws.on('close', () => {
      this.clearKeepAlive();
      if (!this.closed) this.cb.onClose?.();
    });
  }

  /** Send a chunk of PCM audio. */
  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'Results') return;

    const alt = msg.channel?.alternatives?.[0];
    if (!alt) return;
    const transcript = (alt.transcript || '').trim();
    if (!transcript) return;

    const words = alt.words || [];
    const speaker = dominantSpeaker(words, this.currentSpeaker);

    if (msg.is_final) {
      // A speaker change closes the buffered turn as its own segment.
      if (this.finalizedText && speaker !== this.currentSpeaker) {
        this.cb.onFinal(this.finalizedText.trim(), this.currentSpeaker);
        this.finalizedText = '';
      }
      this.currentSpeaker = speaker;
      this.finalizedText = `${this.finalizedText} ${transcript}`.trim();

      if (msg.speech_final) {
        this.cb.onFinal(this.finalizedText.trim(), this.currentSpeaker);
        this.finalizedText = '';
      } else {
        this.cb.onInterim(this.finalizedText, this.currentSpeaker);
      }
    } else {
      this.cb.onInterim(`${this.finalizedText} ${transcript}`.trim(), speaker);
    }
  }

  private clearKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  /** Flush any buffered turn and close the socket. */
  close(): void {
    this.closed = true;
    this.clearKeepAlive();

    if (this.finalizedText.trim()) {
      this.cb.onFinal(this.finalizedText.trim(), this.currentSpeaker);
      this.finalizedText = '';
    }
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
