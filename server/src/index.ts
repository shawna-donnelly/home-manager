import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import {
  CHORE_PIN,
  CHORE_REPORT_TIME,
  DATA_DIR,
  GPHOTOS_ALBUM_URL,
  PHOTO_SYNC_MS,
  KIDS,
  PARENTS,
  PHOTOS_DIR,
  PORT,
  REWARDS,
  loadEmailConfig,
  loadSensorSources,
  loadShoppingList,
  loadSources,
  startShoppingWatch,
} from "./config.js";
import type { ShoppingItem } from "./sources/homeassistant.js";
import { MealStore, coreIngredient } from "./meals.js";
import { startPhotoSync } from "./photosync.js";
import { createNotifier, scheduleDailyChoreReport } from "./notify.js";
import { Poller } from "./poller.js";
import { TaskStore } from "./tasks.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");

const app = Fastify({ logger: { level: "info" } });
const calendarSources = loadSources();
const poller = new Poller(calendarSources, loadSensorSources());
const tasks = new TaskStore(
  DATA_DIR,
  KIDS,
  PARENTS,
  CHORE_PIN.length > 0,
  REWARDS,
);
const notifier = createNotifier(loadEmailConfig());
const meals = new MealStore(DATA_DIR);
const shopping = loadShoppingList();

/** Latest shopping items pushed by HA's websocket; null until it delivers. */
let shoppingLive: ShoppingItem[] | null = null;
const shoppingListeners = new Set<() => void>();

/** One frame for the SSE stream: calendar snapshot plus chores/todos/meals. */
const frame = () => ({
  ...poller.snapshot,
  tasks: tasks.view(),
  meals: meals.view(),
  ...(shoppingLive ? { shopping: shoppingLive } : {}),
});

app.get("/api/health", async () => ({
  ok: true,
  fetchedAt: poller.snapshot.fetchedAt,
  eventCount: poller.snapshot.events.length,
  sensorCount: poller.snapshot.sensors.length,
  degraded: poller.snapshot.degraded,
  uptimeSeconds: Math.round(process.uptime()),
}));

app.get("/api/events", async () => poller.snapshot);

/** The calendars, so the UI can render a picker; writable = accepts new events. */
app.get("/api/sources", async () =>
  calendarSources.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    writable: Boolean(s.createEvent),
  })),
);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

app.post("/api/events", async (request, reply) => {
  const body = request.body as {
    sourceId?: unknown;
    title?: unknown;
    allDay?: unknown;
    start?: unknown;
    end?: unknown;
    timeZone?: unknown;
  } | null;

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const { sourceId, allDay, start, end, timeZone } = body ?? {};
  if (
    !title ||
    title.length > 200 ||
    typeof sourceId !== "string" ||
    typeof allDay !== "boolean" ||
    typeof start !== "string" ||
    typeof end !== "string"
  ) {
    return reply.code(400).send({ error: "invalid event payload" });
  }

  // Timed events are wall-clock strings in an explicit zone; same format on
  // both ends, so lexicographic order is chronological order.
  const ordered = allDay
    ? DATE_ONLY.test(start) && DATE_ONLY.test(end) && start < end
    : WALL_CLOCK.test(start) &&
      WALL_CLOCK.test(end) &&
      start < end &&
      typeof timeZone === "string" &&
      isValidTimeZone(timeZone);
  if (!ordered) {
    return reply.code(400).send({ error: "invalid start/end/timeZone" });
  }

  const source = calendarSources.find((s) => s.id === sourceId);
  if (!source?.createEvent) {
    return reply.code(400).send({ error: "unknown or read-only calendar" });
  }

  try {
    await source.createEvent({
      title,
      allDay,
      start,
      end,
      ...(allDay ? {} : { timeZone: timeZone as string }),
    });
  } catch (err) {
    request.log.error({ err }, "event create failed");
    return reply.code(502).send({ error: String(err instanceof Error ? err.message : err) });
  }

  // Pull the fresh snapshot so every open display sees the event immediately.
  await poller.refresh();
  return { ok: true };
});

