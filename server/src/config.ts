import type { EmailConfig } from "./notify.js";
import {
  createGoogleAuth,
  createGoogleCalendarSource,
} from "./sources/googlecalendar.js";
import { createHomeAssistantSource } from "./sources/homeassistant.js";
import { createIcsSource } from "./sources/ics.js";
import type { CalendarSource, SensorSource } from "./sources/types.js";

export const PORT = Number(process.env.PORT ?? 8080);
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 300_000);
export const CACHE_DIR = process.env.CACHE_DIR ?? "./.cache";
/** Chores/todos live here — real data, not a rebuildable cache. */
export const DATA_DIR = process.env.DATA_DIR ?? "./.data";

const names = (raw: string | undefined) =>
  (raw ?? "").split(",").map((n) => n.trim()).filter(Boolean);

/** Kid names for the chore chart; empty hides the Chores tab entirely. */
export const KIDS = names(process.env.KIDS);
/** Shown on the To-Do tab heading. */
export const PARENTS = names(process.env.PARENTS);

/**
 * Required (as an X-Pin header) to delete a chore, so kids can't quietly
 * remove "Clean room" from the chart. Empty disables the check.
 */
export const CHORE_PIN = process.env.CHORE_PIN ?? "";

/** Local HH:MM when the unfinished-chores email goes out. */
export const CHORE_REPORT_TIME = process.env.CHORE_REPORT_TIME ?? "20:00";

/** What a perfect chore week can be redeemed for. */
export const REWARDS = (() => {
  const list = names(process.env.REWARDS);
  return list.length > 0 ? list : ["Cash", "Robux"];
})();

/**
 * SMTP for notification emails. All four required to enable; for Gmail use
 * smtp.gmail.com:465 with an app password (regular passwords won't work).
 */
export function loadEmailConfig(): EmailConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.NOTIFY_EMAIL;
  if (!host || !user || !pass || !to) {
    if (host || user || pass || to) {
      console.warn(
        "[config] email disabled: need all of SMTP_HOST, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL",
      );
    }
    return null;
  }
  return { host, port: Number(process.env.SMTP_PORT ?? 465), user, pass, to };
}

/**
 * How far around today sources fetch. The display can page ±4/+8 weeks, so
 * the window must cover at least that. Cheap; widen if the UI needs more.
 */
export const WINDOW_DAYS_BACK = 28;
export const WINDOW_DAYS_FORWARD = 60;

/**
 * Sources come from env vars so credentials and feed URLs stay out of the
 * repo. `CALENDAR_*` are ICS feeds (`label|color|url`); `GCAL_*` are Google
 * Calendar API calendars (`label|color|calendarId`). Colors go without the
 * leading `#` — node's --env-file parser treats an unquoted `#` as an inline
 * comment and silently truncates the value.
 */
export function loadSources(): CalendarSource[] {
  return [...loadIcsSources(), ...loadGoogleSources()];
}

function parseSourceVars(
  prefix: string,
): { key: string; label: string; color: string; third: string }[] {
  return Object.entries(process.env)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, raw]) => {
      const parts = raw?.split("|") ?? [];
      if (parts.length !== 3) {
        console.warn(`[config] skipping ${key}: expected three |-separated parts`);
        return [];
      }
      const [label, rawColor, third] = parts as [string, string, string];
      const color = rawColor.startsWith("#") ? rawColor : `#${rawColor}`;
      return [{ key: key.toLowerCase(), label, color, third }];
    });
}

function loadIcsSources(): CalendarSource[] {
  return parseSourceVars("CALENDAR_").map(({ key, label, color, third }) =>
    createIcsSource({ id: key, label, color, url: third }),
  );
}

/**
 * Google Calendar API sources: near-real-time, and they see shared calendars,
 * unlike the secret-ICS feeds Google caches for hours. One refresh token
 * (from `yarn auth:google`) covers every GCAL_* calendar on the account.
 */
function loadGoogleSources(): CalendarSource[] {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const vars = parseSourceVars("GCAL_");

  if (!clientId || !clientSecret || !refreshToken) {
    if (vars.length > 0) {
      console.warn(
        "[config] GCAL_* set but GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/" +
          "GOOGLE_REFRESH_TOKEN incomplete; skipping google calendars",
      );
    }
    return [];
  }

  const auth = createGoogleAuth({ clientId, clientSecret, refreshToken });
  return vars.map(({ key, label, color, third }) =>
    createGoogleCalendarSource({ id: key, label, color, calendarId: third, auth }),
  );
}

/**
 * Home Assistant is the sensor hub: it owns pairing (Zigbee, HomeKit, Matter)
 * and this server just reads its state API. Unset HA_URL/HA_TOKEN means no
 * sensor sources — the display simply doesn't render a sensor strip.
 */
export function loadSensorSources(): SensorSource[] {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) return [];

  const entities = (process.env.HA_ENTITIES ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  return [
    createHomeAssistantSource({
      id: "homeassistant",
      label: "Home Assistant",
      url,
      token,
      entities,
    }),
  ];
}
