#!/bin/sh
# One-shot deploy on the Pi: pull, build, restart services, reload the kiosk.
#   ssh home@<pi> 'home-manager/deploy/deploy.sh'
set -e
cd "$(dirname "$0")/.."
echo "› pulling"; git pull -q
echo "› building server"; ( cd server && yarn build >/dev/null )
echo "› building web";    ( cd web && yarn build >/dev/null )
echo "› building mcp";    ( cd mcp && yarn build >/dev/null )
echo "› restarting services"
sudo systemctl restart home-manager
sudo systemctl restart home-manager-mcp
echo "› reloading kiosk"
pkill -f 'chromium --kiosk' 2>/dev/null || true   # kiosk.sh loop respawns it
sleep 4
echo "done: app=$(systemctl is-active home-manager) mcp=$(systemctl is-active home-manager-mcp) kiosk=$(pgrep -c chromium 2>/dev/null || echo 0)procs"
