import { createHash } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Syncs a Google Photos *shared album* (public link) into the photos folder.
 *
 * Google closed its photo-library API to third-party reads in 2025, so this
 * reads the shared-album web page instead — the same data a browser gets from
 * the link. Unofficial by nature: if Google changes the page format, the
 * ITEM_RE below is the thing to fix. Failure never clears photos already on
 * disk; a broken sync means a stale frame, not an empty one.
 *
 * Photo identity comes from the album item's stable media key (AF1Qip…), not
 * its download URL — the URLs are rotated by Google on every page load, and
 * keying files by URL would re-download the whole album each sync.
 */
const ITEM_RE =
  /\["(AF1Qip[^"]{10,})",\["(https:\/\/lh3\.googleusercontent\.com\/[^"]+?)"/g;

/** Synced files carry this prefix; anything else in the folder is manual. */
const PREFIX = "gp_";

export interface PhotoSyncConfig {
  albumUrl: string;
  dir: string;
  intervalMs: number;
}

export function startPhotoSync(config: PhotoSyncConfig): () => void {
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    try {
      await syncOnce(config);
    } catch (err) {
      console.error("[photos] sync failed:", err);
    }
  };

  void run();
  const timer = setInterval(() => void run(), config.intervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function syncOnce({ albumUrl, dir }: PhotoSyncConfig): Promise<void> {
  const response = await fetch(albumUrl, {
    redirect: "follow",
    headers: {
      // Google serves the full page only to browser-looking requests.
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`album page returned ${response.status}`);
  }
  const html = await response.text();

  const wanted = new Map<string, string>(); // filename → download url
  for (const match of html.matchAll(ITEM_RE)) {
    const [, mediaKey, baseUrl] = match as unknown as [string, string, string];
    const name = `${PREFIX}${createHash("sha1").update(mediaKey).digest("hex").slice(0, 16)}.jpg`;
    if (!wanted.has(name)) wanted.set(name, baseUrl);
  }

  if (wanted.size === 0) {
    console.warn(
      "[photos] no photos found at the album link — empty album, or Google " +
        "changed the page format (photosync.ts ITEM_RE needs updating)",
    );
    return;
  }

  await mkdir(dir, { recursive: true });
  const existing = new Set(await readdir(dir));

  let added = 0;
  for (const [name, baseUrl] of wanted) {
    if (existing.has(name)) continue;
    try {
      // Size suffix per Google's image-serving conventions; big enough for a
      // wall panel, small enough to keep the folder sane.
      const image = await fetch(`${baseUrl}=w2048-h2048`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!image.ok) throw new Error(`image fetch ${image.status}`);
      const tmp = join(dir, `${name}.tmp`);
      await writeFile(tmp, Buffer.from(await image.arrayBuffer()));
      await rename(tmp, join(dir, name));
      added++;
    } catch (err) {
      console.error(`[photos] download failed for ${name}:`, err);
    }
  }

  // Mirror removals, but only among files this sync owns.
  let removed = 0;
  for (const file of existing) {
    if (file.startsWith(PREFIX) && file.endsWith(".jpg") && !wanted.has(file)) {
      await unlink(join(dir, file)).catch(() => {});
      removed++;
    }
  }

  if (added > 0 || removed > 0) {
    console.log(
      `[photos] album sync: ${wanted.size} in album, +${added}, -${removed}`,
    );
  }
}
