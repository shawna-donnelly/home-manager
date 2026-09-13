#!/bin/sh
# Wall kiosk: keep Chromium up. Respawns if it crashes OR is killed, so a
# deploy can reload the page with a plain `pkill -f 'chromium --kiosk'`.
# Launched from labwc autostart (inherits the Wayland session); the env
# fallbacks let it also be started over SSH.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
URL="${KIOSK_URL:-http://localhost:8080}"
while true; do
  chromium \
    --kiosk \
    --ozone-platform=wayland \
    --enable-features=UseOzonePlatform \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=Translate \
    --password-store=basic \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required \
    "$URL" >/tmp/kiosk.log 2>&1
  # Killed for a reload, or crashed — pause briefly and come back.
  sleep 2
done
