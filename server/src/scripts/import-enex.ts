/**
 * Import recipes from an Evernote export into the meal library.
 *
 *   yarn import:enex ~/Downloads/recipes.enex [--server http://localhost:8080]
 *
 * Expects one note per recipe (Evernote: select notes → File → Export Notes →
 * ENEX). Each note becomes a meal: the note title is the meal name, lines
 * under an "Ingredients" heading become the ingredient list, and the whole
 * note text is kept as the recipe. Goes through the running server's API —
 * never writes meals.json directly, because the live server owns that file.
 *
 * Re-running is safe: notes whose title matches an existing meal are skipped.
 */
import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

interface EnexNote {
  title?: unknown;
  content?: unknown;
}

const args = process.argv.slice(2);
const serverFlag = args.indexOf("--server");
const server =
  serverFlag >= 0 ? (args[serverFlag + 1] ?? "") : "http://localhost:8080";
const file = args.find(
  (a, i) => !a.startsWith("--") && (serverFlag < 0 || i !== serverFlag + 1),
);

if (!file || !server) {
  console.error(
    "usage: yarn import:enex <file.enex> [--server http://localhost:8080]",
  );
  process.exit(1);
}

// Headings may carry emoji/symbol prefixes from recipe-clipper templates
// ("🛒 Ingredients:", "✅ Instructions:"), so anything non-alphanumeric may
// precede the keyword — but the line must be only the heading.
const INGREDIENTS_HEADING = /^[^a-z0-9]*ingredients\b[\s:]*$/i;
const NEXT_SECTION_HEADING =
  /^[^a-z0-9]*(instructions|directions|steps|method|preparation|to make|notes)\b[\s:]*$/i;
/** Leading bullets/numbering Evernote or web clips leave on list lines. */
const LIST_PREFIX = /^\s*(?:[-•*·◦▪]|\d+[.)])\s*/;

/** ENML (the XHTML inside a note) to plain text lines. */
function enmlToText(enml: string): string {
  return (
    enml
      // Block-ish closers and breaks become newlines so lines survive.
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
  );
}

function parseRecipe(note: EnexNote): {
  title: string;
  ingredients: string[];
  recipe: string;
} | null {
  const title = typeof note.title === "string" ? note.title.trim() : "";
  const content = typeof note.content === "string" ? note.content : "";
  // Clipper templates and unnamed notes aren't recipes.
  if (!title || /^untitled$/i.test(title) || /template/i.test(title)) {
    return null;
  }

  const lines = enmlToText(content)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());

  const section: string[] = [];
  let inIngredients = false;
  for (const line of lines) {
    if (INGREDIENTS_HEADING.test(line)) {
      inIngredients = true;
      continue;
    }
    if (inIngredients && NEXT_SECTION_HEADING.test(line)) break;
    if (inIngredients && line) section.push(line);
  }

  // When the section is bulleted, the bullets are the ingredients and bare
  // lines are sub-headings ("Marinade", "For the sauce") — not groceries.
  const bulleted = section.filter((l) => LIST_PREFIX.test(l));
  const ingredients = (bulleted.length > 0 ? bulleted : section).map((l) =>
    l.replace(LIST_PREFIX, ""),
  );

  const recipe = lines.filter(Boolean).join("\n");
  return { title, ingredients: ingredients.slice(0, 40), recipe };
}

const normalize = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\s+/g, " ");

const xml = new XMLParser({ ignoreAttributes: true });
const parsed = xml.parse(await readFile(file, "utf8")) as {
  "en-export"?: { note?: EnexNote | EnexNote[] };
};
const rawNotes = parsed["en-export"]?.note;
const notes = Array.isArray(rawNotes) ? rawNotes : rawNotes ? [rawNotes] : [];

if (notes.length === 0) {
  console.error("no notes found — is this an ENEX export?");
  process.exit(1);
}

const existingRes = await fetch(`${server}/api/meals`);
if (!existingRes.ok) {
  console.error(`server not reachable at ${server} — is it running?`);
  process.exit(1);
}
const existing = new Set(
  ((await existingRes.json()) as { meals: { title: string }[] }).meals.map(
    (m) => normalize(m.title),
  ),
);

let imported = 0;
let skipped = 0;
const noIngredients: string[] = [];

for (const note of notes) {
  const recipe = parseRecipe(note);
  if (!recipe) continue;
  if (existing.has(normalize(recipe.title))) {
    skipped++;
    continue;
  }
  const res = await fetch(`${server}/api/meals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(recipe),
  });
  if (!res.ok) {
    console.error(`  failed: ${recipe.title} (${res.status})`);
    continue;
  }
  existing.add(normalize(recipe.title));
  imported++;
  if (recipe.ingredients.length === 0) noIngredients.push(recipe.title);
  console.log(`  ✓ ${recipe.title} (${recipe.ingredients.length} ingredients)`);
}

console.log(`\nimported ${imported}, skipped ${skipped} already in the library`);
if (noIngredients.length > 0) {
  console.log(
    `no "Ingredients" section found in: ${noIngredients.join(", ")}\n` +
      "  (imported with the full text as the recipe — add ingredients on the wall)",
  );
}
