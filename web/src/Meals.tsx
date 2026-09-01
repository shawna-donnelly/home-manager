import { useCallback, useEffect, useState } from "react";
import type { Meal, MealsView, ShoppingItem } from "./useEvents";

const normalize = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\s+/g, " ");

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

function foodEmoji(title: string): string {
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

export default function Meals({ view, now }: { view: MealsView; now: Date }) {
  const days = weekDates(now);
  const [picking, setPicking] = useState<Date | null>(null);
  const [shopResult, setShopResult] = useState("");

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

  // The phone app edits the same list, so refresh while the tab is showing.
  useEffect(() => {
    void loadShopping();
    const timer = window.setInterval(() => void loadShopping(), 60_000);
    return () => window.clearInterval(timer);
  }, [loadShopping]);

  const mealFor = (day: Date): Meal | undefined =>
    view.meals.find((m) => m.id === view.plan[dateKey(day)]);

  // Ingredients used by 2+ planned meals this week — the buy-once savings.
  const shared = (() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const day of days) {
      for (const ing of mealFor(day)?.ingredients ?? []) {
        const key = normalize(ing);
        const entry = counts.get(key) ?? { label: ing.trim(), count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
    return [...counts.values()]
      .filter((e) => e.count >= 2)
      .sort((a, b) => b.count - a.count);
  })();

  const plannedDates = days.filter(mealFor).map(dateKey);

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
    <div className="board board--meals">
      <section className="board__col">
        <h2 className="board__heading">🗓️ Dinner this week</h2>
        <ul className="tasklist">
          {days.map((day) => {
            const meal = mealFor(day);
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
                  {meal ? (
                    <>
                      <span className="task__emoji">
                        {foodEmoji(meal.title)}
                      </span>
                      {meal.title}
                    </>
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

      <section className="board__col">
        <h2 className="board__heading">🍽️ Meals</h2>
        <ul className="tasklist">
          {view.meals.map((meal) => (
            <li key={meal.id} className="task">
              <span className="task__title">
                <span className="task__emoji">{foodEmoji(meal.title)}</span>
                {meal.title}
                <span className="meal__count">
                  {" "}
                  · {meal.ingredients.length} ingredient
                  {meal.ingredients.length === 1 ? "" : "s"}
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

      <section className="board__col">
        <h2 className="board__heading">🛒 Shopping list</h2>
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

      {picking && (
        <MealPicker
          day={picking}
          view={view}
          otherPlanned={days
            .filter((d) => dateKey(d) !== dateKey(picking))
            .map(mealFor)
            .filter((m): m is Meal => Boolean(m))}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

/**
 * Meal chooser for one day, sorted so meals sharing ingredients with the rest
 * of the week float to the top — picking those is what saves money.
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
  const weekIngredients = new Set(
    otherPlanned.flatMap((m) => m.ingredients.map(normalize)),
  );
  const overlap = (meal: Meal): number =>
    new Set(
      meal.ingredients.map(normalize).filter((i) => weekIngredients.has(i)),
    ).size;

  const sorted = [...view.meals].sort((a, b) => overlap(b) - overlap(a));
  const planned = view.plan[dateKey(day)];

  const choose = async (mealId: string | null) => {
    await send("/api/mealplan", "POST", { date: dateKey(day), mealId });
    onClose();
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
        </h3>
        {sorted.length === 0 && (
          <p className="meals__result">Add some meals first →</p>
        )}
        <ul className="tasklist mealpicker">
          {sorted.map((meal) => {
            const shares = overlap(meal);
            return (
              <li key={meal.id}>
                <button
                  type="button"
                  className={`mealpicker__option${
                    meal.id === planned ? " mealpicker__option--current" : ""
                  }`}
                  onClick={() => void choose(meal.id)}
                >
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
          {planned && (
            <button
              type="button"
              className="nav__button"
              onClick={() => void choose(null)}
            >
              Clear day
            </button>
          )}
          <button type="button" className="nav__button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function AddMeal() {
  const [title, setTitle] = useState("");
  const [ingredients, setIngredients] = useState("");

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const list = ingredients
      .split(",")
      .map((i) => i.trim())
      .filter(Boolean);
    if (await send("/api/meals", "POST", { title: trimmed, ingredients: list })) {
      setTitle("");
      setIngredients("");
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
