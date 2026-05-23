# LenguaLive bot-worker

The companion backend for **LenguaLive** that the Vercel dashboard
cannot be: a long-running, Dockerized service that sends a bot into a
live video meeting, captures the meeting audio, and transcribes +
translates it in real time.

Today it supports **Google Meet** and **Microsoft Teams** (anonymous
guest join — sign-in support is a roadmap item). Zoom is designed for
but not yet implemented (see `src/platforms/`).

---

## Why this is a separate service

The LenguaLive dashboard is a Next.js app on Vercel. Vercel runs
**serverless functions** — they live for seconds, not hours. A meeting
bot has to stay connected for the entire call, hold a headless browser
open, and run a virtual audio device. None of that fits serverless. So
the bot lives here, in a container you host yourself, and the dashboard
talks to it over an HTTP + WebSocket API.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full picture.

---

## How it works

```
 meeting URL
     │
     ▼
 Playwright Chromium ──(plays audio)──▶ PulseAudio null sink
 (joins as a guest)                          │
                                             ▼
                              ffmpeg captures sink.monitor
                                             │  16 kHz mono PCM
                                             ▼
                              Deepgram live  ──▶ diarized transcript
                                             │
                                             ▼
                                  Claude translates each turn
                                             │
                                             ▼
                          WebSocket ──▶ the LenguaLive dashboard
```

---

## API

All routes except `/healthz` require `Authorization: Bearer <WORKER_API_TOKEN>`.

| Method   | Route                          | Purpose                                   |
| -------- | ------------------------------ | ----------------------------------------- |
| `POST`   | `/sessions`                    | Start a bot. Body: `{ meetingUrl, sourceLang, targetLang, botName? }` |
| `GET`    | `/sessions`                    | List all sessions                         |
| `GET`    | `/sessions/:id`                | One session's status                      |
| `DELETE` | `/sessions/:id`                | Make the bot leave the meeting            |
| `WS`     | `/sessions/:id/stream?token=…` | Live event stream (see below)             |
| `GET`    | `/healthz`                     | Liveness probe (no auth)                  |

**WebSocket events** (`SessionEvent` in `src/types.ts`):

```jsonc
{ "type": "state",      "state": "live" }
{ "type": "interim",    "text": "...", "speaker": 0 }
{ "type": "transcript", "original": "...", "translated": "...", "speaker": 0, "ts": "..." }
{ "type": "error",      "message": "..." }
```

---

## Environment

Copy `.env.example` to `.env` and fill it in:

| Variable           | Required | Notes                                            |
| ------------------ | -------- | ------------------------------------------------ |
| `WORKER_API_TOKEN` | yes      | Shared secret the dashboard must send            |
| `DEEPGRAM_API_KEY` | yes      | Master key — server-side, no token grant needed  |
| `ANTHROPIC_API_KEY`| yes      | Translation                                      |
| `TRANSLATION_MODEL`| no       | Default `claude-haiku-4-5`                       |
| `PORT`             | no       | Default `8080`                                   |
| `BOT_DISPLAY_NAME` | no       | Name shown in the meeting roster                 |
| `AUDIO_SINK`       | no       | Must match the sink in `docker/entrypoint.sh`    |

---

## Run it

This service **must run in Docker** — it needs Linux, a virtual X
display, PulseAudio, and ffmpeg. It cannot run directly on Windows or
macOS.

```bash
cp .env.example .env      # then fill in the keys
docker compose up --build
```

Verify it's alive:

```bash
curl localhost:8080/healthz          # → {"ok":true}
```

Start a bot:

```bash
curl -X POST localhost:8080/sessions \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"meetingUrl":"https://meet.google.com/abc-defg-hij","sourceLang":"en","targetLang":"fil"}'
```

## Deploy to Fly.io

```bash
fly launch --no-deploy        # creates the app from fly.toml
fly secrets set \
  WORKER_API_TOKEN=... \
  DEEPGRAM_API_KEY=... \
  ANTHROPIC_API_KEY=...
fly deploy
```

---

## Status & limitations

This is an **MVP scaffold**. Honest list of what to expect:

- **Selectors are fragile.** Google Meet has no bot API; the join flow
  in `src/platforms/googleMeet.ts` automates the real web UI. Every
  selector marked `TODO(selector)` must be verified against the live
  page and will need maintenance whenever Google changes Meet.
- **The host must admit the bot.** A guest bot lands in the waiting
  room; if nobody admits it within 2 minutes the session errors out.
- **Sign-in-only meetings won't work** with guest join. Supporting
  those needs a logged-in Google account for the bot (a future option).
- **One bot per container.** There is a single PulseAudio sink, so one
  meeting at a time per machine. Concurrency = more machines.
- **State is in-memory.** A restart drops all sessions. Persistence is
  a roadmap item.
- **PulseAudio in Docker is finicky.** If transcripts stay empty, the
  audio stack in `docker/entrypoint.sh` is the first thing to debug.

## Next steps to a working bot

1. `docker compose up --build` and confirm `/healthz`.
2. `POST /sessions` with a real Google Meet link; watch the logs.
3. Have someone admit the bot; verify `state` reaches `live`.
4. If the join stalls, run Chromium non-headless locally and fix the
   `TODO(selector)` locators against the current Meet DOM.
5. Confirm transcripts arrive on the WebSocket — if not, debug the
   PulseAudio sink / ffmpeg capture.
6. Then wire the dashboard to this API (dashboard task #3).
