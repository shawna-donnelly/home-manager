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

/** How an ingredient is cut or prepped doesn't change what you buy. */
const PREP_WORDS =
  /\b(boneless|skinless|skin-on|bone-in|cooked|uncooked|raw|shredded|cubed|torn|trimmed|pounded|minced|chopped|diced|sliced|grated|crushed|melted|softened|beaten|divided|packed|drained|rinsed|undrained|undiluted|leftover|freshly|finely|thinly|roughly|coarsely)\b/g;

const UNIT_WORDS =
  /\b(cups?|tablespoons?|tbsps?|teaspoons?|tsps?|ounces?|oz|pounds?|lbs?|grams?|g|kg|ml|l|liters?|cans?|jars?|packages?|pkgs?|cloves?|sticks?|slices?|pinch(?:es)?|dash(?:es)?|bunch(?:es)?|heads?|ribs?|stalks?|quarts?|pints?|gallons?|small|medium|large|extra-large|about|approximately|optional)\b/g;

/**
 * Boil a recipe line down to the grocery item: "2 pounds ground beef
 * (* Note 1)" → "ground beef", "1 medium onion , chopped" → "onion".
 * Recipes write the same ingredient a dozen ways; shopping and
 * shared-ingredient matching must see through quantities and prep notes.
 */
export function coreIngredient(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/\(.*?\)/g, " "); // parentheticals: "(15 oz)", "(* Note 1)"

  // Poultry meat in any form — breasts, thighs, tenders, rotisserie,
  // "cooked and cubed" — is one grocery item. Broth/stock/soup are not.
  if (
    !/\b(broths?|stocks?|soups?|bouillon|base|gravy|flavor)\b/.test(s)
  ) {
    if (/\bchicken\b/.test(s)) return "chicken";
    if (/\bturkey\b/.test(s)) return "turkey";
  }

  s = s.replace(PREP_WORDS, " "); // "boneless skinless", "cooked shredded"
  const comma = s.indexOf(",");
  if (comma > 0) s = s.slice(0, comma); // prep: ", chopped", ", to taste"
  s = s.replace(/\bcut into .*$/, " ");
  s = s.replace(/[½⅓⅔¼¾⅛⅜⅝⅞]/g, " ");
  s = s.replace(/\d+(?:[./-]\d+)*/g, " "); // 2, 1.5, 1/2, 1-2
  s = s.replace(UNIT_WORDS, " ");
  s = s.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^of\s+/, "");
  return s;
}

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
   * The distinct grocery items across the given dates' planned meals —
   * shared ingredients appear once, as their core name ("ground beef"),
   * not any one recipe's "2 pounds ground beef (* Note 1)". This is the
   * shopping-list payload.
   */
  ingredientsFor(dates: string[]): string[] {
    const seen = new Map<string, string>();
    for (const date of dates) {
      const meal = this.#data.meals.find((m) => m.id === this.#data.plan[date]);
      for (const ing of meal?.ingredients ?? []) {
        const key = coreIngredient(ing);
        if (key && !seen.has(key)) {
          seen.set(key, key.charAt(0).toUpperCase() + key.slice(1));
        }
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
