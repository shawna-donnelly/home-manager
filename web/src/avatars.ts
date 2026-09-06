import { useEffect, useState } from "react";

/** Lowercased person name → filename under /avatars/. */
export type Avatars = Record<string, string>;

export function useAvatars(): Avatars {
  const [avatars, setAvatars] = useState<Avatars>({});
  useEffect(() => {
    fetch("/api/avatars")
      .then((r) => (r.ok ? (r.json() as Promise<{ avatars: Avatars }>) : null))
      .then((data) => {
        if (data) setAvatars(data.avatars);
      })
      .catch(() => {
        // Initial-letter fallbacks render instead.
      });
  }, []);
  return avatars;
}

export function avatarUrl(avatars: Avatars, name: string): string | null {
  const file = avatars[name.trim().toLowerCase()];
  return file ? `/avatars/${encodeURIComponent(file)}` : null;
}
