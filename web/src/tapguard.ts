/**
 * De-chatter guard for the wall's touch panel, which can emit a burst of
 * ~25 identical taps per second for one physical touch. `callAllowed` drops
 * repeat calls with the same key inside the cooldown; the timestamp updates on
 * every call (even dropped ones), so a continuous burst yields exactly one
 * accepted call and a real second tap (after the cooldown of silence) works.
 */
const lastCall = new Map<string, number>();

export function callAllowed(key: string, ms = 350): boolean {
  const now = performance.now();
  const prev = lastCall.get(key) ?? 0;
  lastCall.set(key, now);
  return now - prev >= ms;
}
