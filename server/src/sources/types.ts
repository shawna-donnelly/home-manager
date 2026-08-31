import type { CalendarEvent } from "../events.js";
import type {
  ForecastDay,
  PersonLocation,
  SensorReading,
} from "../readings.js";

/**
 * Every calendar backend implements this. Google Calendar API, iCloud CalDAV,
 * and school sports feeds all become one file each behind this interface.
 *
 * `fetch` is expected to throw on failure. The poller catches, marks the source
 * degraded, and keeps serving that source's last-known-good events — one broken
 * feed must never blank the wall display.
 */
export interface CalendarSource {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  fetch(window: FetchWindow): Promise<CalendarEvent[]>;
  /**
   * Present only on backends that can write (Google API). Absent means
   * read-only (ICS) — the UI offers only writable calendars when adding.
   * Throws on failure; the caller surfaces the error, nothing is retried.
   */
  createEvent?(input: NewEventInput): Promise<void>;
}

/**
 * For all-day events, start/end are `YYYY-MM-DD` with end exclusive (Google's
 * own convention). Timed events are wall-clock datetimes with no offset
 * (`YYYY-MM-DDTHH:mm:ss`) plus an IANA timeZone — explicit, so a calendar
 * whose own timezone is misconfigured (a kid's account left on UTC) can't
 * shift the event.
 */
export interface NewEventInput {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  timeZone?: string;
}

export interface FetchWindow {
  from: Date;
  to: Date;
}

/**
 * Every sensor backend implements this. Home Assistant is implemented; MQTT,
 * a Matter controller, or an Apple-side bridge would each be one file behind
 * the same shape. Same failure contract as `CalendarSource`: throw on failure,
 * the poller keeps serving last-known-good readings.
 */
export interface SensorSource {
  readonly id: string;
  readonly label: string;
  fetch(): Promise<SensorReading[]>;
  /**
   * Present on backends that also track people (Home Assistant person
   * entities). Same failure contract as `fetch`.
   */
  fetchLocations?(): Promise<PersonLocation[]>;
  /**
   * Present on backends with a weather entity configured. Same failure
   * contract as `fetch`.
   */
  fetchForecast?(): Promise<ForecastDay[]>;
}