/** Force a refresh without waiting for the interval. Useful while developing. */
app.post("/api/refresh", async () => {
  await poller.refresh();
  return poller.snapshot;
});

/**
 * SSE stream. The display holds this open indefinitely, so a keepalive comment
 * every 20s keeps intermediaries from reaping an idle connection.
 */
app.get("/api/stream", (request, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (snapshot: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };

  send(frame());
  const unsubPoller = poller.subscribe(() => send(frame()));
  const unsubTasks = tasks.subscribe(() => send(frame()));
  const unsubMeals = meals.subscribe(() => send(frame()));
  const shoppingListener = () => send(frame());
  shoppingListeners.add(shoppingListener);
  const keepalive = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);

  request.raw.on("close", () => {
    clearInterval(keepalive);
    unsubPoller();
    unsubTasks();
    unsubMeals();
    shoppingListeners.delete(shoppingListener);
  });
});

app.get("/api/tasks", async () => tasks.view());

const cleanTitle = (raw: unknown): string | null => {
  const title = typeof raw === "string" ? raw.trim() : "";
  return title && title.length <= 100 ? title : null;
};

app.post("/api/chores", async (request, reply) => {
  const body = request.body as {
    kid?: unknown;
    title?: unknown;
    cadence?: unknown;
    days?: unknown;
  } | null;
  const title = cleanTitle(body?.title);
  const cadence = body?.cadence ?? "daily";
  if (
    !title ||
    typeof body?.kid !== "string" ||
    (cadence !== "daily" && cadence !== "weekly" && cadence !== "days")
  ) {
    return reply.code(400).send({ error: "invalid chore" });
  }
  let days: number[] | undefined;
  if (cadence === "days") {
    const raw = body?.days;
    const valid =
      Array.isArray(raw) &&
      raw.length > 0 &&
      raw.length <= 7 &&
      raw.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!valid) {
      return reply.code(400).send({ error: "days must list weekdays 0-6" });
    }
    days = [...new Set(raw as number[])].sort();
  }
  if (!(await tasks.addChore(body.kid, title, cadence, days))) {
    return reply.code(400).send({ error: "unknown kid" });
  }
  return { ok: true };
});

app.post("/api/chores/:id/toggle", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await tasks.toggleChore(id))) {
    return reply.code(404).send({ error: "no such chore" });
  }
  return { ok: true };
});

app.delete("/api/chores/:id", async (request, reply) => {
  if (CHORE_PIN && request.headers["x-pin"] !== CHORE_PIN) {
    return reply.code(403).send({ error: "wrong passcode" });
  }
  const { id } = request.params as { id: string };
  const chore = tasks.view().chores.find((c) => c.id === id);
  if (!chore || !(await tasks.removeChore(id))) {
    return reply.code(404).send({ error: "no such chore" });
  }
  void notifier.send(
    `Chore removed: ${chore.title} (${chore.kid})`,
    `"${chore.title}" was removed from ${chore.kid}'s chart at ` +
      `${new Date().toLocaleString()}.`,
  );
  return { ok: true };
});

app.post("/api/redeem", async (request, reply) => {
  const body = request.body as { kid?: unknown; reward?: unknown } | null;
  const { kid, reward } = body ?? {};
  if (typeof kid !== "string" || typeof reward !== "string") {
    return reply.code(400).send({ error: "invalid redemption" });
  }
  const result = await tasks.redeem(kid, reward);
  if (result === "unknown") {
    return reply.code(400).send({ error: "unknown kid or reward" });
  }
  if (result === "incomplete") {
    return reply.code(409).send({ error: "the week isn't finished yet" });
  }
  if (result === "already") {
    return reply.code(409).send({ error: "already redeemed this week" });
  }
  const points = tasks.view().points.find((p) => p.kid === kid);
  void notifier.send(
    `🏆 ${kid} earned their reward: ${reward}`,
    `${kid} finished every chore this week (${points?.earned ?? "?"} points) ` +
      `and chose ${reward}. Time to pay up!`,
  );
  return { ok: true };
});

app.get("/api/meals", async () => meals.view());

