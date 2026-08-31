# home-manager

Wall-mounted family display running on a Raspberry Pi 5. Chromium in kiosk mode
pointed at a local React app, backed by a Node service that owns all credentials
and outbound integrations.

## Layout

```
server/   Fastify + TS. Polls sources, normalizes, caches, serves JSON + SSE.
web/      Vite + React + TS. Static build, served by the server.
deploy/   systemd units and Pi kiosk configuration.
```

Two independent packages, no workspace tooling. One deployment target, one
developer — a monorepo here would be overhead with no payoff.

## Architecture decisions

**The Pi serves everything locally.** The browser talks to `localhost`, never
the internet. If the network drops, the display keeps rendering cached data
instead of showing a connection error on the kitchen wall.

**The server owns every credential.** OAuth tokens, router API keys, and
anything else live server-side and never reach the browser. The web app is a
pure render target.

**Sources are adapters behind one interface.** `CalendarSource` and
`SensorSource` in `server/src/sources/types.ts` are the contracts. ICS and
Home Assistant are implemented; Google Calendar API, iCloud CalDAV, and other
non-calendar sources (network controls, location) slot in behind the same
shapes.

**Home Assistant is the sensor hub, not this server.** Apple's HomeKit
framework (`HMHomeManager`) only runs on Apple platforms, so the Pi can't
speak to Apple Home directly. Instead HA owns all device pairing — Zigbee via
a USB coordinator, HomeKit-compatible accessories via its HomeKit Controller
integration, Matter via its Matter server — and this server reads HA's REST
API as one more polled source (`HA_URL`/`HA_TOKEN`/`HA_ENTITIES` in `.env`).
Devices paired to HA can be re-exposed to Apple Home via HA's "HomeKit
Bridge" integration, so the wall display and the Home app see the same
sensors.

**The family map rides the same hub.** Apple has no public API for Find My, so
family locations come from the Home Assistant companion app on each phone: the
app reports location to HA, HA maintains one `person.*` entity per family
member, and this server reads those entities alongside the sensors
(`HA_PEOPLE` in `.env`; unset shows everyone HA knows). The 🗺️ tab appears
automatically once locations arrive, rendered with Leaflet on OpenStreetMap
tiles. Each person needs an HA user account with the companion app signed in
and location sending enabled — no Apple credentials anywhere.

**Last-known-good is written to disk.** Every successful poll persists to
`CACHE_DIR`. On boot the server serves cache immediately and refreshes in the
background, so a cold start after a power cut shows real data in under a second.

**Push, not poll, to the browser.** The client opens an SSE stream and receives
snapshots. No polling loop in the page, no stale-tab problem.

## Non-obvious constraints

Discovered before writing any code; documenting so they don't get relearned.

- Current Raspberry Pi OS uses **labwc** (Wayland), not X11. `xset`, `unclutter`,
  and `~/.config/lxsession/` do nothing. See `deploy/README.md`.
- The Pi 5's USB-C port is **power input only** — no DisplayPort Alt Mode. Video
  must go over micro-HDMI regardless of what the display supports.
- Google's secret ICS feeds are cached hard on Google's side and can lag by
  hours. Fine for a week view, not for "I just added this." Move to the
  Calendar API when that starts mattering.
- OAuth refresh tokens issued while a Google Cloud project is in **Testing**
  publishing status expire after 7 days. Publish to Production first.
- microSD wear is the expected long-term failure mode for a 24/7 appliance.
  `/var/log` on tmpfs, swap off, and plan for NVMe.
- **HA OS wants the whole machine.** This Pi already runs the kiosk and this
  server, so install HA as a Docker container (`ghcr.io/home-assistant/home-assistant`
  with `--network=host` and a device mapping for the Zigbee dongle), not as
  Home Assistant OS.
- **A HomeKit accessory pairs to one controller.** Pairing a sensor to HA's
  HomeKit Controller integration means removing it from Apple Home first. The
  way to have both is to pair devices to HA and re-share them to Apple via
  HA's HomeKit Bridge — or buy Matter-over-Thread devices, which support
  multi-admin. Prefer Zigbee for cheap sensors anyway; it sidesteps all of this.
