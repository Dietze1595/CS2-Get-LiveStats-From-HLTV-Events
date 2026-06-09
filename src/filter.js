export function matchesSelection(match, selectedEventIds) {
  if (selectedEventIds == null) return true;
  return match.eventId != null && selectedEventIds.has(match.eventId);
}

export function applyFilter(matches, selectedEventIds) {
  return matches.filter((m) => matchesSelection(m, selectedEventIds));
}