app.post("/api/meals", async (request, reply) => {
  const body = request.body as {
    title?: unknown;
    ingredients?: unknown;
    recipe?: unknown;
  } | null;
  const title = cleanTitle(body?.title);
  const raw = body?.ingredients;
  const ingredients =
    Array.isArray(raw) && raw.every((i) => typeof i === "string")
      ? (raw as string[]).map((i) => i.trim()).filter(Boolean)
      : null;
  const recipe = body?.recipe;
  const recipeOk =
    recipe === undefined ||
    (typeof recipe === "string" && recipe.length <= 50_000);
  if (!title || !ingredients || ingredients.length > 40 || !recipeOk) {
    return reply.code(400).send({ error: "invalid meal" });
  }
  return {
    ok: true,
    meal: await meals.addMeal(title, ingredients, recipe as string | undefined),
  };
});

app.delete("/api/meals/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await meals.removeMeal(id))) {
    return reply.code(404).send({ error: "no such meal" });
  }
  return { ok: true };
});

app.post("/api/mealplan", async (request, reply) => {
  const body = request.body as { date?: unknown; mealId?: unknown } | null;
  const { date, mealId } = body ?? {};
  if (
    typeof date !== "string" ||
    !DATE_ONLY.test(date) ||
    (mealId !== null && typeof mealId !== "string")
  ) {
    return reply.code(400).send({ error: "invalid plan" });
  }
  if (!(await meals.planMeal(date, mealId as string | null))) {
    return reply.code(404).send({ error: "no such meal" });
  }
  return { ok: true };
});

/**
 * Push the planned meals' ingredients onto the shopping list. Shared
 * ingredients go on once, and anything already on the list is skipped —
 * repeat pushes are safe.
 */
app.post("/api/mealplan/shop", async (request, reply) => {
  if (!shopping) {
    return reply.code(503).send({ error: "no shopping list configured" });
  }
  const raw = (request.body as { dates?: unknown } | null)?.dates;
  const dates =
    Array.isArray(raw) &&
    raw.length <= 31 &&
    raw.every((d) => typeof d === "string" && DATE_ONLY.test(d))
      ? (raw as string[])
      : null;
  if (!dates) return reply.code(400).send({ error: "invalid dates" });

  try {
    const existing = new Set(
      (await shopping.getItems()).map((i) => coreIngredient(i.summary)),
    );
    const wanted = meals.ingredientsFor(dates);
    const missing = wanted.filter((i) => !existing.has(coreIngredient(i)));
    for (const item of missing) await shopping.add(item);
    return { ok: true, added: missing.length, skipped: wanted.length - missing.length };
  } catch (err) {
    request.log.error({ err }, "shopping push failed");
    return reply.code(502).send({ error: "home assistant unreachable" });
  }
});

app.get("/api/shopping", async (_request, reply) => {
  if (!shopping) {
    return reply.code(503).send({ error: "no shopping list configured" });
  }
  try {
    return { items: await shopping.getItems() };
  } catch (err) {
    return reply.code(502).send({ error: "home assistant unreachable" });
  }
});

app.post("/api/shopping", async (request, reply) => {
  if (!shopping) {
    return reply.code(503).send({ error: "no shopping list configured" });
  }
  const title = cleanTitle((request.body as { title?: unknown } | null)?.title);
  if (!title) return reply.code(400).send({ error: "invalid item" });
  try {
    await shopping.add(title);
    return { ok: true };
  } catch (err) {
    return reply.code(502).send({ error: "home assistant unreachable" });
  }
});

app.post("/api/shopping/:uid/toggle", async (request, reply) => {
  if (!shopping) {
    return reply.code(503).send({ error: "no shopping list configured" });
  }
  const { uid } = request.params as { uid: string };
  const done = (request.body as { done?: unknown } | null)?.done;
  if (typeof done !== "boolean") {
    return reply.code(400).send({ error: "done must be boolean" });
  }
  try {
    await shopping.setStatus(uid, done);
    return { ok: true };
  } catch (err) {
    return reply.code(502).send({ error: "home assistant unreachable" });
  }
});

