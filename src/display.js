// src/display.js
//
// Pure selection of which (already event-filtered) matches the overlay shows:
// at most 2 cards, live matches first, then the chronologically NEXT upcoming
// matches within a window ahead. A match whose scheduled time has already passed
// (earlier the same day) is never shown as "next".

export const DEFAULT_WINDOW_MS = 24 * 60 * 60_000; // 1 day ahead
export const DEFAULT_GRACE_MS = 20 * 60_000;       // delayed-start tolerance

export function selectDisplayMatches(filtered, now, opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const limit = opts.limit ?? 2;

  const live = filtered.filter((m) => m.status === 'LIVE');
  const upcoming = filtered
    .filter((m) => m.status === 'UPCOMING' && m.startTime
      && m.startTime > now - graceMs
      && m.startTime <= now + windowMs)
    .sort((a, b) => a.startTime - b.startTime);

  return { live, upcoming, display: [...live, ...upcoming].slice(0, limit) };
}
