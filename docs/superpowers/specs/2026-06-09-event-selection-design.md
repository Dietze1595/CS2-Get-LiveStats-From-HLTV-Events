# Event Selection at Startup — Design

**Date:** 2026-06-09
**Status:** Approved

## Problem

The overlay is hardcoded to the Cologne Major. Two separate name-regexes drive
event scoping:

- `server.js` → `FILTER = buildFilter(process.env.EVENT_FILTER)` (default
  `/cologne\s*major/i`) — decides which matches reach the overlay.
- `src/sources/hltvScraper.js` → `ENRICH_REGEX` (default `/cologne/i`) — decides
  which live matches get the expensive Playwright enrichment.

Goal: when starting `node server.js`, interactively choose which event(s) to
track from the events currently visible on HLTV, instead of relying on a
hardcoded default.

## Decisions (from brainstorming)

- **Event list source:** fetched live from HLTV at startup (one index scrape).
- **Selection count:** multiple events selectable at once.
- **Startup behaviour:** always prompt interactively. A `--lastEvent` flag skips
  the prompt and reuses the last saved selection. (Server is run locally by hand;
  OBS is only a browser source, so blocking on a prompt is fine.)
- **Matching:** exact, by `eventId`. No name-regex fuzzy matching, no auto-capture
  of later stages with their own event IDs.
- **`selected-events.json`:** committed to git (NOT gitignored).
- **`EVENT_IDS=` env var:** included as a headless/test escape hatch; replaces the
  removed `EVENT_FILTER`.
- **MOCK_LIVE:** no prompt; tracks all mock events (mock data has no `eventId`).

## Architecture

Replace the two duplicated name-regexes with a single source of truth: a
`Set<number>` of selected event IDs, resolved once at startup and threaded
through the poll pipeline.

### New module: `src/events.js`

- `fetchAvailableEvents()` — calls a new exported `fetchEventList()` from
  `hltvScraper.js` (reuses the existing Cloudflare/Playwright-fallback index
  fetch + parse + name resolution). Returns distinct events as
  `{ eventId, name, liveCount, upcomingCount }`, sorted with live events first.
- `promptSelection(events)` — renders a numbered list, reads from stdin via
  `readline`, parses multi-select input (`"1,3,5"`, tolerant of whitespace),
  validates (range, duplicates, empty), re-prompts on invalid input. Returns
  `{ ids: Set<number>, names: string[] }`.
- `loadLastSelection()` / `saveSelection(sel)` — persists the selection as JSON
  to `selected-events.json` in the project root. Stores both `ids` and `names`
  so `--lastEvent` can log what is being tracked.

### `server.js` startup logic (before the poll loop, awaited)

1. Parse args: `--lastEvent` (also accepts `--lastEvent=true`).
2. Resolve `selectedEventIds: Set<number>` by precedence:
   - `MOCK_LIVE` set → no prompt; track all mock events (filter is a pass-through
     / matches everything in mock mode).
   - `EVENT_IDS=123,456` set → parse, no prompt.
   - `--lastEvent` set → load `selected-events.json`. Missing file → warn, fall
     back to the interactive prompt.
   - otherwise → `fetchAvailableEvents()` → `promptSelection()` → `saveSelection()`.
3. Thread `selectedEventIds` into the pipeline.

### `src/filter.js`

- Remove `buildFilter` (name regex). Filter by `selectedEventIds.has(m.eventId)`.
- Keep the "events seen in last 5min" diagnostic log (useful for discovering
  event IDs/names).
- In mock mode, mock matches have no `eventId`; the filter is effectively a
  pass-through so all mock matches show.

### `src/sources/hltvScraper.js`

- Remove `ENRICH_REGEX`.
- Export `fetchEventList()` for discovery (shares index fetch/parse).
- `fetchLive({ selectedEventIds })` enriches a live match when
  `selectedEventIds.has(m.eventId)`.

### `src/fetcher.js`

- Pass `{ selectedEventIds }` through `fetchLive` to `hltvScraper.fetchLive`.

## Data Flow

```
start → [MOCK_LIVE? | EVENT_IDS? | --lastEvent? ] → selectedEventIds
         (otherwise: fetchEventList → prompt → save)
  ↓
poll → fetchLive({selectedEventIds}) → enrich only selected eventIds
     → applyFilter(matches, selectedEventIds) → mapToOverlay → cache
```

## Error Handling

- Event-list scrape fails at startup → clear error message pointing at the
  `EVENT_IDS=` override; exit non-zero.
- `--lastEvent` with no saved file → warn, fall back to interactive prompt.
- Invalid/empty prompt input → re-prompt.

## Testing

Pure functions only (I/O kept thin):

- Selection parsing: `"1,3,5"`, surrounding whitespace, out-of-range indices,
  duplicates, empty input.
- The eventId filter predicate: included vs excluded vs missing `eventId`
  (mock pass-through).

## Out of Scope

- No UI/overlay changes.
- No favourites / recently-used list beyond the single last-selection file.
- No name-regex heuristics or auto-capture of related stages.
