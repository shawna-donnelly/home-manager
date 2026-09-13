import { useCallback, useEffect, useState } from "react";
import type { Meal, MealsView, ShoppingItem } from "./useEvents";

const PREP_WORDS =
  /\b(boneless|skinless|skin-on|bone-in|cooked|uncooked|raw|shredded|cubed|torn|trimmed|pounded|minced|chopped|diced|sliced|grated|crushed|melted|softened|beaten|divided|packed|drained|rinsed|undrained|undiluted|leftover|freshly|finely|thinly|roughly|coarsely)\b/g;

const UNIT_WORDS =
  /\b(cups?|tablespoons?|tbsps?|teaspoons?|tsps?|ounces?|oz|pounds?|lbs?|grams?|g|kg|ml|l|liters?|cans?|jars?|packages?|pkgs?|cloves?|sticks?|slices?|pinch(?:es)?|dash(?:es)?|bunch(?:es)?|heads?|ribs?|stalks?|quarts?|pints?|gallons?|small|medium|large|extra-large|about|approximately|optional)\b/g;

/**
 * Same normalizer as the server: "2 pounds ground beef (* Note 1)" →
 * "ground beef", so imported recipes' quantity-laden lines match.
 */
function normalize(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(/\(.*?\)/g, " ");
  if (!/\b(broths?|stocks?|soups?|bouillon|base|gravy|flavor)\b/.test(s)) {
    if (/\bchicken\b/.test(s)) return "chicken";
    if (/\bturkey\b/.test(s)) return "turkey";
  }
  s = s.replace(PREP_WORDS, " ");
  const comma = s.indexOf(",");
  if (comma > 0) s = s.slice(0, comma);
  s = s.replace(/\bcut into .*$/, " ");
  s = s.replace(/[½⅓⅔¼¾⅛⅜⅝⅞]/g, " ");
  s = s.replace(/\d+(?:[./-]\d+)*/g, " ");
  s = s.replace(UNIT_WORDS, " ");
  s = s.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^of\s+/, "");
  return s;
}

const FOOD_EMOJI: [RegExp, string][] = [
  [/taco|burrito|quesadilla|fajita/i, "🌮"],
  [/pizza/i, "🍕"],
  [/pasta|spaghetti|lasagn|mac.*cheese|noodle/i, "🍝"],
  [/burger/i, "🍔"],
  [/hot ?dog/i, "🌭"],
  [/chicken|wing/i, "🍗"],
  [/fish|salmon|shrimp|tuna/i, "🐟"],
  [/steak|beef|brisket|rib/i, "🥩"],
  [/soup|stew|chili/i, "🍲"],
  [/salad/i, "🥗"],
  [/sandwich|sub|wrap/i, "🥪"],
  [/rice|stir.?fry|fried rice/i, "🍚"],
  [/curry/i, "🍛"],
  [/sushi/i, "🍣"],
  [/pancake|waffle|breakfast|egg/i, "🥞"],
  [/pork|ham|bacon/i, "🥓"],
  [/potato/i, "🥔"],
];

export function foodEmoji(title: string): string {
  for (const [pattern, emoji] of FOOD_EMOJI) {
    if (pattern.test(title)) return emoji;
  }
  return "🍽️";
}

async function send(path: string, method: string, body?: object) {
  const res = await fetch(path, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return res.ok;
}

function dateKey(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** Today plus the next six days — the planning horizon on the wall. */
function weekDates(now: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    return d;
  });
}