- **Zigbee dongles hate USB 3.** Plug the coordinator into a USB 2 port on a
  short extension cable, away from the Pi and its SSD — USB 3 ports radiate
  exactly in the 2.4 GHz band Zigbee uses.

## Sensor hardware plan

Starting from zero, this is the shopping list that fits the architecture:

- **Coordinator:** Sonoff ZBDongle-E (~$25) — well supported by HA's ZHA
  integration; plus a 0.5 m USB 2 extension cable.
- **Sensors:** Aqara or Sonoff Zigbee temperature/humidity, door/window, and
  motion sensors (~$10–20 each). Battery-powered, years of life, no Wi-Fi
  credentials on any device.
- **Optional Apple side:** once devices live in HA, enable the HomeKit Bridge
  integration and the whole set shows up in the Home app with no extra
  hardware. An Apple TV/HomePod is only needed if you later want
  Thread/Matter devices or Home automations.

## Setup

Both packages use Yarn. The root `.yarnrc.yml` pins the `node-modules`
linker — Yarn's Plug'n'Play default breaks editor TypeScript servers and
running `node dist/index.js` directly, and nothing here needs it.

```bash
cd server && yarn install && cp .env.example .env   # add calendar URLs
cd ../web  && yarn install
```

Development — one command runs both watchers (Ctrl-C stops both):

```bash
./dev.sh
```

Open <http://localhost:5173> while developing — that's the hot-reloading
page (it proxies `/api` to the server). The server restarts itself on `src/`
or `.env` changes (nodemon); the page picks up web changes instantly (Vite)
and reconnects to a restarted server on its own (SSE backoff). Plain `:8080`
serves the last `yarn build` output — production behavior, no reload.

The watchers can also run separately: `cd server && yarn dev` and
`cd web && yarn dev`.

Production on the Pi:

```bash
cd web && yarn build         # emits web/dist
cd ../server && yarn build && yarn start
```

### Google Calendar API setup (one-time)

The API source is near-real-time and sees calendars shared with you — both
things the secret-ICS feeds can't do. Setup:

1. [console.cloud.google.com](https://console.cloud.google.com) → new project
   (any name).
2. **APIs & Services > Library** → enable **Google Calendar API**.
3. **APIs & Services > OAuth consent screen** → External → fill in the two
   required fields → and once created, **publish to Production** (in Testing
   status, refresh tokens die after 7 days — see constraints below).
4. **APIs & Services > Credentials > Create credentials > OAuth client ID** →
   type **Desktop app**. Copy the client id and secret into `.env` as
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
5. On a machine with a browser: `cd server && yarn auth:google`. Open the
   printed URL, approve (click through the "unverified app" warning via
   Advanced — it's your own app), and the script prints the
   `GOOGLE_REFRESH_TOKEN` line plus every calendar id on the account.
6. Add the token and one `GCAL_*` line per calendar to `.env`, restart.

## Roadmap

Phase 1 is the whole point: prove the Pi boots reliably into a full-screen page
that survives a power cut, before any feature work.

- [ ] Pi boots to kiosk in under 60s, screen never blanks, survives power cut
- [ ] ICS sources rendering a real week view
- [ ] Multi-calendar with per-person color
- [x] Google Calendar API, read side (near-real-time, shared calendars)
- [ ] Google Calendar API write-back (add events from the display)
- [x] Sensor pipeline: `SensorSource` adapter, Home Assistant backend, sensor
      strip on the display
- [ ] Zigbee hardware paired into HA (dongle + first sensors)
- [ ] HA WebSocket subscription instead of polling (instant motion/door updates)
- [x] Chores per kid + parents' to-do (tabs; JSON store in `DATA_DIR`, synced
      to every display over the same SSE stream)
- [x] Email notifications: chore deletions immediately, unfinished chores
      daily at `CHORE_REPORT_TIME` (SMTP config in `.env`)
- [ ] Network controls adapter
- [ ] Location adapter
