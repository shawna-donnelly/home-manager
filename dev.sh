#!/usr/bin/env bash
# Development: run the server (:8080) and web (:5173) watchers together.
# Server restarts on src/ or .env changes; the web page hot-reloads.
# Ctrl-C stops both. Open http://localhost:5173 while developing.
set -euo pipefail
cd "$(dirname "$0")"

trap 'kill 0' EXIT
(cd server && yarn dev) &
(cd web && yarn dev) &
wait
