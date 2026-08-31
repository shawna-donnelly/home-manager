import ical from "node-ical";
import type { CalendarEvent } from "../events.js";
import type { CalendarSource, FetchWindow } from "./types.js";

export interface IcsSourceConfig {
  id: string;
  label: string;
  color: string;
  url: string;
}

export function createIcsSource(config: IcsSourceConfig): CalendarSource {
  return {
    id: config.id,
    label: config.label,
    color: config.color,

    async fetch(window: FetchWindow): Promise<CalendarEvent[]> {
      const parsed = await ical.async.fromURL(config.url);
      const out: CalendarEvent[] = [];

      for (const entry of Object.values(parsed)) {
        if (entry.type !== "VEVENT") continue;

        const allDay = isAllDay(entry);

        if (entry.rrule) {
          // Expand the rule across the window, then drop anything the calendar
          // explicitly excluded or overrode. node-ical exposes these as
          // `exdate` and `recurrences`, keyed by the original occurrence date.
          for (const occurrence of entry.rrule.between(window.from, window.to)) {
            const key = toDateKey(occurrence);

            if (entry.exdate?.[key]) continue;

            const override = entry.recurrences?.[key];
            if (override) {
              out.push(toEvent(config, override, override.start, isAllDay(override)));
              continue;
            }

            out.push(toEvent(config, entry, occurrence, allDay));
          }
          continue;
        }

        out.push(toEvent(config, entry, entry.start, allDay));
      }

      return out;
    },
  };
}

type VEvent = ical.VEvent;

function toEvent(
  config: IcsSourceConfig,
  source: VEvent,
  start: Date,
  allDay: boolean,
): CalendarEvent {
  const durationMs = source.end.getTime() - source.start.getTime();
  const end = new Date(start.getTime() + durationMs);

  return {
    id: `${config.id}:${source.uid}:${start.toISOString()}`,
    sourceId: config.id,
    sourceLabel: config.label,
    color: config.color,
    title: source.summary ?? "(untitled)",
    ...(source.location ? { location: source.location } : {}),
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
  };
}

/**
 * All-day events use DATE rather than DATE-TIME, which node-ical surfaces as
 * `dateOnly`. Older feeds omit it, so fall back to detecting a midnight start
 * with a whole number of days duration.
 */
function isAllDay(event: VEvent): boolean {
  if ((event.start as { dateOnly?: boolean }).dateOnly) return true;
  const durationMs = event.end.getTime() - event.start.getTime();
  return (
    event.start.getHours() === 0 &&
    event.start.getMinutes() === 0 &&
    durationMs % 86_400_000 === 0 &&
    durationMs > 0
  );
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
