import { useState } from "react";

export interface SourceInfo {
  id: string;
  label: string;
  color: string;
  writable: boolean;
}

/**
 * Minimal add-event form for a touchscreen: title, calendar, all-day or
 * time + duration. Anything fancier (guests, recurrence, editing) belongs in
 * a real calendar app — the wall just needs "dentist, Tuesday, 3pm".
 */
export default function AddEvent({
  day,
  sources,
  onClose,
  onSaved,
}: {
  day: Date;
  sources: SourceInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [allDay, setAllDay] = useState(false);
  const [time, setTime] = useState("09:00");
  const [durationMin, setDurationMin] = useState(60);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dayLabel = day.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const submit = async () => {
    if (!title.trim() || !sourceId || saving) return;
    setSaving(true);
    setError(null);

    let start: string;
    let end: string;
    if (allDay) {
      start = toDateOnly(day);
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      end = toDateOnly(next); // exclusive, per the API contract
    } else {
      // Wall-clock strings + this browser's zone, never UTC instants: the
      // event means "12:30 on the wall", even if the target calendar's own
      // timezone setting is wrong.
      const [hh, mm] = time.split(":").map(Number);
      const startDate = new Date(day);
      startDate.setHours(hh ?? 9, mm ?? 0, 0, 0);
      start = toWallClock(startDate);
      end = toWallClock(new Date(startDate.getTime() + durationMin * 60_000));
    }

    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId,
          title: title.trim(),
          allDay,
          start,
          end,
          ...(allDay
            ? {}
            : { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `server returned ${response.status}`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="add"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="add__heading">New event — {dayLabel}</h2>

        <input
          className="add__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What's happening?"
          maxLength={200}
          autoFocus
        />

        <label className="add__row">
          Calendar
          <select
            className="add__input"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="add__row add__row--inline">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
          />
          All day
        </label>

        {!allDay && (
          <div className="add__times">
            <label className="add__row">
              Starts
              <input
                className="add__input"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label className="add__row">
              Length
              <select
                className="add__input"
                value={durationMin}
                onChange={(e) => setDurationMin(Number(e.target.value))}
              >
                <option value={30}>30 min</option>
                <option value={60}>1 hour</option>
                <option value={90}>1.5 hours</option>
                <option value={120}>2 hours</option>
                <option value={180}>3 hours</option>
              </select>
            </label>
          </div>
        )}

        {error && (
          <p className="add__error" role="alert">
            {error}
          </p>
        )}

        <div className="add__actions">
          <button type="button" className="nav__button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="nav__button add__save"
            disabled={!title.trim() || !sourceId || saving}
          >
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}

function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local time with no offset, e.g. "2026-08-31T00:30:00". */
function toWallClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${toDateOnly(date)}T${hh}:${mm}:00`;
}
