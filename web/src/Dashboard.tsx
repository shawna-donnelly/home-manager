import { useEffect, useState } from "react";
import type { SourceInfo } from "./AddEvent";
import { avatarUrl, type Avatars } from "./avatars";
import type {
  CalendarEvent,
  Chore,
  ShoppingItem,
  Snapshot,
} from "./useEvents";
import { CONDITION_EMOJI, forecastFor } from "./weather";

/** Avatar/accent pastels, assigned per kid by position. */
const KID_TINTS = ["#d9d4f6", "#f9d5e0", "#cfe3fb", "#d9efd9", "#ffe9a8"];

/**
 * The at-a-glance family hub, styled after commercial wall displays: a light
 * mosaic of cards — today's agenda, home tiles, a photo, kid chores, and the
 * grocery list. Today-focused on purpose; the Calendar tab owns the week.
 */
export default function Dashboard({
  snapshot,
  sources,
  now,
  avatars,
}: {
  snapshot: Snapshot;
  sources: SourceInfo[];
  now: Date;
  avatars: Avatars;
}) {
  const tasks = snapshot.tasks;
  const doneToday = new Set(tasks?.doneToday ?? []);
  const weekday = now.getDay();
  const colorOf = new Map(sources.map((s) => [s.id, s.color]));

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const events = eventsForDay(snapshot.events, dayStart).sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.start < b.start ? -1 : 1;
  });

  const today = forecastFor(snapshot.forecast ?? [], now);

  return (
    <div className="dash">
      <section className="dcard dcard--agenda">
        <h2 className="dcard__title">
          Today{" "}
          <span className="dash__date">
            {now.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
        </h2>
        {events.length === 0 ? (
          <p className="dash__quiet">Nothing on the calendar 🎉</p>
        ) : (
          <ul className="agenda">
            {events.map((event) => (
              <li key={event.id} className="agenda__item">
                <span
                  className="agenda__pill"
                  style={{ background: colorOf.get(event.sourceId) ?? "#888" }}
                >
                  {event.allDay
                    ? "All day"
                    : `${formatTime(event.start)} – ${formatTime(event.end)}`}
                </span>
                <span className="agenda__title">{event.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dcard">
        <h2 className="dcard__title">🏠 Home</h2>
        <div className="tiles">
          {today && (
            <div className="tile tile--yellow">
              <span className="tile__icon">
                {CONDITION_EMOJI[today.condition] ?? "🌡"}
              </span>
              <span className="tile__label">Weather</span>
              <span className="tile__value">
                {Math.round(today.high)}°
                {today.low !== undefined && ` / ${Math.round(today.low)}°`}
              </span>
            </div>
          )}
          {(snapshot.locations ?? []).map((person, i) => (
            <div
              key={person.id}
              className={`tile ${
                person.stale
                  ? "tile--gray"
                  : person.zone === "home"
                    ? "tile--green"
                    : "tile--blue"
              }`}
            >
              {avatarUrl(avatars, person.name) ? (
                <img
                  className="tile__avatar"
                  src={avatarUrl(avatars, person.name) as string}
                  alt=""
                />
              ) : (
                <span className="tile__icon">
                  {["🧍", "🧍‍♀️", "🧒", "🧒", "🧒"][i] ?? "🧍"}
                </span>
              )}
              <span className="tile__label">{person.name}</span>
              <span className="tile__value">{zoneLabel(person.zone, person.stale)}</span>
            </div>
          ))}
          {(snapshot.sensors ?? []).map((reading) => (
            <div key={reading.id} className="tile tile--purple">
              <span className="tile__icon">📟</span>
              <span className="tile__label">{reading.label}</span>
              <span className="tile__value">
                {reading.stale
                  ? "—"
                  : `${reading.value}${reading.unit ?? ""}`}
              </span>
            </div>
          ))}
        </div>
      </section>

      <PhotoCard now={now} />

      <section className="dcard dcard--kids">
        {tasks && tasks.kids.length > 0 ? (
          tasks.kids.map((kid, i) => {
            const due = (tasks.chores ?? []).filter(
              (c) =>
                c.kid === kid &&
                (c.cadence === "daily" ||
                  (c.cadence === "days" &&
                    (c.days?.includes(weekday) ?? false))),
            );
            const weekly = (tasks.chores ?? []).filter(
              (c) => c.kid === kid && c.cadence === "weekly",
            );
            const points = tasks.points.find((p) => p.kid === kid);
            return (
              <div key={kid} className="kidcard">
                <header className="kidcard__head">
                  {avatarUrl(avatars, kid) ? (
                    <img
                      className="kidcard__avatar kidcard__avatar--img"
                      src={avatarUrl(avatars, kid) as string}
                      alt=""
                    />
                  ) : (
                    <span
                      className="kidcard__avatar"
                      style={{ background: KID_TINTS[i % KID_TINTS.length] }}
                    >
                      {kid.charAt(0)}
                    </span>
                  )}
                  <span className="kidcard__name">{kid}</span>
                  {points && points.target > 0 && (
                    <span className="kidcard__points">
                      ⭐ {points.earned}/{points.target}
                    </span>
                  )}
                </header>
                <ChoreRows chores={due} done={doneToday} />
                {weekly.length > 0 && (
                  <>
                    <p className="kidcard__section">This week</p>
                    <ChoreRows chores={weekly} done={doneToday} />
                  </>
                )}
              </div>
            );
          })
        ) : (
          <p className="dash__quiet">No chore chart configured</p>
        )}
      </section>

      <GroceryCard live={snapshot.shopping} todos={tasks?.todos ?? []} />
    </div>
  );
}

function zoneLabel(zone: string, stale: boolean): string {
  if (stale) return "—";
  if (zone === "home") return "Home";
  if (zone === "not_home") return "Away";
  return zone;
}

function ChoreRows({ chores, done }: { chores: Chore[]; done: Set<string> }) {
  return (
    <ul className="kidcard__list">
      {chores.map((chore) => {
        const isDone = done.has(chore.id);
        return (
          <li
            key={chore.id}
            className={`krow${isDone ? " krow--done" : ""}`}
          >
            <span className="krow__title">{chore.title}</span>
            <button
              type="button"
              className={`krow__check${isDone ? " krow__check--on" : ""}`}
              onClick={() =>
                void fetch(`/api/chores/${chore.id}/toggle`, {
                  method: "POST",
                })
              }
              aria-label={`Toggle ${chore.title}`}
            >
              {isDone ? "✓" : ""}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PhotoCard({ now }: { now: Date }) {
  const [photos, setPhotos] = useState<string[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const load = () =>
      fetch("/api/photos")
        .then((r) =>
          r.ok ? (r.json() as Promise<{ photos: string[] }>) : null,
        )
        .then((data) => {
          if (data) setPhotos(shuffle(data.photos));
        })
        .catch(() => {
          // The empty-state card is a fine outcome.
        });
    void load();
    const timer = window.setInterval(load, 3_600_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (photos.length < 2) return;
    const timer = window.setInterval(
      () => setIndex((i) => (i + 1) % photos.length),
      20_000,
    );
    return () => window.clearInterval(timer);
  }, [photos]);

  const photo = photos[index];
  return (
    <section className="dcard dcard--photo">
      {photo ? (
        <>
          <img
            key={photo}
            className="photo__img"
            src={`/photos/${encodeURIComponent(photo)}`}
            alt=""
          />
          <span className="photo__date">
            {now.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </>
      ) : (
        <div className="photo__empty">
          <span className="photo__emptyicon">🖼️</span>
          <p>Drop photos into .data/photos to fill this frame</p>
        </div>
      )}
    </section>
  );
}

function GroceryCard({
  live,
  todos,
}: {
  live?: ShoppingItem[];
  todos: { id: string; title: string; done: boolean }[];
}) {
  const [items, setItems] = useState<ShoppingItem[]>([]);

  useEffect(() => {
    if (live) {
      setItems(live);
      return;
    }
    fetch("/api/shopping")
      .then((r) =>
        r.ok ? (r.json() as Promise<{ items: ShoppingItem[] }>) : null,
      )
      .then((data) => {
        if (data) setItems(data.items);
      })
      .catch(() => {
        // Card just renders its to-do half.
      });
  }, [live]);

  return (
    <section className="dcard dcard--list">
      <h2 className="dcard__title">🛒 Grocery List</h2>
      <ul className="glist">
        {items.map((item) => (
          <li
            key={item.uid}
            className={`grow${item.done ? " grow--done" : ""}`}
          >
            <button
              type="button"
              className={`krow__check${item.done ? " krow__check--on" : ""}`}
              onClick={() =>
                void fetch(`/api/shopping/${item.uid}/toggle`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ done: !item.done }),
                })
              }
              aria-label={`Toggle ${item.summary}`}
            >
              {item.done ? "✓" : ""}
            </button>
            <span className="grow__pill grow__pill--grocery">Groceries</span>
            <span className="grow__title">{item.summary}</span>
          </li>
        ))}
        {todos
          .filter((t) => !t.done)
          .map((todo) => (
            <li key={todo.id} className="grow">
              <button
                type="button"
                className="krow__check"
                onClick={() =>
                  void fetch(`/api/todos/${todo.id}/toggle`, {
                    method: "POST",
                  })
                }
                aria-label={`Toggle ${todo.title}`}
              >
                {""}
              </button>
              <span className="grow__pill grow__pill--todo">To Do</span>
              <span className="grow__title">{todo.title}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}

function eventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const start = day.getTime();
  const end = start + 86_400_000;
  return events.filter(
    (e) => Date.parse(e.start) < end && Date.parse(e.end) > start,
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
