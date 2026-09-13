/**
 * Recipe importer MCP server for home-manager.
 *
 * Gives a Claude account tools to add and plan meals; Claude does the parsing
 * (a cookbook photo, pasted text, or a recipe URL → structured recipe) and
 * calls these tools, which persist through home-manager's meal API. Keeping
 * the parsing on Claude's side means no scraper to maintain and no per-recipe
 * API bill — it rides the user's own Claude subscription.
 *
 * Stateless Streamable HTTP: a fresh server+transport per request, so there's
 * no session bookkeeping. Bearer-token auth gates every call.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API = (process.env.HOME_MANAGER_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const TOKEN = process.env.MCP_TOKEN ?? "";
const PORT = Number(process.env.MCP_PORT ?? 8790);

if (!TOKEN) {
  console.error("[mcp] refusing to start: set MCP_TOKEN to a strong secret");
  process.exit(1);
}

interface Meal {
  id: string;
  title: string;
  ingredients: string[];
  recipe?: string;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

async function apiPost(path: string, body: object): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} returned ${res.status} ${text}`.trim());
  }
  return res.json();
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Build a fresh server with the recipe tools registered. */
function buildServer(): McpServer {
  const server = new McpServer({
    name: "home-manager-recipes",
    version: "0.1.0",
  });

  server.registerTool(
    "list_recipes",
    {
      title: "List saved recipes",
      description:
        "List the meals already in the family library (titles and ingredient " +
        "counts). Call this before add_recipe to avoid duplicates.",
      inputSchema: {},
    },
    async () => {
      const { meals } = (await apiGet("/api/meals")) as { meals: Meal[] };
      const lines = meals
        .map((m) => `• ${m.title} (${m.ingredients.length} ingredients)`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: meals.length
              ? `${meals.length} recipes:\n${lines}`
              : "The library is empty.",
          },
        ],
      };
    },
  );

  server.registerTool(
    "add_recipe",
    {
      title: "Add a recipe",
      description:
        "Add a meal to the family library. Parse the recipe (from a photo, " +
        "pasted text, or a webpage) into a clean title, a list of ingredient " +
        "lines, and the full instructions before calling. Ingredients should " +
        "be one per entry, e.g. '2 cups flour'. Skips if a meal with the same " +
        "title already exists.",
      inputSchema: {
        title: z.string().min(1).max(100).describe("The dish name"),
        ingredients: z
          .array(z.string())
          .describe("Ingredient lines, one per entry"),
        recipe: z
          .string()
          .optional()
          .describe("Full instructions / method, as plain text"),
      },
    },
    async ({ title, ingredients, recipe }) => {
      const { meals } = (await apiGet("/api/meals")) as { meals: Meal[] };
      if (meals.some((m) => norm(m.title) === norm(title))) {
        return {
          content: [
            { type: "text", text: `"${title}" is already in the library — skipped.` },
          ],
        };
      }
      const clean = ingredients.map((i) => i.trim()).filter(Boolean);
      await apiPost("/api/meals", {
        title: title.trim(),
        ingredients: clean,
        ...(recipe?.trim() ? { recipe: recipe.trim() } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `Added "${title}" with ${clean.length} ingredients${
              recipe?.trim() ? " and full instructions" : ""
            }. It's on the wall now.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "plan_meal",
    {
      title: "Plan a meal for a day",
      description:
        "Put a saved meal on the dinner calendar for a date (YYYY-MM-DD). The " +
        "meal must already exist (use add_recipe first).",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
        title: z.string().min(1).describe("Title of an existing meal"),
      },
    },
    async ({ date, title }) => {
      const { meals } = (await apiGet("/api/meals")) as { meals: Meal[] };
      const meal = meals.find((m) => norm(m.title) === norm(title));
      if (!meal) {
        return {
          content: [
            {
              type: "text",
              text: `No saved meal called "${title}". Add it first with add_recipe.`,
            },
          ],
          isError: true,
        };
      }
      await apiPost("/api/mealplan", { date, mealId: meal.id, action: "add" });
      return {
        content: [{ type: "text", text: `Planned "${meal.title}" for ${date}.` }],
      };
    },
  );

  return server;
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Auth two ways so it works with every client:
  //   • header  — Authorization: Bearer <token>   (Claude Code / Desktop)
  //   • in-path — POST /mcp/<token>                (claude.ai connectors, which
  //     take only a URL). Over HTTPS the long random path IS the secret.
  const path = (req.url ?? "").split("?")[0];
  const headerOk = (req.headers.authorization ?? "") === `Bearer ${TOKEN}`;
  const pathOk = path === `/mcp/${TOKEN}`;
  if (path !== "/mcp" && !pathOk) {
    res.writeHead(404).end();
    return;
  }
  if (!headerOk && !pathOk) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // Buffer the JSON body for POST.
  let body: unknown;
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    body = raw ? JSON.parse(raw) : undefined;
  }

  const mcp = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});

server.listen(PORT, () => {
  console.log(`[mcp] recipe importer on :${PORT} → ${API}`);
});
