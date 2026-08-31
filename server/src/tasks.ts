import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Cadence = "daily" | "weekly" | "days";

export interface Chore {
  id: string;
  /** Kid name, matching an entry in KIDS. */
  kid: string;
  title: string;
  /**
   * "daily" resets at midnight; "weekly" resets Monday; "days" behaves like
   * a daily but only on the weekdays in `days`.
   */
  cadence: Cadence;
  /** For cadence "days": weekdays it's due, 0 = Sunday … 6 = Saturday. */
  days?: number[];
}

export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

/** One point per daily completion, three per weekly — a full week's target. */
export const DAILY_POINTS = 1;
export const WEEKLY_POINTS = 3;

interface Redemption {
  week: string;
  kid: string;
  reward: string;
  points: number;
  at: string;
}

/** Per-kid weekly score, computed from completion history — never stored. */
export interface PointsView {
  kid: string;
  earned: number;
  target: number;
  /** Set when this week's reward is already claimed. */
  redeemed?: string;
}

/**
 * What goes to disk. Completions are chore ids keyed by local YYYY-MM-DD for
 * daily chores, and by `W` + the week's Monday (`W2026-08-24`) for weekly.
 */
interface TasksData {
  chores: Chore[];
  completions: Record<string, string[]>;
  todos: Todo[];
  redemptions?: Redemption[];
}

/** What clients see: today's completions only, plus who's who from config. */
export interface TasksView {
  kids: string[];
  parents: string[];
  chores: Chore[];
  doneToday: string[];
  todos: Todo[];
  /** True when deleting a chore needs the parent passcode. */
  pinRequired: boolean;
  points: PointsView[];
  /** What a full bar can be traded for. */
  rewards: string[];
}

/**
 * Chores and todos, JSON on disk. Unlike the snapshot cache this is the only
 * copy of real data, so it lives in DATA_DIR, not CACHE_DIR. Same
 * write-then-rename discipline: a power cut can't leave a truncated file.
 */
export class TaskStore {
  #file: string;
  #dir: string;
  #kids: string[];
  #parents: string[];
  #pinRequired: boolean;
  #rewards: string[];
  #data: TasksData = { chores: [], completions: {}, todos: [] };
  #listeners = new Set<() => void>();

  constructor(
    dir: string,
    kids: string[],
    parents: string[],
    pinRequired: boolean,
    rewards: string[],
  ) {
    this.#dir = dir;
    this.#file = join(dir, "tasks.json");
    this.#kids = kids;
    this.#parents = parents;
    this.#pinRequired = pinRequired;
    this.#rewards = rewards;
  }

