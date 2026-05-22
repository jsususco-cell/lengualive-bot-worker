#!/usr/bin/env bash
# ─── Container boot script ───────────────────────────────────────
# Brings up the virtual audio + display stack the bot needs, then
# hands off to the Node worker.
#
# NOTE: running PulseAudio inside a container (as root) is genuinely
# finicky. This script uses the most common working recipe; if audio
# capture comes up silent, this is the first place to debug. See the
# "Audio stack" section of README.md.
set -e

AUDIO_SINK="${AUDIO_SINK:-meet_sink}"

# A D-Bus session — PulseAudio and Chromium both expect one.
export $(dbus-launch)

# Start PulseAudio as a normal user-mode daemon that never exits idle.
pulseaudio --start --exit-idle-time=-1 --disallow-exit --log-target=stderr || true

# Give it a moment to come up.
sleep 1

# Create the virtual sink the bot's Chromium will render audio into,
# and make it the default so all browser audio lands there.
pactl load-module module-null-sink \
  sink_name="${AUDIO_SINK}" \
  sink_properties=device.description="${AUDIO_SINK}"
pactl set-default-sink "${AUDIO_SINK}"

# A virtual X display so Chromium can run "headed" (Meet detects and
# behaves differently under true headless; a virtual display avoids that).
Xvfb :99 -screen 0 1280x720x24 -ac >/dev/null 2>&1 &
export DISPLAY=:99

# Hand off to the worker (exec so it receives signals as PID 1's child).
exec node dist/index.js
