import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Meal {
  id: string;
  title: string;
  /** As typed, one per entry. Comparison happens normalized, display as-is. */
  ingredients: string[];
  /** Full instructions, plain text. Absent for quick title-only meals. */
  recipe?: string;
}

interface MealsData {
  meals: Meal[];
  /** Dinner plan: local YYYY-MM-DD → meal id. */
  plan: Record<string, string>;
}

export interface MealsView {
  meals: Meal[];
  plan: Record<string, string>;
}

/** "Fresh Tomatoes " and "fresh tomatoes" are the same grocery item. */
export const normalizeIngredient = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Meal library + weekly dinner plan, JSON on disk. Same discipline as
 * TaskStore: real data in DATA_DIR, write-then-rename, listeners for SSE.
 */
export class MealStore {
  #file: string;
  #dir: string;
  #data: MealsData = { meals: [], plan: {} };
  #listeners = new Set<() => void>();

  constructor(dir: string) {
    this.#dir = dir;
    this.#file = join(dir, "meals.json");
  }

  async load(): Promise<void> {
    try {
      this.#data = JSON.parse(await readFile(this.#file, "utf8")) as MealsData;
      this.#data.meals ??= [];
      this.#data.plan ??= {};
    } catch {
      // First run — start empty.
    }
  }

  view(): MealsView {
    return { meals: this.#data.meals, plan: this.#data.plan };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async addMeal(
    title: string,
    ingredients: string[],
    recipe?: string,
  ): Promise<Meal> {
    const meal: Meal = {
      id: randomUUID(),
      title,
      ingredients: ingredients.map((i) => i.trim()).filter(Boolean),
      ...(recipe?.trim() ? { recipe: recipe.trim() } : {}),
    };
    this.#data.meals.push(meal);
    await this.#persist();
    return meal;
  }

  async removeMeal(id: string): Promise<boolean> {
    const before = this.#data.meals.length;
    this.#data.meals = this.#data.meals.filter((m) => m.id !== id);
    if (this.#data.meals.length === before) return false;
    for (const [date, mealId] of Object.entries(this.#data.plan)) {
      if (mealId === id) delete this.#data.plan[date];
    }
    await this.#persist();
    return true;
  }

  /** Assign a meal to a date, or clear the date with null. */
  async planMeal(date: string, mealId: string | null): Promise<boolean> {
    if (mealId !== null && !this.#data.meals.some((m) => m.id === mealId)) {
      return false;
    }
    if (mealId === null) delete this.#data.plan[date];
    else this.#data.plan[date] = mealId;
    this.#prunePlan();
    await this.#persist();
    return true;
  }

  /**
   * The distinct ingredients across the given dates' planned meals —
   * shared ingredients appear once. This is the shopping-list payload.
   */
  ingredientsFor(dates: string[]): string[] {
    const seen = new Map<string, string>();
    for (const date of dates) {
      const meal = this.#data.meals.find((m) => m.id === this.#data.plan[date]);
      for (const ing of meal?.ingredients ?? []) {
        const key = normalizeIngredient(ing);
        if (key && !seen.has(key)) seen.set(key, ing.trim());
      }
    }
    return [...seen.values()];
  }

  /** Old plan entries are history nobody scrolls back to. */
  #prunePlan(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 31);
    const y = cutoff.getFullYear();
    const m = String(cutoff.getMonth() + 1).padStart(2, "0");
    const d = String(cutoff.getDate()).padStart(2, "0");
    const cutoffKey = `${y}-${m}-${d}`;
    for (const key of Object.keys(this.#data.plan)) {
      if (key < cutoffKey) delete this.#data.plan[key];
    }
  }

  async #persist(): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#data), "utf8");
      await rename(tmp, this.#file);
    } catch (err) {
      console.error("[meals] write failed", err);
    }
    for (const listener of this.#listeners) listener();
  }
}
