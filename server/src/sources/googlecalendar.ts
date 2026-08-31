import type { CalendarEvent } from "../events.js";
import type { CalendarSource, FetchWindow, NewEventInput } from "./types.js";

/**
 * OAuth token provider shared by every Google calendar source — one refresh
 * token covers the whole account, so refreshing once serves all of them.
 */
export interface GoogleAuth {
  accessToken(): Promise<string>;
}

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Overridable for tests. */
  tokenUrl?: string;
}

export function createGoogleAuth(config: GoogleAuthConfig): GoogleAuth {
  const tokenUrl = config.tokenUrl ?? "https://oauth2.googleapis.com/token";
  let cached: { value: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  return {
    async accessToken(): Promise<string> {
      // 60s of slack so a token never expires mid-request.
      if (cached && Date.now() < cached.expiresAt - 60_000) return cached.value;

      // Sources fetch in parallel; only one refresh should go out.
      inflight ??= (async () => {
        const response = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: config.refreshToken,
            grant_type: "refresh_token",
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Error(`google token refresh returned ${response.status}`);
        }
        const body = (await response.json()) as {
          access_token: string;
          expires_in: number;
        };
        cached = {
          value: body.access_token,
          expiresAt: Date.now() + body.expires_in * 1000,
        };
        return cached.value;
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

export interface GoogleCalendarConfig {
  id: string;
  label: string;
  color: string;
  /** Calendar id from the calendar list — an email-ish id, or "primary". */
  calendarId: string;
  auth: GoogleAuth;
  /** Overridable for tests. */
  apiBase?: string;
}

interface GoogleEventsResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  /** Timed events carry dateTime; all-day events carry date (end exclusive). */
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export function createGoogleCalendarSource(
  config: GoogleCalendarConfig,
): CalendarSource {
  const apiBase = config.apiBase ?? "https://www.googleapis.com/calendar/v3";

  return {
    id: config.id,
    label: config.label,
    color: config.color,

    async fetch(window: FetchWindow): Promise<CalendarEvent[]> {
      const token = await config.auth.accessToken();
      const out: CalendarEvent[] = [];
      let pageToken: string | undefined;

      do {
        // singleEvents expands recurrences server-side — no RRULE handling here.
        const params = new URLSearchParams({
          singleEvents: "true",
          timeMin: window.from.toISOString(),
          timeMax: window.to.toISOString(),
          maxResults: "2500",
        });
        if (pageToken) params.set("pageToken", pageToken);

        const response = await fetch(
          `${apiBase}/calendars/${encodeURIComponent(config.calendarId)}/events?${params}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok) {
          throw new Error(`google calendar returned ${response.status}`);
        }
        const body = (await response.json()) as GoogleEventsResponse;

        for (const item of body.items ?? []) {
          if (item.status === "cancelled") continue;
          const event = toEvent(config, item);
          if (event) out.push(event);
        }
        pageToken = body.nextPageToken;
      } while (pageToken);

      return out;
    },

    async createEvent(input: NewEventInput): Promise<void> {
      const token = await config.auth.accessToken();
      const timed = (dateTime: string) => ({
        dateTime,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      });
      const body = {
        summary: input.title,
        start: input.allDay ? { date: input.start } : timed(input.start),
        end: input.allDay ? { date: input.end } : timed(input.end),
      };
      const response = await fetch(
        `${apiBase}/calendars/${encodeURIComponent(config.calendarId)}/events`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        // 403 is the read-only-scope token; make that failure self-explaining.
        throw new Error(
          response.status === 403
            ? "google refused the write (403) — re-run `yarn auth:google` to grant write access"
            : `google calendar create returned ${response.status}`,
        );
      }
    },
  };
}

function toEvent(
  config: GoogleCalendarConfig,
  item: GoogleEvent,
): CalendarEvent | null {
  const allDay = Boolean(item.start?.date);
  const start = allDay
    ? localMidnight(item.start?.date)
    : parseIso(item.start?.dateTime);
  const end = allDay
    ? localMidnight(item.end?.date)
    : parseIso(item.end?.dateTime);
  if (!start || !end) return null;

  return {
    // Recurrence instances get suffixed ids from Google, so this stays unique.
    id: `${config.id}:${item.id}`,
    sourceId: config.id,
    sourceLabel: config.label,
    color: config.color,
    title: item.summary ?? "(untitled)",
    ...(item.location ? { location: item.location } : {}),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
  };
}

/** "2026-08-30" as local midnight, matching the ICS source's all-day handling. */
function localMidnight(date: string | undefined): Date | null {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function parseIso(dateTime: string | undefined): Date | null {
  if (!dateTime) return null;
  const parsed = new Date(dateTime);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