app.delete("/api/shopping/:uid", async (request, reply) => {
  if (!shopping) {
    return reply.code(503).send({ error: "no shopping list configured" });
  }
  const { uid } = request.params as { uid: string };
  try {
    await shopping.remove(uid);
    return { ok: true };
  } catch (err) {
    return reply.code(502).send({ error: "home assistant unreachable" });
  }
});

/** The open (unchecked) items as a phone-friendly text list. */
const shoppingText = async (): Promise<string> => {
  if (!shopping) throw new Error("no shopping list configured");
  const open = (await shopping.getItems()).filter((i) => !i.done);
  return open.length > 0
    ? open.map((i) => `• ${i.summary}`).join("\n")
    : "Nothing on the list 🎉";
};

/** Plain text for Apple Shortcuts / copy-paste ("save my list to Notes"). */
app.get("/api/shopping.txt", async (_request, reply) => {
  if (!shopping) {
    return reply.code(503).send("no shopping list configured");
  }
  try {
    return await reply
      .type("text/plain; charset=utf-8")
      .send(`Shopping list — ${new Date().toLocaleDateString()}\n${await shoppingText()}\n`);
  } catch {
    return reply.code(502).send("home assistant unreachable");
  }
});

app.post("/api/shopping/email", async (request, reply) => {
  if (!shopping) {
    return reply.code(503).send({ error: "no shopping list configured" });
  }
  if (!notifier.enabled) {
    return reply.code(503).send({ error: "email not configured" });
  }
  try {
    await notifier.send("🛒 Shopping list", await shoppingText());
    return { ok: true };
  } catch (err) {
    request.log.error({ err }, "shopping email failed");
    return reply.code(502).send({ error: "home assistant unreachable" });
  }
});

app.post("/api/todos", async (request, reply) => {
  const title = cleanTitle((request.body as { title?: unknown } | null)?.title);
  if (!title) return reply.code(400).send({ error: "invalid todo" });
  await tasks.addTodo(title);
  return { ok: true };
});

app.post("/api/todos/:id/toggle", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await tasks.toggleTodo(id))) {
    return reply.code(404).send({ error: "no such todo" });
  }
  return { ok: true };
});

app.delete("/api/todos/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!(await tasks.removeTodo(id))) {
    return reply.code(404).send({ error: "no such todo" });
  }
  return { ok: true };
});

// Dashboard photo frame: images dropped into PHOTOS_DIR, served as-is.
const photosRoot = resolve(PHOTOS_DIR);
await mkdir(photosRoot, { recursive: true });
await app.register(fastifyStatic, {
  root: photosRoot,
  prefix: "/photos/",
  decorateReply: false,
});

const PHOTO_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

app.get("/api/photos", async () => {
  try {
    const files = await readdir(photosRoot);
    return { photos: files.filter((f) => PHOTO_EXT.test(f)).sort() };
  } catch {
    return { photos: [] };
  }
});

if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // Single page — anything unmatched returns the shell.
  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
} else {
  app.log.warn(`no web build at ${webDist}; run "npm run build" in web/`);
}

// Loading is read-only; do it before the bind so routes never see an empty
// store. Then bind BEFORE anything writes: if another instance owns the port,
// exit before touching any data file. A second live instance persisting its
// own stale state would overwrite the real server's writes (split-brain on
// tasks.json — observed, not hypothetical). Listening before the first poll
// also serves the cached view seconds sooner on a cold boot.
await tasks.load();
await meals.load();
await app.listen({ port: PORT, host: "0.0.0.0" });
await poller.start();
scheduleDailyChoreReport(notifier, () => tasks.view(), CHORE_REPORT_TIME);
const stopShoppingWatch = startShoppingWatch((items) => {
  shoppingLive = items;
  for (const listener of shoppingListeners) listener();
});
const stopPhotoSync = GPHOTOS_ALBUM_URL
  ? startPhotoSync({
      albumUrl: GPHOTOS_ALBUM_URL,
      dir: photosRoot,
      intervalMs: PHOTO_SYNC_MS,
    })
  : null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    poller.stop();
    stopShoppingWatch?.();
    stopPhotoSync?.();
    void app.close().then(() => process.exit(0));
  });
}
