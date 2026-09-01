import { useEffect, useState } from "react";
import AddEvent, { type SourceInfo } from "./AddEvent";
import MapView from "./MapView";
import Meals from "./Meals";
import { ChoreChart, TodoList } from "./Tasks";
import {
  useEvents,
  useNow,
  type CalendarEvent,
  type ForecastDay,
  type SensorReading,
} from "./useEvents";

const DAYS_SHOWN = 7;

/** Paging bounds, in weeks. Must stay inside the server's fetch window. */
const MIN_WEEK = -4;
const MAX_WEEK = 8;

/** A browsed-away display returns to today on its own — it's a wall, not a tab. */
const RETURN_TO_TODAY_MS = 5 * 60_000;

type Tab = "calendar" | "chores" | "todo" | "meals" | "map";

/**
 * Deliberately plain. This exists to prove the data path end to end — feeds
 * parse, SSE delivers, the browser renders, and it all survives a reboot.
 * The real layout work happens against the actual panel at its actual
 * resolution, not against a guess.
 */
export default function App() {
  const { snapshot, connection } = useEvents();
  const now = useNow();
  const [weekOffset, setWeekOffset] = useState(0);

  const tasks = snapshot?.tasks;
  const [tab, setTab] = useState<Tab>("calendar");
  // Same kiosk rule as week paging: drift back to the calendar when idle.
  useEffect(() => {
    if (tab === "calendar") return;
    const timer = window.setTimeout(() => setTab("calendar"), RETURN_TO_TODAY_MS);
    return () => window.clearTimeout(timer);
  }, [tab]);

  const page = (delta: number) =>
    setWeekOffset((w) => Math.min(MAX_WEEK, Math.max(MIN_WEEK, w + delta)));

  // Snap back to today after a stretch with no navigation.
  useEffect(() => {
    if (weekOffset === 0) return;
    const timer = window.setTimeout(() => setWeekOffset(0), RETURN_TO_TODAY_MS);
    return () => window.clearTimeout(timer);
  }, [weekOffset]);

  // Arrow keys for a keyboard, mostly during development. Ignored while a
  // text field has focus or another tab is showing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== "calendar") return;
      if (e.target instanceof HTMLElement && e.target.closest("input, select"))
        return;
      if (e.key === "ArrowLeft") page(-1);
      if (e.key === "ArrowRight") page(1);
      if (e.key === "Home") setWeekOffset(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  const days = buildDays(now, DAYS_SHOWN, weekOffset * DAYS_SHOWN);
  const sensors = snapshot?.sensors ?? [];
  const locations = snapshot?.locations ?? [];
  const forecast = snapshot?.forecast ?? [];

  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [addingDay, setAddingDay] = useState<Date | null>(null);
  useEffect(() => {
    fetch("/api/sources")
      .then((r) => (r.ok ? (r.json() as Promise<SourceInfo[]>) : []))
      .then(setSources)
      .catch(() => {
        // No sources list just means no add buttons; the display still works.
      });
  }, []);
  const writable = sources.filter((s) => s.writable);

  return (
    <main className="wall">
      <header className="wall__header">
        <h1 className="wall__date">
          {now.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </h1>
        <nav className="nav" aria-label="Sections">
          <button
            type="button"
            className={`nav__button tab${tab === "calendar" ? " tab--active" : ""}`}
            onClick={() => setTab("calendar")}
          >
            📅 Calendar
          </button>
          {tasks && tasks.kids.length > 0 && (
            <button
              type="button"
              className={`nav__button tab${tab === "chores" ? " tab--active" : ""}`}
              onClick={() => setTab("chores")}
            >
              🧹 Chores
            </button>
          )}
          {tasks && (
            <button
              type="button"
              className={`nav__button tab${tab === "todo" ? " tab--active" : ""}`}
              onClick={() => setTab("todo")}
            >
              📝 To-Do
            </button>
          )}
          {snapshot?.meals && (
            <button
              type="button"
              className={`nav__button tab${tab === "meals" ? " tab--active" : ""}`}
              onClick={() => setTab("meals")}
            >
              🍽️ Meals
            </button>
          )}
          {locations.length > 0 && (
            <button
              type="button"
              className={`nav__button tab${tab === "map" ? " tab--active" : ""}`}
              onClick={() => setTab("map")}
            >
              🗺️ Map
            </button>
          )}
        </nav>
        <p className="wall__clock">
          {now.toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
        </p>
      </header>

      {connection !== "live" && (
        <p className="wall__status" role="status">
          {connection === "connecting"
            ? "Connecting"
            : "Reconnecting — showing saved schedule"}
        </p>
      )}

      {snapshot && snapshot.degraded.length > 0 && (
        <p className="wall__status" role="status">
          {snapshot.degraded.length} source
          {snapshot.degraded.length === 1 ? "" : "s"} out of date
        </p>
      )}

      {sensors.length > 0 && (
        <ul className="sensors">
          {sensors.map((reading) => (
            <li
              key={reading.id}
              className={`sensor${reading.stale ? " sensor--stale" : ""}`}
            >
              <span className="sensor__label">{reading.label}</span>
              <span className="sensor__value">{formatReading(reading)}</span>
            </li>
          ))}
        </ul>
      )}

      {tab === "chores" && tasks && <ChoreChart tasks={tasks} />}
      {tab === "todo" && tasks && <TodoList tasks={tasks} />}
      {tab === "meals" && snapshot?.meals && (
        <Meals view={snapshot.meals} now={now} />
      )}
      {tab === "map" && locations.length > 0 && (
        <MapView locations={locations} now={now} />
      )}

      {tab === "calendar" && (
        <>
      <nav className="nav nav--week" aria-label="Calendar week">
        <button
          type="button"
          className="nav__button"
          onClick={() => page(-1)}
          disabled={weekOffset <= MIN_WEEK}
          aria-label="Previous week"
        >
          ‹
        </button>
        {weekOffset !== 0 && (
          <button
            type="button"
            className="nav__button nav__today"
            onClick={() => setWeekOffset(0)}
          >
            {formatRange(days)} · Today
          </button>
        )}
        <button
          type="button"
          className="nav__button"
          onClick={() => page(1)}
          disabled={weekOffset >= MAX_WEEK}
          aria-label="Next week"
        >
          ›
        </button>
      </nav>

      <div className="week">
        {days.map((day) => (
          <section
            key={day.toISOString()}
            className={`day${isSameDay(day, now) ? " day--today" : ""}`}
          >
            <h2 className="day__label">
              <span className="day__name">
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span className="day__right">
                {writable.length > 0 && (
                  <button
                    type="button"
                    className="day__add"
                    onClick={() => setAddingDay(day)}
                    aria-label={`Add event on ${day.toDateString()}`}
                  >
                    +
                  </button>
                )}
                <span className="day__number">{day.getDate()}</span>
              </span>
            </h2>
            <Weather day={forecastFor(forecast, day)} />
            <ul className="day__events">
              {eventsForDay(snapshot?.events ?? [], day).map((event) => (
                <li
                  key={event.id}
                  className="event"
                  style={{ borderInlineStartColor: event.color }}
                >
                  <span className="event__time">
                    {event.allDay ? "All day" : formatTime(event.start)}
                  </span>
                  <span className="event__title">{event.title}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {sources.length > 0 && (
        <ul className="legend" aria-label="Calendars">
          {sources.map((s) => (
            <li key={s.id} className="legend__item">
              <span className="legend__dot" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
        </>
      )}

      {addingDay && writable.length > 0 && (
        <AddEvent
          day={addingDay}
          sources={writable}
          onClose={() => setAddingDay(null)}
          onSaved={() => setAddingDay(null)}
        />
      )}
    </main>
  );
}

function buildDays(from: Date, count: number, offsetDays = 0): Date[] {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Sep 6 – 12", or "Sep 28 – Oct 4" across a month boundary. */
function formatRange(days: Date[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return "";
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });
  const sameMonth = first.getMonth() === last.getMonth();
  return sameMonth
    ? `${month(first)} ${first.getDate()} – ${last.getDate()}`
    : `${month(first)} ${first.getDate()} – ${month(last)} ${last.getDate()}`;
}

function eventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const start = day.getTime();
  const end = start + 86_400_000;
  return events.filter(
    (e) => Date.parse(e.start) < end && Date.parse(e.end) > start,
  );
}

/**
 * Home Assistant reports binary sensors as "on"/"off" with the meaning in the
 * device class; everything else is a value with an optional unit. Unrecognized
 * kinds fall through to the raw state so a new sensor never renders blank.
 */
const BINARY_LABELS: Record<string, [on: string, off: string]> = {
  motion: ["Motion", "Clear"],
  occupancy: ["Occupied", "Empty"],
  door: ["Open", "Closed"],
  window: ["Open", "Closed"],
  opening: ["Open", "Closed"],
  moisture: ["Wet", "Dry"],
};

function formatReading(reading: SensorReading): string {
  if (reading.stale) return "—";

  const binary = BINARY_LABELS[reading.kind];
  if (binary && (reading.value === "on" || reading.value === "off")) {
    return reading.value === "on" ? binary[0] : binary[1];
  }

  if (reading.numericValue !== undefined) {
    const rounded = Math.round(reading.numericValue * 10) / 10;
    return `${rounded}${reading.unit ?? ""}`;
  }

  return reading.value;
}

/**
 * Home Assistant's condition slugs. Unrecognized ones render without an icon
 * rather than hiding the temperatures.
 */
const CONDITION_EMOJI: Record<string, string> = {
  sunny: "☀️",
  "clear-night": "🌙",
  partlycloudy: "⛅",
  cloudy: "☁️",
  fog: "🌫️",
  windy: "💨",
  "windy-variant": "💨",
  rainy: "🌦️",
  pouring: "🌧️",
  lightning: "🌩️",
  "lightning-rainy": "⛈️",
  hail: "🌨️",
  snowy: "❄️",
  "snowy-rainy": "🌨️",
  exceptional: "⚠️",
};

function forecastFor(
  forecast: ForecastDay[],
  day: Date,
): ForecastDay | undefined {
  const pad = (n: number) => String(n).padStart(2, "0");
  const key = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  return forecast.find((f) => f.date === key);
}

function Weather({ day }: { day: ForecastDay | undefined }) {
  if (!day) return null;
  const icon = CONDITION_EMOJI[day.condition];
  return (
    <p className="day__weather" title={day.condition}>
      {icon && <span className="day__weather-icon">{icon}</span>}
      <span>
        {Math.round(day.high)}°
        {day.low !== undefined && (
          <span className="day__weather-low"> / {Math.round(day.low)}°</span>
        )}
      </span>
    </p>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
