// src/filter.js
//
// Match filtering by selected HLTV event IDs. The set of event IDs is chosen at
// startup (see src/events.js). A null selection means "no filter" — used in
// MOCK_LIVE mode, where mock matches carry no eventId.
// Filtering is purely by eventId: a selected match with no event name is still
// shown (the name is presentation data, not the filter key).

// True if a match should be shown given the selected event-id set.
// null selection => pass-through (mock mode).
export function matchesSelection(match, selectedEventIds) {
  if (selectedEventIds == null) return true;
  return match.eventId != null && selectedEventIds.has(match.eventId);
}

const seenEvents = new Map(); // "eventId|name" -> last-seen ms
let lastDump = 0;

export function applyFilter(matches, selectedEventIds, now = Date.now()) {
  for (const m of matches) {
    if (m.event) seenEvents.set(`${m.eventId ?? '?'}|${m.event}`, now);
  }
  if (now - lastDump > 60_000) {
    lastDump = now;
    const recent = [...seenEvents.entries()]
      .filter(([, t]) => now - t < 5 * 60_000)
      .map(([label]) => label);
    if (recent.length) {
      console.log(`[filter] events seen in last 5min: ${recent.join(' | ')}`);
    }
    // Keep the diagnostic map bounded to recently-seen events.
    for (const [k, t] of seenEvents) {
      if (now - t >= 5 * 60_000) seenEvents.delete(k);
    }
  }
  return matches.filter((m) => matchesSelection(m, selectedEventIds));
}
