# ─── LenguaLive bot-worker image ─────────────────────────────────
# A long-running container that drives a headless-ish Chromium into a
# meeting and captures its audio. This is the piece Vercel cannot host:
# it needs a persistent process, a virtual display, and a virtual
# audio device. Deploy it to Fly.io / Railway / Render / a VPS.

FROM node:20-bookworm

# System dependencies:
#   xvfb       — virtual X display (Google Meet is happier non-headless)
#   pulseaudio — virtual audio: the bot's Chromium plays into a null sink
#   ffmpeg     — captures the sink's monitor and re-encodes to PCM
#   dbus-x11   — PulseAudio/Chromium expect a D-Bus session
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      pulseaudio \
      pulseaudio-utils \
      ffmpeg \
      dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies first for better layer caching.
COPY package*.json ./
RUN npm install

# Install Chromium and the rest of its system libraries for Playwright.
RUN npx playwright install --with-deps chromium

# Build the TypeScript source.
COPY . .
RUN npm run build

# Boot script: starts PulseAudio + Xvfb, then launches the worker.
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
