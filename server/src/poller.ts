import { readSnapshot, writeSnapshot } from "./cache.js";
import {
  POLL_INTERVAL_MS,
  WINDOW_DAYS_BACK,
  WINDOW_DAYS_FORWARD,
} from "./config.js";
import { sortEvents, type CalendarEvent, type Snapshot } from "./events.js";
import type {
  ForecastDay,
  PersonLocation,
  SensorReading,
} from "./readings.js";
import type { CalendarSource, SensorSource } from "./sources/types.js";

type Listener = (snapshot: Snapshot) => void;

export class Poller {
  #calendarSources: CalendarSource[];
  #sensorSources: SensorSource[];
  #listeners = new Set<Listener>();
  #timer?: NodeJS.Timeout;

  /** Per-source last-known-good, so one failing feed doesn't drop its data. */
  #lastGoodEvents = new Map<string, CalendarEvent[]>();
  #lastGoodReadings = new Map<string, SensorReading[]>();
  #lastGoodLocations = new Map<string, PersonLocation[]>();
  #lastGoodForecast = new Map<string, ForecastDay[]>();
  #snapshot: Snapshot = {
    events: [],
    sensors: [],
    locations: [],
    forecast: [],
    fetchedAt: "",
    degraded: [],
  };

  constructor(calendarSources: CalendarSource[], sensorSources: SensorSource[]) {
    this.#calendarSources = calendarSources;
    this.#sensorSources = sensorSources;
  }

  get snapshot(): Snapshot {
    return this.#snapshot;
  }

  async start(): Promise<void> {
    const cached = await readSnapshot();
    if (cached) {
      // Only restore sources that still exist in config — otherwise a removed
      // source's cached data would be served forever, since nothing ever
      // refreshes or clears a bucket without a live source behind it.
      const known = new Set(
        [...this.#calendarSources, ...this.#sensorSources].map((s) => s.id),
      );
      const events = cached.events.filter((e) => known.has(e.sourceId));
      const sensors = cached.sensors.filter((r) => known.has(r.sourceId));
      const locations = cached.locations.filter((l) => known.has(l.sourceId));
      const forecast = cached.forecast.filter((f) => known.has(f.sourceId));

      this.#snapshot = { ...cached, events, sensors, locations, forecast };
      for (const event of events) {
        const bucket = this.#lastGoodEvents.get(event.sourceId) ?? [];
        bucket.push(event);
        this.#lastGoodEvents.set(event.sourceId, bucket);
      }
      for (const reading of sensors) {
        const bucket = this.#lastGoodReadings.get(reading.sourceId) ?? [];
        bucket.push(reading);
        this.#lastGoodReadings.set(reading.sourceId, bucket);
      }
      for (const location of locations) {
        const bucket = this.#lastGoodLocations.get(location.sourceId) ?? [];
        bucket.push(location);
        this.#lastGoodLocations.set(location.sourceId, bucket);
      }
      for (const day of forecast) {
        const bucket = this.#lastGoodForecast.get(day.sourceId) ?? [];
        bucket.push(day);
        this.#lastGoodForecast.set(day.sourceId, bucket);
      }
      console.log(
        `[poller] restored ${events.length} cached events, ${sensors.length} readings` +
          (cached.events.length !== events.length
            ? ` (dropped ${cached.events.length - events.length} from removed sources)`
            : ""),
      );
    }

    await this.refresh();
    this.#timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    // Don't hold the process open on this alone.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    const now = new Date();
    const window = {
      from: addDays(now, -WINDOW_DAYS_BACK),
      to: addDays(now, WINDOW_DAYS_FORWARD),
    };

    const trackerSources = this.#sensorSources.flatMap((s) => {
      const fetchLocations = s.fetchLocations?.bind(s);
      return fetchLocations ? [{ id: s.id, fetchLocations }] : [];
    });
    const weatherSources = this.#sensorSources.flatMap((s) => {
      const fetchForecast = s.fetchForecast?.bind(s);
      return fetchForecast ? [{ id: s.id, fetchForecast }] : [];
    });
    const [calendarResults, sensorResults, locationResults, forecastResults] =
      await Promise.all([
        Promise.allSettled(this.#calendarSources.map((s) => s.fetch(window))),
        Promise.allSettled(this.#sensorSources.map((s) => s.fetch())),
        Promise.allSettled(trackerSources.map((s) => s.fetchLocations())),
        Promise.allSettled(weatherSources.map((s) => s.fetchForecast())),
      ]);

    const degraded: string[] = [];

    const settle = <T>(
      sources: ReadonlyArray<{ id: string }>,
      results: PromiseSettledResult<T[]>[],
      lastGood: Map<string, T[]>,
    ) => {
      results.forEach((result, i) => {
        const source = sources[i];
        if (!source) return;

        if (result.status === "fulfilled") {
          lastGood.set(source.id, result.value);
        } else {
          degraded.push(source.id);
          console.error(`[poller] ${source.id} failed:`, result.reason);
        }
      });
    };

    settle(this.#calendarSources, calendarResults, this.#lastGoodEvents);
    settle(this.#sensorSources, sensorResults, this.#lastGoodReadings);
    settle(trackerSources, locationResults, this.#lastGoodLocations);
    settle(weatherSources, forecastResults, this.#lastGoodForecast);

    this.#snapshot = {
      events: sortEvents([...this.#lastGoodEvents.values()].flat()),
      // No global sort: each source already emits readings in display order.
      sensors: [...this.#lastGoodReadings.values()].flat(),
      locations: [...this.#lastGoodLocations.values()].flat(),
      forecast: [...this.#lastGoodForecast.values()].flat(),
      fetchedAt: now.toISOString(),
      // A source that failed both its sensor and location fetch lists once.
      degraded: [...new Set(degraded)],
    };

    await writeSnapshot(this.#snapshot);
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
