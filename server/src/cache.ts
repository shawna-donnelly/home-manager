import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "./config.js";
import type { Snapshot } from "./events.js";

const FILE = () => join(CACHE_DIR, "snapshot.json");

/**
 * Last-known-good persistence. The point is cold start: after a power cut the
 * server serves this immediately rather than showing an empty wall while the
 * first network round-trip completes.
 */
export async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(FILE(), "utf8")) as Snapshot;
    // Cache files written before sensors existed lack the field.
    parsed.sensors ??= [];
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSnapshot(snapshot: Snapshot): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    // Write-then-rename so a power cut mid-write can't leave a truncated file.
    const tmp = `${FILE()}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(tmp, FILE());
  } catch (err) {
    console.error("[cache] write failed", err);
  }
}
