import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One bulb's saved state inside a theme. */
export interface ThemeBulb {
  entityId: string;
  on: boolean;
  brightness?: number;
  rgb?: [number, number, number];
}

/** A named snapshot of several bulbs, re-applied with one tap ("Movie Night"). */
export interface Theme {
  id: string;
  name: string;
  bulbs: ThemeBulb[];
}

interface LightsData {
  /** Bulb entity id → room name, e.g. { "light.lightbulb_1": "Living Room" }. */
  rooms: Record<string, string>;
  themes: Theme[];
}

export interface LightsConfigView {
  rooms: Record<string, string>;
  themes: Theme[];
}

const MAX_NAME = 40;
const MAX_THEMES = 40;
const MAX_BULBS = 60;

/**
 * Room assignments and colour themes for the Lights tab, JSON on disk. Same
 * discipline as MealStore/TaskStore: real data in DATA_DIR, write-then-rename,
 * listeners for SSE. This store holds only the *organization* of lights —
 * their live state comes from Home Assistant through the poller, and changes
 * are applied by the light control writer. Keeping the two apart means a bulb
 * dropping offline never corrupts its room or theme membership.
 */
export class LightStore {
  #file: string;
  #dir: string;
  #data: LightsData = { rooms: {}, themes: [] };
  #listeners = new Set<() => void>();

  constructor(dir: string) {
    this.#dir = dir;
    this.#file = join(dir, "lights.json");
  }

  async load(): Promise<void> {
    try {
      this.#data = JSON.parse(await readFile(this.#file, "utf8")) as LightsData;
      this.#data.rooms ??= {};
      this.#data.themes ??= [];
    } catch {
      // First run — start empty.
    }
  }

  view(): LightsConfigView {
    return { rooms: this.#data.rooms, themes: this.#data.themes };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Assign a bulb to a room, or clear its assignment when room is empty. */
  async setRoom(entityId: string, room: string): Promise<void> {
    const name = room.trim().slice(0, MAX_NAME);
    if (name) this.#data.rooms[entityId] = name;
    else delete this.#data.rooms[entityId];
    await this.#persist();
  }

  /** Bulbs currently assigned to a room. */
  bulbsInRoom(room: string): string[] {
    return Object.entries(this.#data.rooms)
      .filter(([, r]) => r === room)
      .map(([entityId]) => entityId);
  }

  async addTheme(name: string, bulbs: ThemeBulb[]): Promise<Theme | null> {
    const clean = name.trim().slice(0, MAX_NAME);
    if (!clean || bulbs.length === 0 || bulbs.length > MAX_BULBS) return null;
    if (this.#data.themes.length >= MAX_THEMES) return null;
    const theme: Theme = { id: randomUUID(), name: clean, bulbs };
    this.#data.themes.push(theme);
    await this.#persist();
    return theme;
  }

  async removeTheme(id: string): Promise<boolean> {
    const before = this.#data.themes.length;
    this.#data.themes = this.#data.themes.filter((t) => t.id !== id);
    if (this.#data.themes.length === before) return false;
    await this.#persist();
    return true;
  }

  getTheme(id: string): Theme | undefined {
    return this.#data.themes.find((t) => t.id === id);
  }

  async #persist(): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#data), "utf8");
      await rename(tmp, this.#file);
    } catch (err) {
      console.error("[lights] write failed", err);
    }
    for (const listener of this.#listeners) listener();
  }
}
