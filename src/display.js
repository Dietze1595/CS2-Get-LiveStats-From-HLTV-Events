// src/display.js
//
// Pure selection of which (already event-filtered) matches the overlay shows:
// at most 2 cards, pinned to STABLE stream slots. Slot 0 is the top card
// (ESL TV / stream A), slot 1 is the bottom card (ESL TV B / stream B).
//
// Stability is the whole point: a match, once it lands in a slot, keeps that
// slot for as long as it stays on screen — even when HLTV reorders its match
// list between polls. Slots are only reassigned when their match disappears.
// New matches fill the lowest free slot, LIVE matches before UPCOMING ones.
//
// The slot↔match memory lives in a Map the CALLER owns and passes back in via
// opts.assignments, so the selection function stays pure/testable. server.js
// keeps one such Map alive for the whole process; tests pass their own (or
// none, for a single stateless call).

export const DEFAULT_WINDOW_MS = 24 * 60 * 60_000; // 1 day ahead
export const DEFAULT_GRACE_MS = 20 * 60_000;       // delayed-start tolerance

// Stable slot assignment. Mutates `assignments` (matchId -> slot):
//  1. release slots whose match is no longer a candidate,
//  2. keep every surviving match on its existing slot,
//  3. fill free slots with as-yet-unassigned candidates, in priority order.
function assignStableSlots(candidates, limit, assignments) {
  const candidateIds = new Set(
    candidates.map((m) => m.matchId).filter((id) => id != null)
  );

  for (const id of [...assignments.keys()]) {
    if (!candidateIds.has(id)) assignments.delete(id);
  }

  const slotToMatch = new Map(); // slot -> matchId (currently held)
  for (const [id, slot] of assignments) slotToMatch.set(slot, id);

  const nextFreeSlot = () => {
    for (let s = 0; s < limit; s++) {
      if (!slotToMatch.has(s)) return s;
    }
    return -1;
  };

  for (const m of candidates) {
    if (m.matchId == null || assignments.has(m.matchId)) continue;
    const slot = nextFreeSlot();
    if (slot === -1) break; // all slots taken — ignore extra parallel matches
    assignments.set(m.matchId, slot);
    slotToMatch.set(slot, m.matchId);
  }

  return slotToMatch;
}

export function selectDisplayMatches(filtered, now, opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const limit = opts.limit ?? 2;
  // Caller-owned slot memory; a fresh Map means a single stateless selection.
  const assignments = opts.assignments ?? new Map();

  const live = filtered.filter((m) => m.status === 'LIVE');
  const upcoming = filtered
    .filter((m) => m.status === 'UPCOMING' && m.startTime
      && m.startTime > now - graceMs
      && m.startTime <= now + windowMs)
    .sort((a, b) => a.startTime - b.startTime);

  // Priority for filling FREE slots: live matches first (in source order),
  // then the soonest upcoming matches. Already-assigned matches keep their slot
  // regardless of where they fall here.
  const candidates = [...live, ...upcoming];
  const slotToMatch = assignStableSlots(candidates, limit, assignments);

  const byId = new Map(
    candidates.filter((m) => m.matchId != null).map((m) => [m.matchId, m])
  );

  const display = Array.from({ length: limit }, (_, streamSlot) => {
    const id = slotToMatch.get(streamSlot);
    const match = id != null ? byId.get(id) : undefined;
    return match ? { ...match, streamSlot } : undefined;
  }).filter(Boolean);

  return { live, upcoming, display };
}
