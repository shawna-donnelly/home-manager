import type {
  ForecastDay,
  PersonLocation,
  SensorReading,
} from "./readings.js";

/**
 * The single event shape every source normalizes into. Adding a source means
 * writing a mapper to this type, never widening it with source-specific fields.
 */
export interface CalendarEvent {
  /** Stable across polls. `${sourceId}:${uid}:${startISO}` for recurrences. */
  id: string;
  sourceId: string;
  /** Display label for the calendar this came from. */
  sourceLabel: string;
  /** Hex, assigned per source in config. */
  color: string;
  title: string;
  location?: string;
  /** Always UTC ISO. All-day events are midnight-to-midnight in local time. */
  start: string;
  end: string;
  allDay: boolean;
}

export interface Snapshot {
  events: CalendarEvent[];
  sensors: SensorReading[];
  /** Family members on the map, from person-tracking sensor sources. */
  locations: PersonLocation[];
  /** Daily forecast for the calendar, keyed by local date. */
  forecast: ForecastDay[];
  /** When the data was last successfully refreshed. */
  fetchedAt: string;
  /** Sources (calendar or sensor) that failed on the most recent poll, by id. */
  degraded: string[];
}

export function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    // All-day events sort above timed events starting at the same instant.
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * Events overlapping [from, to). Half-open on purpose: an event ending exactly
 * at midnight belongs to the day that just closed, not the one starting.
 */
export function inRange(
  events: CalendarEvent[],
  from: Date,
  to: Date,
): CalendarEvent[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return events.filter((e) => {
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    return start < toMs && end > fromMs;
  });
}
