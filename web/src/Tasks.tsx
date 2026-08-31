import { useEffect, useMemo, useRef, useState } from "react";
import type { TasksView } from "./useEvents";

/**
 * Chore chart and parent to-do list. All mutations POST to the server and the
 * updated state arrives back over the SSE stream — no local copies to drift,
 * and every display (wall, phones) updates together.
 */

async function send(path: string, method: string, body?: unknown) {
  await fetch(path, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  }).catch(() => {
    // The next SSE frame is the source of truth; a lost request just means
    // the tap didn't land, same as any offline moment.
  });
}

/**
 * Emoji by keyword, so "Brush teeth" decorates itself and the stored data
 * stays plain text. First match wins; anything unmatched earns a star.
 */
const CHORE_EMOJI: [RegExp, string][] = [
  [/teeth|tooth|brush/i, "🪥"],
  [/bed/i, "🛏️"],
  [/room|clean/i, "🧹"],
  [/desk|homework|study/i, "📚"],
  [/dish|kitchen/i, "🍽️"],
  [/trash|garbage|recycl/i, "🗑️"],
  [/laundry|clothes|fold/i, "🧺"],
  [/dog|cat|kitty|litter|pet|feed|fish/i, "🐾"],
  [/plant|water|garden/i, "🪴"],
  [/bath|shower|wash/i, "🛁"],
  [/hair/i, "💇"],
  [/read|book/i, "📖"],
  [/piano|drum|sing|practice|music/i, "🎵"],
  [/shoe|toy|tidy/i, "🧸"],
];

function choreEmoji(title: string): string {
  return CHORE_EMOJI.find(([re]) => re.test(title))?.[1] ?? "⭐";
}

