// ─── Meeting audio capture ──────────────────────────────────────
// The bot's Chromium plays the meeting audio into a PulseAudio null
// sink. We capture that sink's `.monitor` source with ffmpeg and
// re-encode it to the raw PCM format Deepgram's live API expects:
// 16 kHz, mono, signed 16-bit little-endian.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface AudioCapture {
  /** Raw linear16 / 16 kHz / mono PCM — pipe straight to Deepgram. */
  readonly stream: Readable;
  /** Stop ffmpeg and release the capture. */
  stop(): void;
}

/**
 * Start capturing the given PulseAudio sink's monitor source.
 * `sink` must match the null sink created in docker/entrypoint.sh.
 */
export function startAudioCapture(sink: string): AudioCapture {
  const monitorSource = `${sink}.monitor`;

  const ffmpeg: ChildProcess = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'pulse',         // input: PulseAudio
    '-i', monitorSource,   // ...the monitor of our null sink
    '-ac', '1',            // mono
    '-ar', '16000',        // 16 kHz
    '-f', 's16le',         // signed 16-bit little-endian PCM
    'pipe:1',              // write to stdout
  ]);

  ffmpeg.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.error('[ffmpeg]', line);
  });
  ffmpeg.on('exit', (code) => {
    if (code && code !== 0) console.error(`[ffmpeg] exited with code ${code}`);
  });

  if (!ffmpeg.stdout) {
    throw new Error('ffmpeg produced no stdout stream');
  }

  return {
    stream: ffmpeg.stdout,
    stop() {
      try {
        ffmpeg.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}
