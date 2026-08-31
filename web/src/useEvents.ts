import { useEffect, useRef, useState } from "react";

export interface CalendarEvent {
  id: string;
  sourceId: string;
  sourceLabel: string;
  color: string;
  title: string;
  location?: string;
  start: string;
  end: string;
  allDay: boolean;
}

export interface SensorReading {
  id: string;
  sourceId: string;
  entityId: string;
  label: string;
  kind: string;
  value: string;
  numericValue?: number;
  unit?: string;
  updatedAt: string;
  stale: boolean;
}

export interface Chore {
  id: string;
  kid: string;
  title: string;
  /** "daily" resets at midnight; "weekly" resets Monday. */
  cadence: "daily" | "weekly";
}

export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

export interface TasksView {
  kids: string[];
  parents: string[];
  chores: Chore[];
  doneToday: string[];
  todos: Todo[];
  pinRequired: boolean;
}

export interface Snapshot {
  events: CalendarEvent[];
  sensors: SensorReading[];
  tasks?: TasksView;
  fetchedAt: string;
  degraded: string[];
}

export type Connection = "connecting" | "live" | "reconnecting";

/**
 * Subscribes to the server's snapshot stream.
 *
 * EventSource reconnects on its own, but only for clean drops. A Pi that loses
 * WiFi can leave the connection wedged open, so an explicit error handler tears
 * it down and rebuilds with backoff. The display must recover unattended — the
 * failure mode to avoid is a screen showing last Tuesday with no indication
 * anything is wrong.
 */
export function useEvents(): {
  snapshot: Snapshot | null;
  connection: Connection;
} {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const attemptRef = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      source = new EventSource("/api/stream");

      source.onopen = () => {
        attemptRef.current = 0;
        setConnection("live");
      };

      source.onmessage = (event) => {
        try {
          setSnapshot(JSON.parse(event.data) as Snapshot);
        } catch {
          // A malformed frame is not worth dropping the stream over.
        }
      };

      source.onerror = () => {
        source?.close();
        if (cancelled) return;
        setConnection("reconnecting");
        const delay = Math.min(1000 * 2 ** attemptRef.current, 30_000);
        attemptRef.current += 1;
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      source?.close();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, []);

  return { snapshot, connection };
}

/**
 * Ticking clock that resyncs to the wall clock rather than drifting. Matters on
 * a display that runs for months without a reload.
 */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number;
    const schedule = () => {
      const delay = intervalMs - (Date.now() % intervalMs);
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [intervalMs]);

  return now;
}