  async load(): Promise<void> {
    try {
      this.#data = JSON.parse(await readFile(this.#file, "utf8")) as TasksData;
      // Chores written before cadence existed are daily.
      for (const chore of this.#data.chores) chore.cadence ??= "daily";
      this.#data.redemptions ??= [];
    } catch {
      // First run — start empty.
    }
  }

  view(): TasksView {
    return {
      kids: this.#kids,
      parents: this.#parents,
      chores: this.#data.chores,
      // One merged set: daily completions for today plus weekly for this
      // week. Ids are unique, so the client needn't care which is which.
      doneToday: [
        ...(this.#data.completions[todayKey()] ?? []),
        ...(this.#data.completions[weekKey()] ?? []),
      ],
      todos: this.#data.todos,
      pinRequired: this.#pinRequired,
      points: this.#kids.map((kid) => this.#pointsFor(kid)),
      rewards: this.#rewards,
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async addChore(
    kid: string,
    title: string,
    cadence: Cadence,
    days?: number[],
  ): Promise<boolean> {
    if (!this.#kids.includes(kid)) return false;
    this.#data.chores.push({
      id: randomUUID(),
      kid,
      title,
      cadence,
      ...(cadence === "days" && days ? { days } : {}),
    });
    await this.#persist();
    return true;
  }

  async removeChore(id: string): Promise<boolean> {
    const before = this.#data.chores.length;
    this.#data.chores = this.#data.chores.filter((c) => c.id !== id);
    if (this.#data.chores.length === before) return false;
    for (const [key, done] of Object.entries(this.#data.completions)) {
      this.#data.completions[key] = done.filter((d) => d !== id);
    }
    await this.#persist();
    return true;
  }

  async toggleChore(id: string): Promise<boolean> {
    const chore = this.#data.chores.find((c) => c.id === id);
    if (!chore) return false;
    const key = chore.cadence === "weekly" ? weekKey() : todayKey();
    const done = new Set(this.#data.completions[key] ?? []);
    if (done.has(id)) done.delete(id);
    else done.add(id);
    this.#data.completions[key] = [...done];
    this.#pruneCompletions();
    await this.#persist();
    return true;
  }

  async addTodo(title: string): Promise<void> {
    this.#data.todos.push({ id: randomUUID(), title, done: false });
    await this.#persist();
  }

  async toggleTodo(id: string): Promise<boolean> {
    const todo = this.#data.todos.find((t) => t.id === id);
    if (!todo) return false;
    todo.done = !todo.done;
    await this.#persist();
    return true;
  }

  async removeTodo(id: string): Promise<boolean> {
    const before = this.#data.todos.length;
    this.#data.todos = this.#data.todos.filter((t) => t.id !== id);
    if (this.#data.todos.length === before) return false;
    await this.#persist();
    return true;
  }

  /**
   * This week's score for one kid, from the completion history. Weeks run
   * Monday–Sunday; the target assumes every daily chore all seven days plus
   * every weekly chore, so the bar only fills on a perfect week.
   */
  #pointsFor(kid: string): PointsView {
    const wk = weekKey();
    const [y, m, d] = wk.slice(1).split("-").map(Number);
    const mine = this.#data.chores.filter((c) => c.kid === kid);
    const dailies = mine.filter((c) => c.cadence === "daily");
    const pinned = mine.filter((c) => c.cadence === "days");
    const weeklies = mine.filter((c) => c.cadence === "weekly");

    let earned = 0;
    for (let i = 0; i < 7; i++) {
      const day = new Date(y ?? 0, (m ?? 1) - 1, (d ?? 1) + i);
      const weekday = day.getDay();
      const done = new Set(this.#data.completions[dateKey(day)] ?? []);
      earned += dailies.filter((c) => done.has(c.id)).length * DAILY_POINTS;
      earned +=
        pinned.filter((c) => c.days?.includes(weekday) && done.has(c.id))
          .length * DAILY_POINTS;
    }
    const weekDone = new Set(this.#data.completions[wk] ?? []);
    earned += weeklies.filter((c) => weekDone.has(c.id)).length * WEEKLY_POINTS;

    const target =
      dailies.length * 7 * DAILY_POINTS +
      pinned.reduce((sum, c) => sum + (c.days?.length ?? 0), 0) * DAILY_POINTS +
      weeklies.length * WEEKLY_POINTS;
    const redeemed = (this.#data.redemptions ?? []).find(
      (r) => r.week === wk && r.kid === kid,
    )?.reward;

    return { kid, earned, target, ...(redeemed ? { redeemed } : {}) };
  }

  /** Trade a full bar for a reward. Once per kid per week. */
  async redeem(
    kid: string,
    reward: string,
  ): Promise<"ok" | "unknown" | "incomplete" | "already"> {
    if (!this.#kids.includes(kid) || !this.#rewards.includes(reward)) {
      return "unknown";
    }
    const points = this.#pointsFor(kid);
    if (points.redeemed) return "already";
    if (points.target === 0 || points.earned < points.target) {
      return "incomplete";
    }
    (this.#data.redemptions ??= []).push({
      week: weekKey(),
      kid,
      reward,
      points: points.earned,
      at: new Date().toISOString(),
    });
    await this.#persist();
    return "ok";
  }

  /** Keep two months of history — enough for streaks later, bounded forever. */
  #pruneCompletions(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 62);
    const cutoffKey = dateKey(cutoff);
    for (const key of Object.keys(this.#data.completions)) {
      // Week keys carry a leading W; the date part compares the same way.
      if (key.replace(/^W/, "") < cutoffKey) delete this.#data.completions[key];
    }
  }

  async #persist(): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#data), "utf8");
      await rename(tmp, this.#file);
    } catch (err) {
      console.error("[tasks] write failed", err);
    }
    for (const listener of this.#listeners) listener();
  }
}

/** Local date — the Pi runs in the family's timezone. */
export function todayKey(): string {
  return dateKey(new Date());
}

/** `W` + this week's Monday, local. Weeks start Monday. */
export function weekKey(): string {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return `W${dateKey(monday)}`;
}

function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
