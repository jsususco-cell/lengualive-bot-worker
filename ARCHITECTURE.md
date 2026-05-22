# LenguaLive — System Architecture

This document describes the **whole** LenguaLive system, not just the
bot-worker. Read it before making structural changes.

LenguaLive is an AI real-time meeting translator. It does three things:

1. **Translate your own audio live** — mic or shared system audio, in
   the browser. *(Already shipped — the Vercel dashboard.)*
2. **Send a bot into a meeting** to translate the whole call live, with
   no microphone involved. *(This service — MVP, Google Meet.)*
3. **Translate a recorded meeting** — upload a file or paste a URL.
   *(Shipped in the dashboard — `/api/transcribe` + `RecordingTranslator`.)*

---

## The three components

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  1. Dashboard (Next.js)      │        │  2. Bot-worker (this repo)    │
│     Vercel — serverless      │        │     Docker — always-on host   │
│                              │        │                               │
│  • onboarding / live mic UI  │        │  • Playwright headed Chromium │
│  • RecordingTranslator       │        │  • PulseAudio sink + ffmpeg   │
│  • /api/translate  (Claude)  │        │  • Deepgram live client       │
│  • /api/transcribe (Deepgram)│        │  • Claude translation         │
│  • /api/deepgram-token       │        │  • HTTP + WebSocket API       │
└──────────────┬───────────────┘        └───────────────┬──────────────┘
               │                                        │
               │   POST /sessions  (dispatch a bot)     │
               │ ──────────────────────────────────────▶│
               │                                        │
               │   WS /sessions/:id/stream  (live)      │
               │ ◀──────────────────────────────────────│
               │                                        │
        ┌──────┴───────┐                                │
        │ 3. Live link │  WebSocket today; a managed     │
        │  + storage   │  pub/sub + DB is the next step. │
        └──────────────┘
```

### Why the split exists

Vercel functions are **serverless and short-lived** — the dashboard's
`/api/translate` is capped at 30 seconds. A meeting bot must:

- stay connected for the **entire meeting** (often an hour or more),
- keep a **headless browser** process alive,
- run a **virtual audio device**.

None of that is possible on serverless. So the bot lives in a container
on a persistent host (Fly.io / Railway / Render / a VPS), and the
dashboard controls it over an API. This separation is not a preference
— it is forced by the platform.

---

## Data flow — a live meeting

1. In the dashboard, the user pastes a meeting link and picks
   source/target languages.
2. The dashboard calls `POST /sessions` on the bot-worker with the
   shared `WORKER_API_TOKEN`.
3. The bot-worker creates a `Session` and launches a `GoogleMeetBot`.
4. Playwright opens Chromium (headed, inside Xvfb), navigates to the
   meeting, fills the guest name, mutes its own mic/camera, and clicks
   **Ask to join** → session state `waiting-admit`.
5. A meeting participant admits the bot → state `live`.
6. The meeting's audio plays out of Chromium into a **PulseAudio null
   sink**. `ffmpeg` captures that sink's `.monitor` and emits raw
   16 kHz mono PCM.
7. The PCM streams to **Deepgram** (`nova-3`, multilingual, diarized).
   Deepgram returns interim and finalized speaker turns.
8. Each finalized turn is translated by **Claude**.
9. `interim` and `transcript` events are pushed over the per-session
   **WebSocket** to every subscribed dashboard client.
10. `DELETE /sessions/:id` (or the meeting ending) makes the bot leave
    and the session reach state `ended`.

## Data flow — a recorded meeting

This path lives entirely in the dashboard; the bot-worker is not
involved.

1. `RecordingTranslator.tsx` uploads a file (or sends a URL) to
   `POST /api/transcribe`.
2. That route forwards the audio to Deepgram's **pre-recorded** API and
   returns diarized speaker segments.
3. The client translates each segment via `/api/translate` and renders
   a split original/translated transcript.

> Direct file upload is bounded by Vercel's ~4.5 MB serverless request
> limit. The upgrade path for large files is **client-direct upload to
> blob storage** (e.g. Vercel Blob), then transcribe via the URL path.

---

## Roadmap

| Phase | Scope | State |
| ----- | ----- | ----- |
| 0 | Live mic / system-audio translation in the dashboard | ✅ shipped |
| 1 | Recorded-file transcription + translation | ✅ shipped |
| 2 | Bot-worker MVP — Google Meet join + live transcript | 🛠 this scaffold |
| 3 | Dashboard ↔ bot-worker wiring — "paste a link" UI + live view | ⏭ next |
| 4 | Zoom + Microsoft Teams platform modules | 🔜 |
| 5 | Persistence (DB), session history, multi-bot scaling, auth | 🔜 |

### Phase 2 — what "done" means

- `docker compose up` runs the worker; `/healthz` responds.
- A `POST /sessions` with a real Meet link gets a bot into the call.
- The `TODO(selector)` locators in `googleMeet.ts` are verified live.
- Transcript events flow over the WebSocket end-to-end.

### Phase 3 — dashboard wiring

Add a "Translate a live meeting" entry point that calls the bot-worker
and a live view subscribing to the WebSocket. Reuses the existing
transcript components. Tracked as dashboard task #3.

---

## Scaling

The MVP runs **one bot per container** — a single PulseAudio sink means
one meeting at a time. To handle concurrent meetings:

- run **one container per meeting** (a machine pool; `POST /sessions`
  picks/boots a free machine), or
- give each bot its **own audio sink + ffmpeg + Chromium** within a
  container (more complex; bounded by CPU/RAM).

A machine-per-meeting model is the simplest correct answer and matches
how managed providers (e.g. Recall.ai) operate under the hood.

---

## Cost considerations

- **Always-on host** — the worker cannot scale to zero while a meeting
  runs (~$10–30+/mo per machine, more under load).
- **Deepgram** — streaming transcription billed per minute of audio.
- **Anthropic** — translation billed per token; the frozen,
  cache-controlled system prompt keeps repeated-meeting cost down.
- **Compute** — Chromium + the audio stack is memory-hungry; budget
  ~2 GB RAM per concurrent bot.

---

## Known risks

- **Selector drift** — Google Meet has no bot API. The join automation
  targets the live web UI and *will* break when Google changes it.
  This is ongoing maintenance, not a one-time cost.
- **Admission** — a guest bot needs a human to admit it; sign-in-only
  meetings need a logged-in bot account.
- **PulseAudio in containers** is fragile; silent transcripts almost
  always trace back to the audio stack.
- **No persistence yet** — a worker restart drops live sessions.
- **Terms of service** — automating meeting clients is a grey area on
  some platforms; review each platform's terms before production use.