export function ChoreChart({ tasks }: { tasks: TasksView }) {
  // Chore deletion goes through the parent passcode when one is configured.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  const requestDelete = (id: string) => {
    if (!tasks.pinRequired) {
      void send(`/api/chores/${id}`, "DELETE");
      return;
    }
    setPinError(null);
    setPendingDelete(id);
  };

  const confirmDelete = async (pin: string) => {
    if (!pendingDelete) return;
    const response = await fetch(`/api/chores/${pendingDelete}`, {
      method: "DELETE",
      headers: { "X-Pin": pin },
    }).catch(() => null);
    if (response?.ok) {
      setPendingDelete(null);
      setPinError(null);
    } else {
      setPinError(
        response?.status === 403 ? "Wrong passcode" : "Couldn't delete — try again",
      );
    }
  };

  const [redeemFor, setRedeemFor] = useState<string | null>(null);
  const chooseReward = async (reward: string) => {
    if (!redeemFor) return;
    await send("/api/redeem", "POST", { kid: redeemFor, reward });
    setRedeemFor(null);
  };

  return (
    <div
      className="board"
      style={{ gridTemplateColumns: `repeat(${tasks.kids.length}, 1fr)` }}
    >
      {tasks.kids.map((kid) => (
        <KidColumn
          key={kid}
          kid={kid}
          tasks={tasks}
          onRemove={requestDelete}
          onRedeem={() => setRedeemFor(kid)}
        />
      ))}
      {redeemFor && (
        <div className="overlay" onClick={() => setRedeemFor(null)}>
          <div className="add pinpad" onClick={(e) => e.stopPropagation()}>
            <h2 className="add__heading">🎁 {redeemFor}, pick your reward!</h2>
            {tasks.rewards.map((reward) => (
              <button
                key={reward}
                type="button"
                className="nav__button reward__option"
                onClick={() => void chooseReward(reward)}
              >
                {reward}
              </button>
            ))}
            <button
              type="button"
              className="nav__button"
              onClick={() => setRedeemFor(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {pendingDelete && (
        <PinPrompt
          error={pinError}
          onSubmit={(pin) => void confirmDelete(pin)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function KidColumn({
  kid,
  tasks,
  onRemove,
  onRedeem,
}: {
  kid: string;
  tasks: TasksView;
  onRemove: (id: string) => void;
  onRedeem: () => void;
}) {
  const points = tasks.points.find((p) => p.kid === kid);
  const barFull =
    points !== undefined && points.target > 0 && points.earned >= points.target;
  const chores = tasks.chores.filter((c) => c.kid === kid);
  const weekday = new Date().getDay();
  // Today's duties: dailies plus any day-pinned chore due today. A pinned
  // chore simply doesn't appear on its off days.
  const daily = chores.filter(
    (c) =>
      c.cadence === "daily" ||
      (c.cadence === "days" && (c.days?.includes(weekday) ?? false)),
  );
  const weekly = chores.filter((c) => c.cadence === "weekly");
  // Pinned chores not due today stay visible but inert — so adding one gives
  // immediate feedback, and parents can still remove them on off days.
  const pinnedOffDay = chores.filter(
    (c) => c.cadence === "days" && !(c.days?.includes(weekday) ?? false),
  );
  // Celebration keys off the dailies — a Tuesday well done deserves confetti
  // even if "clean the fish tank" isn't due until Sunday.
  const allDone =
    daily.length > 0 && daily.every((c) => tasks.doneToday.includes(c.id));

  // Confetti on the moment of completion, not merely while complete — so it
  // fires when the last box is ticked, and again if they earn it back.
  const [celebrate, setCelebrate] = useState(false);
  const wasDone = useRef(allDone);
  useEffect(() => {
    const was = wasDone.current;
    wasDone.current = allDone;
    if (allDone && !was) {
      setCelebrate(true);
      const timer = window.setTimeout(() => setCelebrate(false), 4000);
      return () => window.clearTimeout(timer);
    }
  }, [allDone]);

  return (
    <section className="board__col">
      {celebrate && <Confetti />}
      <h2 className="board__heading">{kid}</h2>
      {points && points.target > 0 && (
        <div className="progress">
          <div className="progress__track">
            <div
              className={`progress__fill${barFull ? " progress__fill--full" : ""}`}
              style={{
                width: `${Math.min(100, (points.earned / points.target) * 100)}%`,
              }}
            />
          </div>
          <span className="progress__label">
            {points.earned} / {points.target} pts ·{" "}
            {Math.round((points.earned / points.target) * 100)}%
          </span>
        </div>
      )}
      {points?.redeemed && (
        <p className="reward__earned">🏆 {points.redeemed} earned this week!</p>
      )}
      {barFull && !points.redeemed && (
        <button type="button" className="nav__button reward__redeem" onClick={onRedeem}>
          🎁 Redeem points
        </button>
      )}
      <ul className="tasklist">
        {daily.map((chore) => (
          <TaskRow
            key={chore.id}
            title={chore.title}
            emoji={choreEmoji(chore.title)}
            done={tasks.doneToday.includes(chore.id)}
            onToggle={() => void send(`/api/chores/${chore.id}/toggle`, "POST")}
            onRemove={() => onRemove(chore.id)}
          />
        ))}
        {allDone && (
          <li className="tasklist__party" role="status">
            🎉 All done today!
          </li>
        )}
        {weekly.length > 0 && <li className="tasklist__divider">This week</li>}
        {weekly.map((chore) => (
          <TaskRow
            key={chore.id}
            title={chore.title}
            emoji={choreEmoji(chore.title)}
            done={tasks.doneToday.includes(chore.id)}
            onToggle={() => void send(`/api/chores/${chore.id}/toggle`, "POST")}
            onRemove={() => onRemove(chore.id)}
          />
        ))}
        {pinnedOffDay.length > 0 && (
          <li className="tasklist__divider">Other days</li>
        )}
        {pinnedOffDay.map((chore) => (
          <li key={chore.id} className="task task--offday">
            <span className="task__title">
              <span className="task__emoji">{choreEmoji(chore.title)}</span>
              {chore.title}
            </span>
            <span className="task__daychip">
              {(chore.days ?? []).map((d) => DAY_SHORT[d]).join(" · ")}
            </span>
            <button
              type="button"
              className="task__remove"
              onClick={() => onRemove(chore.id)}
              aria-label={`Remove ${chore.title}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <AddRow
        placeholder="New chore"
        withCadence
        onAdd={(title, cadence, days) =>
          void send("/api/chores", "POST", { kid, title, cadence, days })
        }
      />
    </section>
  );
}

const CONFETTI_COLORS = [
  "#4c8dff",
  "#f2994a",
  "#9b59b6",
  "#2ecc71",
  "#e74c3c",
  "#f1c40f",
];

function Confetti() {
  const bits = useMemo(
    () =>
      Array.from({ length: 40 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.8,
        duration: 2.2 + Math.random() * 1.6,
        size: 6 + Math.random() * 6,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      })),
    [],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {bits.map((bit, i) => (
        <span
          key={i}
          className="confetti__bit"
          style={{
            left: `${bit.left}%`,
            width: bit.size,
            height: bit.size * 0.45,
            background: bit.color,
            animationDelay: `${bit.delay}s`,
            animationDuration: `${bit.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

function PinPrompt({
  error,
  onSubmit,
  onClose,
}: {
  error: string | null;
  onSubmit: (pin: string) => void;
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  // A wrong guess comes back as an error prop; start the entry over.
  useEffect(() => {
    if (error) setPin("");
  }, [error]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="add pinpad" onClick={(e) => e.stopPropagation()}>
        <h2 className="add__heading">Parent passcode</h2>
        <p className="pinpad__dots" aria-label={`${pin.length} digits entered`}>
          {pin.length === 0 ? "· · · ·" : "●".repeat(pin.length)}
        </p>
        {error && (
          <p className="add__error" role="alert">
            {error}
          </p>
        )}
        <div className="pinpad__grid">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map(
            (key) => (
              <button
                key={key}
                type="button"
                className={`nav__button pinpad__key${key === "OK" ? " add__save" : ""}`}
                disabled={key === "OK" && pin.length === 0}
                onClick={() => {
                  if (key === "⌫") setPin((p) => p.slice(0, -1));
                  else if (key === "OK") onSubmit(pin);
                  else setPin((p) => (p.length < 8 ? p + key : p));
                }}
              >
                {key}
              </button>
            ),
          )}
        </div>
        <button type="button" className="nav__button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function TodoList({ tasks }: { tasks: TasksView }) {
  const open = tasks.todos.filter((t) => !t.done);
  const done = tasks.todos.filter((t) => t.done);
  return (
    <div className="board board--single">
      <section className="board__col">
        <h2 className="board__heading">
          📝 To-Do{tasks.parents.length > 0 && ` — ${tasks.parents.join(" & ")}`}
        </h2>
        <ul className="tasklist">
          {[...open, ...done].map((todo) => (
            <TaskRow
              key={todo.id}
              title={todo.title}
              done={todo.done}
              onToggle={() => void send(`/api/todos/${todo.id}/toggle`, "POST")}
              onRemove={() => void send(`/api/todos/${todo.id}`, "DELETE")}
            />
          ))}
        </ul>
        <AddRow
          placeholder="New to-do"
          onAdd={(title) => void send("/api/todos", "POST", { title })}
        />
      </section>
    </div>
  );
}

function TaskRow({
  title,
  emoji,
  done,
  onToggle,
  onRemove,
}: {
  title: string;
  emoji?: string;
  done: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <li className={`task${done ? " task--done" : ""}`}>
      <button
        type="button"
        className="task__check"
        onClick={onToggle}
        aria-pressed={done}
        aria-label={`${title}: ${done ? "done" : "not done"}`}
      >
        {done ? "✓" : ""}
      </button>
      <span className="task__title" onClick={onToggle}>
        {emoji && <span className="task__emoji">{emoji}</span>}
        {title}
      </span>
      <button
        type="button"
        className="task__remove"
        onClick={onRemove}
        aria-label={`Remove ${title}`}
      >
        ×
      </button>
    </li>
  );
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type NewCadence = "daily" | "weekly" | "days";

function AddRow({
  placeholder,
  onAdd,
  withCadence = false,
}: {
  placeholder: string;
  onAdd: (title: string, cadence: NewCadence, days?: number[]) => void;
  withCadence?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [cadence, setCadence] = useState<NewCadence>("daily");
  const [days, setDays] = useState<number[]>([]);
  const needsDays = cadence === "days" && days.length === 0;
  return (
    <form
      className="task-add"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = title.trim();
        if (!trimmed || needsDays) return;
        onAdd(trimmed, cadence, cadence === "days" ? days : undefined);
        setTitle("");
        setCadence("daily");
        setDays([]);
      }}
    >
      <input
        className="add__input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        maxLength={100}
      />
      {withCadence && (
        <select
          className="add__input task-add__cadence"
          value={cadence}
          onChange={(e) => setCadence(e.target.value as NewCadence)}
          aria-label="How often"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="days">On days…</option>
        </select>
      )}
      <button
        type="submit"
        className="nav__button"
        disabled={!title.trim() || needsDays}
      >
        +
      </button>
      {withCadence && cadence === "days" && (
        <div className="task-add__days" role="group" aria-label="Which days">
          {DAY_LETTERS.map((letter, day) => (
            <button
              key={day}
              type="button"
              className={`task-add__day${days.includes(day) ? " task-add__day--on" : ""}`}
              aria-label={DAY_NAMES[day]}
              aria-pressed={days.includes(day)}
              onClick={() =>
                setDays((d) =>
                  d.includes(day) ? d.filter((x) => x !== day) : [...d, day],
                )
              }
            >
              {letter}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
