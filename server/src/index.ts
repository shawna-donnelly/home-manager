import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { PORT, loadSensorSources, loadSources } from "./config.js";
import { Poller } from "./poller.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");

const app = Fastify({ logger: { level: "info" } });
const calendarSources = loadSources();
const poller = new Poller(calendarSources, loadSensorSources());

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

  send(poller.snapshot);
  const unsubscribe = poller.subscribe(send);
  const keepalive = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);

  request.raw.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // Single page — anything unmatched returns the shell.
  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
} else {
  app.log.warn(`no web build at ${webDist}; run "npm run build" in web/`);
}

await poller.start();
await app.listen({ port: PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    poller.stop();
    void app.close().then(() => process.exit(0));
  });
}