export default function Meals({
  view,
  now,
  live,
}: {
  view: MealsView;
  now: Date;
  /** Shopping items pushed over SSE; fresher than this tab's own polling. */
  live?: ShoppingItem[];
}) {
  const days = weekDates(now);
  const [picking, setPicking] = useState<Date | null>(null);
  const [reading, setReading] = useState<Meal | null>(null);
  const [shopResult, setShopResult] = useState("");
  // The library is for occasional browsing/adding; day-to-day the tab is
  // planning + shopping. Resets to hidden whenever the tab remounts.
  const [showLibrary, setShowLibrary] = useState(false);
  const [emailResult, setEmailResult] = useState("");

  const [items, setItems] = useState<ShoppingItem[] | null>(null);
  const [shoppingDown, setShoppingDown] = useState(false);
  const loadShopping = useCallback(async () => {
    try {
      const res = await fetch("/api/shopping");
      if (!res.ok) {
        setShoppingDown(true);
        return;
      }
      setItems(((await res.json()) as { items: ShoppingItem[] }).items);
      setShoppingDown(false);
    } catch {
      setShoppingDown(true);
    }
  }, []);

  // The phone app edits the same list. HA pushes changes over SSE (`live`);
  // this slow poll is only the fallback when that subscription is down.
  useEffect(() => {
    void loadShopping();
    const timer = window.setInterval(() => void loadShopping(), 60_000);
    return () => window.clearInterval(timer);
  }, [loadShopping]);

  useEffect(() => {
    if (live) {
      setItems(live);
      setShoppingDown(false);
    }
  }, [live]);

  const mealsFor = (day: Date): Meal[] =>
    (view.plan[dateKey(day)] ?? [])
      .map((id) => view.meals.find((m) => m.id === id))
      .filter((m): m is Meal => Boolean(m));

  // Ingredients used by 2+ planned meals this week — the buy-once savings.
  const shared = (() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const day of days) {
      for (const meal of mealsFor(day)) {
        for (const ing of meal.ingredients) {
          const key = normalize(ing);
          if (!key) continue;
          const entry = counts.get(key) ?? {
            label: key.charAt(0).toUpperCase() + key.slice(1),
            count: 0,
          };
          entry.count += 1;
          counts.set(key, entry);
        }
      }
    }
    return [...counts.values()]
      .filter((e) => e.count >= 2)
      .sort((a, b) => b.count - a.count);
  })();

  const plannedDates = days
    .filter((d) => mealsFor(d).length > 0)
    .map(dateKey);

  const pushIngredients = async () => {
    setShopResult("…");
    const res = await fetch("/api/mealplan/shop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dates: plannedDates }),
    });
    if (!res.ok) {
      setShopResult("couldn't reach the list");
      return;
    }
    const { added, skipped } = (await res.json()) as {
      added: number;
      skipped: number;
    };
    setShopResult(
      `added ${added}${skipped > 0 ? `, ${skipped} already on the list` : ""}`,
    );
    void loadShopping();
  };

  return (
    <div
      className={`board board--meals${showLibrary ? "" : " board--meals-compact"}`}
    >
      <section className="board__col">
        <h2 className="board__heading board__heading--row">
          <span>🗓️ Dinner this week</span>
          <button
            type="button"
            className="nav__button meals__toggle"
            onClick={() => setShowLibrary((v) => !v)}
          >
            {showLibrary ? "Hide recipes" : "📖 Recipes"}
          </button>
        </h2>
        <ul className="tasklist">
          {days.map((day) => {
            const dayMeals = mealsFor(day);
            return (
              <li key={day.toISOString()} className="mealday">
                <span className="mealday__name">
                  {day.toLocaleDateString(undefined, {
                    weekday: "short",
                    day: "numeric",
                  })}
                </span>
                <button
                  type="button"
                  className="mealday__meal"
                  onClick={() => setPicking(day)}
                >
                  {dayMeals.length > 0 ? (
                    <span className="mealday__list">
                      {dayMeals.map((meal) => (
                        <span key={meal.id} className="mealday__one">
                          <span className="task__emoji">
                            {foodEmoji(meal.title)}
                          </span>
                          {meal.title}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="mealday__empty">+ pick a meal</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {shared.length > 0 && (
          <p className="meals__shared">
            🔁 Shared this week:{" "}
            {shared.map((e) => `${e.label} ×${e.count}`).join(", ")}
          </p>
        )}
        {plannedDates.length > 0 && !shoppingDown && (
          <div className="meals__shoprow">
            <button
              type="button"
              className="nav__button"
              onClick={() => void pushIngredients()}
            >
              🛒 Ingredients → list
            </button>
            {shopResult && <span className="meals__result">{shopResult}</span>}
          </div>
        )}
      </section>

      {showLibrary && (
      <section className="board__col">
        <h2 className="board__heading">🍽️ Meals</h2>
        <ul className="tasklist">
          {view.meals.map((meal) => (
            <li key={meal.id} className="task">
              <span
                className="task__title"
                onClick={() => setReading(meal)}
                role="button"
              >
                <span className="task__emoji">{foodEmoji(meal.title)}</span>
                {meal.title}
                <span className="meal__count">
                  {" "}
                  · {meal.ingredients.length} ingredient
                  {meal.ingredients.length === 1 ? "" : "s"}
                  {meal.recipe ? " · 📖" : ""}
                </span>
              </span>
              <button
                type="button"
                className="task__remove"
                onClick={() => void send(`/api/meals/${meal.id}`, "DELETE")}
                aria-label={`Remove ${meal.title}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <AddMeal />
      </section>
      )}

      <section className="board__col">
        <h2 className="board__heading board__heading--row">
          <span>🛒 Shopping list</span>
          {!shoppingDown && (items?.length ?? 0) > 0 && (
            <button
              type="button"
              className="nav__button meals__toggle"
              onClick={async () => {
                const res = await fetch("/api/shopping/email", {
                  method: "POST",
                });
                setEmailResult(res.ok ? "sent ✓" : "email not set up");
              }}
            >
              ✉️ Email list
            </button>
          )}
        </h2>
        {emailResult && <p className="meals__result">{emailResult}</p>}
        {shoppingDown ? (
          <p className="meals__result">
            Shopping list lives in Home Assistant — not reachable right now.
          </p>
        ) : (
          <>
            <ul className="tasklist">
              {(items ?? []).map((item) => (
                <li
                  key={item.uid}
                  className={`task${item.done ? " task--done" : ""}`}
                >
                  <button
                    type="button"
                    className="task__check"
                    onClick={async () => {
                      await send(`/api/shopping/${item.uid}/toggle`, "POST", {
                        done: !item.done,
                      });
                      void loadShopping();
                    }}
                    aria-label={`Toggle ${item.summary}`}
                  >
                    {item.done ? "✓" : ""}
                  </button>
                  <span className="task__title">{item.summary}</span>
                  <button
                    type="button"
                    className="task__remove"
                    onClick={async () => {
                      await send(`/api/shopping/${item.uid}`, "DELETE");
                      void loadShopping();
                    }}
                    aria-label={`Remove ${item.summary}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <AddShoppingItem onAdded={loadShopping} />
          </>
        )}
      </section>

      {reading && (
        <RecipeView meal={reading} onClose={() => setReading(null)} />
      )}

      {picking && (
        <MealPicker
          day={picking}
          view={view}
          otherPlanned={days
            .filter((d) => dateKey(d) !== dateKey(picking))
            .flatMap(mealsFor)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

/**
 * Meal chooser for one day. Pick as many meals as the dinner needs (ribs AND
 * potatoes); a search box filters the library, and meals that share
 * ingredients with the rest of the week float to the top — picking those is
 * what saves money. Selections persist as you toggle; close when done.
 */
function MealPicker({
  day,
  view,
  otherPlanned,
  onClose,
}: {
  day: Date;
  view: MealsView;
  otherPlanned: Meal[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // Local mirror of the day's selection so toggles feel instant; seeded from
  // the server view and kept in sync as SSE frames update `view`.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(view.plan[dateKey(day)] ?? []),
  );
  useEffect(() => {
    setSelected(new Set(view.plan[dateKey(day)] ?? []));
  }, [view, day]);

  const weekIngredients = new Set(
    otherPlanned.flatMap((m) => m.ingredients.map(normalize)),
  );
  const overlap = (meal: Meal): number =>
    new Set(
      meal.ingredients.map(normalize).filter((i) => weekIngredients.has(i)),
    ).size;

  const q = query.trim().toLowerCase();
  const titleHit = (m: Meal) => m.title.toLowerCase().includes(q);
  const shown = [...view.meals]
    .filter(
      (m) =>
        !q ||
        titleHit(m) ||
        m.ingredients.some((i) => i.toLowerCase().includes(q)),
    )
    .sort((a, b) => {
      // Keep what's already chosen for this day pinned at the top.
      const as = selected.has(a.id) ? 1 : 0;
      const bs = selected.has(b.id) ? 1 : 0;
      if (as !== bs) return bs - as;
      // When searching, a name match beats an ingredient-only match.
      if (q) {
        const at = titleHit(a) ? 1 : 0;
        const bt = titleHit(b) ? 1 : 0;
        if (at !== bt) return bt - at;
      }
      return overlap(b) - overlap(a);
    });

  const toggle = async (meal: Meal) => {
    const on = selected.has(meal.id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.delete(meal.id);
      else next.add(meal.id);
      return next;
    });
    await send("/api/mealplan", "POST", {
      date: dateKey(day),
      mealId: meal.id,
      action: on ? "remove" : "add",
    });
  };

  const clearDay = async () => {
    setSelected(new Set());
    await send("/api/mealplan", "POST", { date: dateKey(day), action: "clear" });
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="add" onClick={(e) => e.stopPropagation()}>
        <h3 className="add__heading">
          {day.toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
          })}
          {selected.size > 0 && (
            <span className="mealpicker__count"> · {selected.size} chosen</span>
          )}
        </h3>
        <input
          className="add__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search recipes…"
          autoFocus
        />
        {view.meals.length === 0 && (
          <p className="meals__result">Add some meals first →</p>
        )}
        {view.meals.length > 0 && shown.length === 0 && (
          <p className="meals__result">No recipes match “{query}”.</p>
        )}
        <ul className="tasklist mealpicker">
          {shown.map((meal) => {
            const on = selected.has(meal.id);
            const shares = overlap(meal);
            return (
              <li key={meal.id}>
                <button
                  type="button"
                  className={`mealpicker__option${
                    on ? " mealpicker__option--current" : ""
                  }`}
                  onClick={() => void toggle(meal)}
                >
                  <span className="mealpicker__check">{on ? "✓" : ""}</span>
                  <span className="task__emoji">{foodEmoji(meal.title)}</span>
                  {meal.title}
                  {shares > 0 && (
                    <span className="mealpicker__shares">
                      🔁 shares {shares}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="add__actions">
          {selected.size > 0 && (
            <button
              type="button"
              className="nav__button"
              onClick={() => void clearDay()}
            >
              Clear day
            </button>
          )}
          <button type="button" className="nav__button add__save" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** The whole recipe, big enough to cook from across the kitchen. */
function RecipeView({ meal, onClose }: { meal: Meal; onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="add recipe" onClick={(e) => e.stopPropagation()}>
        <h3 className="add__heading">
          <span className="task__emoji">{foodEmoji(meal.title)}</span>
          {meal.title}
        </h3>
        <div className="recipe__body">
          {meal.ingredients.length > 0 && (
            <>
              <p className="recipe__section">Ingredients</p>
              <ul className="recipe__ingredients">
                {meal.ingredients.map((ing) => (
                  <li key={ing}>{ing}</li>
                ))}
              </ul>
            </>
          )}
          {meal.recipe && (
            <>
              <p className="recipe__section">Recipe</p>
              <p className="recipe__text">{meal.recipe}</p>
            </>
          )}
          {!meal.recipe && meal.ingredients.length === 0 && (
            <p className="meals__result">No details for this meal yet.</p>
          )}
        </div>
        <div className="add__actions">
          <button type="button" className="nav__button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function AddMeal() {
  const [title, setTitle] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [recipe, setRecipe] = useState("");

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const list = ingredients
      .split(",")
      .map((i) => i.trim())
      .filter(Boolean);
    const body = {
      title: trimmed,
      ingredients: list,
      ...(recipe.trim() ? { recipe: recipe.trim() } : {}),
    };
    if (await send("/api/meals", "POST", body)) {
      setTitle("");
      setIngredients("");
      setRecipe("");
    }
  };

  return (
    <div className="meal-add">
      <input
        className="add__input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Meal name"
      />
      <input
        className="add__input"
        value={ingredients}
        onChange={(e) => setIngredients(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="Ingredients, separated by commas"
      />
      <textarea
        className="add__input meal-add__recipe"
        value={recipe}
        onChange={(e) => setRecipe(e.target.value)}
        placeholder="Recipe / instructions (optional)"
        rows={2}
      />
      <button
        type="button"
        className="nav__button"
        onClick={() => void submit()}
      >
        Add meal
      </button>
    </div>
  );
}

function AddShoppingItem({ onAdded }: { onAdded: () => Promise<void> }) {
  const [title, setTitle] = useState("");

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (await send("/api/shopping", "POST", { title: trimmed })) {
      setTitle("");
      await onAdded();
    }
  };

  return (
    <div className="task-add">
      <input
        className="add__input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="Add item"
      />
      <button
        type="button"
        className="nav__button"
        onClick={() => void submit()}
      >
        +
      </button>
    </div>
  );
}
