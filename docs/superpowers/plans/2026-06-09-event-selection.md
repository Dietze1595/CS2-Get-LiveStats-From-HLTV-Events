# Event Selection at Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick which HLTV event(s) to track via an interactive prompt at `node server.js` startup, replacing the hardcoded Cologne-Major name-regexes with a single set of selected event IDs.

**Architecture:** A new `src/events.js` module owns event discovery (one HLTV index scrape), an interactive multi-select prompt, and persistence of the last selection. `server.js` resolves a `Set<number>` of event IDs once at startup and threads it through the poll pipeline. The two old name-regexes (`buildFilter` in `filter.js`, `ENRICH_REGEX` in `hltvScraper.js`) are removed in favour of `selectedEventIds.has(eventId)`.

**Tech Stack:** Node 20+ ESM, `node:readline`, `node:test` + `node:assert` (built-in), existing got-scraping/cheerio/playwright scrape stack.

---

## File Structure

- **Create `src/events.js`** — discovery, selection parsing, persistence, prompt, and the startup orchestrator. Pure helpers (`parseArgs`, `parseEventIdsEnv`, `parseSelectionInput`, `aggregateEvents`) are exported for testing; I/O helpers (`fetchAvailableEvents`, `promptSelection`, `loadLastSelection`, `saveSelection`) and the async `resolveSelectedEventIds` orchestrator wrap them.
- **Create `test/events.test.js`** — unit tests for the pure helpers.
- **Create `test/filter.test.js`** — unit tests for the eventId filter predicate.
- **Modify `src/filter.js`** — remove `buildFilter` (name regex); filter by selected eventId set; keep the "events seen" diagnostic. Add a pure `matchesSelection` predicate.
- **Modify `src/sources/hltvScraper.js`** — remove `ENRICH_REGEX`; export `fetchEventList()`; make `fetchLive` accept `{ selectedEventIds }`.
- **Modify `src/fetcher.js`** — thread `{ selectedEventIds }` through to `hltvScraper.fetchLive`.
- **Modify `server.js`** — resolve `selectedEventIds` at startup, thread it into the poll loop.
- **Modify `package.json`** — add a `test` script.
- **Runtime artifact `selected-events.json`** — written at runtime in the project root; committed to git (NOT gitignored).

---

### Task 1: Add test runner script

**Files:**
- Modify: `package.json:6-8`

- [ ] **Step 1: Add the test script**

Change the `scripts` block in `package.json` from:

```json
  "scripts": {
    "start": "node server.js"
  },
```

to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Verify the runner works (no tests yet)**

Run: `npm test`
Expected: exits 0 with a summary like `tests 0` (no test files found is fine).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add node --test script"
```

---

### Task 2: `parseSelectionInput` — parse multi-select prompt input

**Files:**
- Create: `src/events.js`
- Test: `test/events.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/events.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelectionInput } from '../src/events.js';

test('parseSelectionInput parses a simple list', () => {
  assert.deepEqual(parseSelectionInput('1,3,5', 5), [1, 3, 5]);
});

test('parseSelectionInput tolerates whitespace', () => {
  assert.deepEqual(parseSelectionInput(' 2 , 1 ', 3), [1, 2]);
});

test('parseSelectionInput dedupes and sorts', () => {
  assert.deepEqual(parseSelectionInput('3,1,3,1', 3), [1, 3]);
});

test('parseSelectionInput accepts a single value', () => {
  assert.deepEqual(parseSelectionInput('2', 3), [2]);
});

test('parseSelectionInput rejects empty input', () => {
  assert.throws(() => parseSelectionInput('   ', 3), /no selection/);
});

test('parseSelectionInput rejects non-numeric tokens', () => {
  assert.throws(() => parseSelectionInput('1,x', 3), /invalid entry/);
});

test('parseSelectionInput rejects out-of-range indices', () => {
  assert.throws(() => parseSelectionInput('0', 3), /out of range/);
  assert.throws(() => parseSelectionInput('4', 3), /out of range/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/events.test.js`
Expected: FAIL — cannot find module `../src/events.js` (or `parseSelectionInput is not a function`).

- [ ] **Step 3: Implement `parseSelectionInput`**

Create `src/events.js` with:

```js
// src/events.js
//
// Event discovery + interactive selection for the overlay. Replaces the old
// hardcoded EVENT_FILTER name-regex with a chosen set of HLTV event IDs.

// Parse the user's multi-select prompt input (e.g. "1,3,5") against a list of
// `count` numbered options. Returns sorted, de-duplicated 1-based indices.
// Throws on empty, non-numeric, or out-of-range input so the caller can re-prompt.
export function parseSelectionInput(input, count) {
  const tokens = String(input).split(',').map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) throw new Error('no selection');
  const nums = [];
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) throw new Error(`invalid entry: "${t}"`);
    const n = Number(t);
    if (n < 1 || n > count) throw new Error(`out of range: ${n} (expected 1-${count})`);
    nums.push(n);
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/events.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/events.js test/events.test.js
git commit -m "feat: parse multi-select event prompt input"
```

---

### Task 3: `aggregateEvents` — distinct events from index matches

**Files:**
- Modify: `src/events.js`
- Test: `test/events.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/events.test.js`:

```js
import { aggregateEvents } from '../src/events.js';

test('aggregateEvents groups matches by eventId with live/upcoming counts', () => {
  const matches = [
    { eventId: 10, event: 'Cologne Major', status: 'LIVE' },
    { eventId: 10, event: 'Cologne Major', status: 'UPCOMING' },
    { eventId: 20, event: 'Katowice', status: 'UPCOMING' },
  ];
  const events = aggregateEvents(matches);
  assert.deepEqual(events, [
    { eventId: 10, name: 'Cologne Major', liveCount: 1, upcomingCount: 1 },
    { eventId: 20, name: 'Katowice', liveCount: 0, upcomingCount: 1 },
  ]);
});

test('aggregateEvents sorts live events first, then by name', () => {
  const matches = [
    { eventId: 1, event: 'Zeta Cup', status: 'UPCOMING' },
    { eventId: 2, event: 'Alpha Cup', status: 'UPCOMING' },
    { eventId: 3, event: 'Mid Cup', status: 'LIVE' },
  ];
  const events = aggregateEvents(matches);
  assert.deepEqual(events.map((e) => e.eventId), [3, 2, 1]);
});

test('aggregateEvents skips matches without an eventId', () => {
  const matches = [
    { eventId: null, event: 'Mock Event', status: 'LIVE' },
    { eventId: 5, event: 'Real', status: 'LIVE' },
  ];
  const events = aggregateEvents(matches);
  assert.deepEqual(events.map((e) => e.eventId), [5]);
});

test('aggregateEvents falls back to a placeholder name when missing', () => {
  const events = aggregateEvents([{ eventId: 7, event: '', status: 'LIVE' }]);
  assert.equal(events[0].name, 'event 7');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/events.test.js`
Expected: FAIL — `aggregateEvents is not a function`.

- [ ] **Step 3: Implement `aggregateEvents`**

Append to `src/events.js`:

```js
// Collapse index match rows into distinct events. Live events sort first, then
// alphabetically by name, so the prompt shows what is happening now at the top.
export function aggregateEvents(matches) {
  const byId = new Map(); // eventId -> { eventId, name, liveCount, upcomingCount }
  for (const m of matches) {
    if (m.eventId == null) continue;
    let e = byId.get(m.eventId);
    if (!e) {
      e = { eventId: m.eventId, name: m.event || `event ${m.eventId}`, liveCount: 0, upcomingCount: 0 };
      byId.set(m.eventId, e);
    }
    if (m.event && (!e.name || e.name === `event ${m.eventId}`)) e.name = m.event;
    if (m.status === 'LIVE') e.liveCount++;
    else e.upcomingCount++;
  }
  return [...byId.values()].sort(
    (a, b) => (b.liveCount > 0) - (a.liveCount > 0) || a.name.localeCompare(b.name)
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/events.test.js`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/events.js test/events.test.js
git commit -m "feat: aggregate index matches into distinct events"
```

---

### Task 4: `parseArgs` + `parseEventIdsEnv` — non-interactive inputs

**Files:**
- Modify: `src/events.js`
- Test: `test/events.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/events.test.js`:

```js
import { parseArgs, parseEventIdsEnv } from '../src/events.js';

test('parseArgs detects --lastEvent', () => {
  assert.equal(parseArgs(['--lastEvent']).lastEvent, true);
  assert.equal(parseArgs(['--lastEvent=true']).lastEvent, true);
  assert.equal(parseArgs(['--lastEvent=false']).lastEvent, false);
  assert.equal(parseArgs([]).lastEvent, false);
});

test('parseEventIdsEnv parses a comma list into a Set', () => {
  const ids = parseEventIdsEnv('10, 20 ,30');
  assert.ok(ids instanceof Set);
  assert.deepEqual([...ids].sort((a, b) => a - b), [10, 20, 30]);
});

test('parseEventIdsEnv returns null for empty/undefined', () => {
  assert.equal(parseEventIdsEnv(undefined), null);
  assert.equal(parseEventIdsEnv(''), null);
  assert.equal(parseEventIdsEnv('   '), null);
});

test('parseEventIdsEnv ignores non-numeric tokens', () => {
  const ids = parseEventIdsEnv('10,x,20');
  assert.deepEqual([...ids].sort((a, b) => a - b), [10, 20]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/events.test.js`
Expected: FAIL — `parseArgs is not a function`.

- [ ] **Step 3: Implement both helpers**

Append to `src/events.js`:

```js
// Parse CLI args. Only --lastEvent is recognised; bare flag means true,
// --lastEvent=false explicitly disables it.
export function parseArgs(argv) {
  let lastEvent = false;
  for (const a of argv) {
    if (a === '--lastEvent' || a === '--lastEvent=true') lastEvent = true;
    else if (a === '--lastEvent=false') lastEvent = false;
  }
  return { lastEvent };
}

// Parse the EVENT_IDS env escape hatch ("10,20,30") into a Set<number>.
// Returns null when unset/empty so callers can fall through to other sources.
export function parseEventIdsEnv(value) {
  if (!value || !String(value).trim()) return null;
  const ids = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
  return ids.length ? new Set(ids) : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/events.test.js`
Expected: PASS (15 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/events.js test/events.test.js
git commit -m "feat: parse --lastEvent flag and EVENT_IDS env"
```

---

### Task 5: eventId filter predicate + rewrite `filter.js`

**Files:**
- Modify: `src/filter.js` (full rewrite)
- Test: `test/filter.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/filter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSelection, applyFilter } from '../src/filter.js';

test('matchesSelection includes matches whose eventId is selected', () => {
  const sel = new Set([10, 20]);
  assert.equal(matchesSelection({ eventId: 10 }, sel), true);
  assert.equal(matchesSelection({ eventId: 99 }, sel), false);
});

test('matchesSelection excludes matches without an eventId when a set is given', () => {
  assert.equal(matchesSelection({ eventId: null }, new Set([10])), false);
});

test('matchesSelection passes everything through when selection is null (mock mode)', () => {
  assert.equal(matchesSelection({ eventId: null }, null), true);
  assert.equal(matchesSelection({ eventId: 5 }, null), true);
});

test('applyFilter keeps only selected events', () => {
  const matches = [
    { eventId: 10, event: 'A', status: 'LIVE' },
    { eventId: 20, event: 'B', status: 'LIVE' },
    { eventId: null, event: 'Mock', status: 'LIVE' },
  ];
  const out = applyFilter(matches, new Set([10]));
  assert.deepEqual(out.map((m) => m.eventId), [10]);
});

test('applyFilter passes all matches through in mock mode (null selection)', () => {
  const matches = [
    { eventId: null, event: 'Mock1', status: 'LIVE' },
    { eventId: null, event: 'Mock2', status: 'LIVE' },
  ];
  assert.equal(applyFilter(matches, null).length, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/filter.test.js`
Expected: FAIL — `matchesSelection is not a function` (current `filter.js` exports `buildFilter`/`applyFilter` with regex semantics).

- [ ] **Step 3: Rewrite `src/filter.js`**

Replace the entire contents of `src/filter.js` with:

```js
// src/filter.js
//
// Match filtering by selected HLTV event IDs. The set of event IDs is chosen at
// startup (see src/events.js). A null selection means "no filter" — used in
// MOCK_LIVE mode, where mock matches carry no eventId.

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
  }
  return matches.filter((m) => matchesSelection(m, selectedEventIds));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/filter.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/filter.js test/filter.test.js
git commit -m "feat: filter matches by selected event IDs"
```

---

### Task 6: hltvScraper — export `fetchEventList`, drop `ENRICH_REGEX`, accept `selectedEventIds`

**Files:**
- Modify: `src/sources/hltvScraper.js:14-21` (remove regex), `:199-235` (fetchLive + new export)

- [ ] **Step 1: Remove the `ENRICH_REGEX` block**

Delete these lines (currently `src/sources/hltvScraper.js:14-21`):

```js
const DEFAULT_ENRICH_REGEX = /cologne/i;
const ENRICH_REGEX = (() => {
  try {
    return process.env.EVENT_FILTER ? new RegExp(process.env.EVENT_FILTER, 'i') : DEFAULT_ENRICH_REGEX;
  } catch {
    return DEFAULT_ENRICH_REGEX;
  }
})();
```

- [ ] **Step 2: Add a `selectedEventIds` membership helper near the top**

Immediately after the `import` lines at the top of the file, add:

```js
// A live match is worth the expensive Playwright enrichment only if it belongs
// to a selected event. A null set (mock mode never reaches here) means "all".
function isSelected(match, selectedEventIds) {
  return selectedEventIds == null || (match.eventId != null && selectedEventIds.has(match.eventId));
}
```

- [ ] **Step 3: Update `fetchLive` to take `{ selectedEventIds }`**

Replace the `fetchLive` signature and its enrichment-filter lines. Change:

```js
export async function fetchLive() {
```

to:

```js
export async function fetchLive({ selectedEventIds = null } = {}) {
```

and within the same function change:

```js
  const liveToEnrich = liveAll.filter((m) => ENRICH_REGEX.test(m.event || ''));
  const others = liveAll.filter((m) => !ENRICH_REGEX.test(m.event || ''));
```

to:

```js
  const liveToEnrich = liveAll.filter((m) => isSelected(m, selectedEventIds));
  const others = liveAll.filter((m) => !isSelected(m, selectedEventIds));
```

- [ ] **Step 4: Add the `fetchEventList` export**

Add this exported function directly above the existing `fetchLive` definition:

```js
// fetchEventList(): scrape the index once and return the parsed, name-resolved
// match rows (NOT enriched). src/events.js aggregates these into a distinct
// event list for the startup prompt. Reuses the same Cloudflare/Playwright
// fallback path as fetchLive.
export async function fetchEventList() {
  const indexHtml = await fetchIndexHtml();
  const baseMatches = parseIndex(indexHtml);
  await resolveEventNames(baseMatches);
  return baseMatches;
}
```

- [ ] **Step 5: Smoke-test that the module still imports**

Run: `node -e "import('./src/sources/hltvScraper.js').then(m => console.log(typeof m.fetchLive, typeof m.fetchEventList))"`
Expected: `function function`

- [ ] **Step 6: Commit**

```bash
git add src/sources/hltvScraper.js
git commit -m "feat: scope HLTV enrichment by selected event IDs"
```

---

### Task 7: fetcher — thread `selectedEventIds` through

**Files:**
- Modify: `src/fetcher.js:16-28`

- [ ] **Step 1: Update `fetchLive` to forward `selectedEventIds`**

In `src/fetcher.js`, change the signature:

```js
export async function fetchLive({ now = Date.now() } = {}) {
```

to:

```js
export async function fetchLive({ now = Date.now(), selectedEventIds = null } = {}) {
```

and change the primary-source call:

```js
      const matches = await hltvScraper.fetchLive();
```

to:

```js
      const matches = await hltvScraper.fetchLive({ selectedEventIds });
```

(The `mock` and `fanden` branches are unchanged — mock mode is event-agnostic and the `fanden` fallback is filtered by the server.)

- [ ] **Step 2: Smoke-test the import**

Run: `node -e "import('./src/fetcher.js').then(m => console.log(typeof m.fetchLive))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add src/fetcher.js
git commit -m "feat: forward selectedEventIds through fetcher"
```

---

### Task 8: events.js — persistence, discovery, prompt, orchestrator

**Files:**
- Modify: `src/events.js`

These are I/O wrappers around the already-tested pure helpers, so they are verified by the manual smoke test in Task 9 rather than unit tests.

- [ ] **Step 1: Add imports at the top of `src/events.js`**

Insert directly under the file's opening comment block (above `parseSelectionInput`):

```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
```

- [ ] **Step 2: Add persistence helpers**

Append to `src/events.js`:

```js
// Persist the chosen selection so `--lastEvent` can reuse it. Stored as ids +
// names (names are for human-readable startup logging). Committed to git.
export function saveSelection(filePath, selection) {
  const data = { ids: [...selection.ids], names: selection.names };
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Load a previously saved selection. Returns { ids: Set, names: [] } or null
// when the file is missing or unreadable/corrupt.
export function loadLastSelection(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(data.ids) || !data.ids.length) return null;
    return { ids: new Set(data.ids.map(Number)), names: data.names || [] };
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Add discovery + prompt**

Append to `src/events.js`:

```js
// Fetch the live HLTV index and aggregate it into a distinct event list.
// Dynamic import keeps the heavy scrape stack out of the pure-helper test path.
export async function fetchAvailableEvents() {
  const { fetchEventList } = await import('./sources/hltvScraper.js');
  const matches = await fetchEventList();
  return aggregateEvents(matches);
}

// Render the numbered list, read one line from stdin, and resolve the chosen
// indices to { ids: Set, names: [] }. Re-prompts on invalid input.
export function promptSelection(events) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nAvailable events:');
    events.forEach((e, i) => {
      const live = e.liveCount ? `${e.liveCount} live` : '';
      const up = e.upcomingCount ? `${e.upcomingCount} upcoming` : '';
      const meta = [live, up].filter(Boolean).join(', ');
      console.log(`  ${i + 1}) ${e.name}${meta ? `  (${meta})` : ''}`);
    });
    const ask = () => {
      rl.question('\nWhich events to track? (e.g. 1,3): ', (answer) => {
        try {
          const indices = parseSelectionInput(answer, events.length);
          const chosen = indices.map((i) => events[i - 1]);
          rl.close();
          resolve({ ids: new Set(chosen.map((e) => e.eventId)), names: chosen.map((e) => e.name) });
        } catch (err) {
          console.log(`  ${err.message}. Try again.`);
          ask();
        }
      });
    };
    ask();
  });
}
```

- [ ] **Step 4: Add the startup orchestrator**

Append to `src/events.js`:

```js
// Resolve the selected event IDs at startup, by precedence:
//   1. MOCK_LIVE        -> null (no filter; mock matches have no eventId)
//   2. EVENT_IDS env    -> parsed set, no prompt (headless / tests)
//   3. --lastEvent flag -> load saved file; if missing, fall through to prompt
//   4. otherwise        -> fetch events, prompt, save
// Returns { ids: Set|null, names: string[] }.
export async function resolveSelectedEventIds({ argv, env, filePath }) {
  if (env.MOCK_LIVE) {
    console.log('[events] MOCK_LIVE set — tracking all mock events (no filter)');
    return { ids: null, names: ['(mock — all events)'] };
  }

  const envIds = parseEventIdsEnv(env.EVENT_IDS);
  if (envIds) {
    console.log(`[events] EVENT_IDS set — tracking event IDs: ${[...envIds].join(', ')}`);
    return { ids: envIds, names: [...envIds].map(String) };
  }

  const { lastEvent } = parseArgs(argv);
  if (lastEvent) {
    const saved = loadLastSelection(filePath);
    if (saved) {
      console.log(`[events] --lastEvent — tracking: ${saved.names.join(', ') || [...saved.ids].join(', ')}`);
      return saved;
    }
    console.warn('[events] --lastEvent set but no saved selection found — prompting.');
  }

  const events = await fetchAvailableEvents();
  if (!events.length) {
    throw new Error('no events found on HLTV index — retry, or set EVENT_IDS=<id,...> to skip the prompt');
  }
  const selection = await promptSelection(events);
  saveSelection(filePath, selection);
  console.log(`[events] tracking: ${selection.names.join(', ')}`);
  return selection;
}
```

- [ ] **Step 5: Verify the pure tests still pass and the module imports**

Run: `node --test test/events.test.js`
Expected: PASS (15 tests — additions are not unit-tested but must not break imports).

Run: `node -e "import('./src/events.js').then(m => console.log(typeof m.resolveSelectedEventIds))"`
Expected: `function`

- [ ] **Step 6: Commit**

```bash
git add src/events.js
git commit -m "feat: event discovery, prompt, persistence, and startup resolver"
```

---

### Task 9: server.js — wire the selection into startup and polling

**Files:**
- Modify: `server.js:8-23` (imports + remove FILTER), `:42` (applyFilter call), `:33` (fetchLive call), `:121-136` (listen/startup)

- [ ] **Step 1: Update imports and remove the hardcoded filter**

In `server.js`, change:

```js
import { buildFilter, applyFilter } from './src/filter.js';
```

to:

```js
import { applyFilter } from './src/filter.js';
import { resolveSelectedEventIds } from './src/events.js';
```

Then delete this line (currently `server.js:17`):

```js
const FILTER = buildFilter(process.env.EVENT_FILTER);
```

and add a module-level holder near the other consts (e.g. after the `UPCOMING_GRACE_MS` line):

```js
let selectedEventIds = null; // resolved at startup before the poll loop begins
```

- [ ] **Step 2: Pass `selectedEventIds` into fetch and filter inside `pollOnce`**

In `pollOnce`, change:

```js
  const { matches, source, error } = await fetchLive();
```

to:

```js
  const { matches, source, error } = await fetchLive({ selectedEventIds });
```

and change:

```js
  const filtered = applyFilter(matches, FILTER);
```

to:

```js
  const filtered = applyFilter(matches, selectedEventIds);
```

- [ ] **Step 3: Resolve the selection before the poll loop starts**

Replace the entire `server.listen(...)` block (currently `server.js:121-136`):

```js
server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] filter regex: ${FILTER}`);
  console.log(`[server] poll interval: ${POLL_MS}ms`);
  if (process.env.MOCK_LIVE) console.log('[server] MOCK_LIVE=1 — using mock-live.json');
  // Guard against overlap: a poll can take up to ~15s (per-match hydration), so
  // skip a tick if the previous poll is still running rather than stacking them.
  let polling = false;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try { await pollOnce(); } finally { polling = false; }
  };
  tick();
  setInterval(tick, POLL_MS);
});
```

with:

```js
async function start() {
  // Resolve which event(s) to track BEFORE binding the port, so the interactive
  // prompt isn't competing with incoming overlay requests.
  const selection = await resolveSelectedEventIds({
    argv: process.argv.slice(2),
    env: process.env,
    filePath: resolve(__dirname, 'selected-events.json'),
  });
  selectedEventIds = selection.ids;

  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] tracking events: ${selection.names.join(', ') || '(all)'}`);
    console.log(`[server] poll interval: ${POLL_MS}ms`);
    if (process.env.MOCK_LIVE) console.log('[server] MOCK_LIVE=1 — using mock-live.json');
    // Guard against overlap: a poll can take up to ~15s (per-match hydration), so
    // skip a tick if the previous poll is still running rather than stacking them.
    let polling = false;
    const tick = async () => {
      if (polling) return;
      polling = true;
      try { await pollOnce(); } finally { polling = false; }
    };
    tick();
    setInterval(tick, POLL_MS);
  });
}

start().catch((e) => {
  console.error(`[server] startup failed: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: Manual smoke test — mock mode (no prompt)**

Run: `MOCK_LIVE=1 node server.js` (PowerShell: `$env:MOCK_LIVE=1; node server.js`)
Expected: logs `[events] MOCK_LIVE set — tracking all mock events`, then `[server] listening...`, then a poll line showing `shown=2` (the two BLAST Cologne mock matches; Katowice has no eventId so passes through too in mock mode — confirm it does not crash). Ctrl-C to stop.

- [ ] **Step 5: Manual smoke test — EVENT_IDS escape hatch (no prompt)**

Run: `EVENT_IDS=9999 node server.js` (PowerShell: `$env:EVENT_IDS='9999'; node server.js`)
Expected: logs `[events] EVENT_IDS set — tracking event IDs: 9999`, binds the port, and polls without prompting. (No matches shown unless 9999 is a real live event — that's fine.) Ctrl-C to stop. Unset afterwards: `$env:EVENT_IDS=$null`.

- [ ] **Step 6: Manual smoke test — interactive prompt (real scrape)**

Run: `node server.js`
Expected: a numbered list of current HLTV events prints; entering e.g. `1` resolves, writes `selected-events.json`, binds the port, and starts polling. Ctrl-C to stop. Confirm `selected-events.json` now exists with `ids` and `names`.

- [ ] **Step 7: Manual smoke test — `--lastEvent`**

Run: `node server.js --lastEvent`
Expected: no prompt; logs `[events] --lastEvent — tracking: <names>` from the file written in Step 6, then binds and polls.

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat: resolve tracked events at startup, drop hardcoded filter"
```

---

### Task 10: Commit the generated selection file and clean up references

**Files:**
- Create (runtime artifact): `selected-events.json`
- Verify: `.gitignore` does NOT exclude it

- [ ] **Step 1: Confirm `.gitignore` does not exclude the file**

Run: `git check-ignore selected-events.json; echo "exit=$?"`
Expected: `exit=1` (not ignored). If it prints the filename (exit=0), remove the matching pattern from `.gitignore`.

- [ ] **Step 2: Grep for leftover references to the removed API**

Run: `grep -rn "EVENT_FILTER\|buildFilter\|ENRICH_REGEX" --include=*.js . | grep -v node_modules`
Expected: no matches. If any remain (e.g. in comments/docs), update them.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all event + filter tests green.

- [ ] **Step 4: Commit the selection file**

```bash
git add selected-events.json
git commit -m "chore: commit tracked-events selection"
```

---

## Self-Review Notes

- **Spec coverage:** live discovery (Task 6 `fetchEventList` + Task 8 `fetchAvailableEvents`); multi-select prompt (Task 2, Task 8 `promptSelection`); always-prompt + `--lastEvent` (Task 4, Task 8 orchestrator, Task 9); exact eventId matching (Task 5, Task 6); `selected-events.json` committed (Task 8 persistence, Task 10); `EVENT_IDS` escape hatch (Task 4, Task 8); MOCK_LIVE pass-through (Task 5, Task 8). All spec sections map to tasks.
- **Naming consistency:** `selectedEventIds` (Set|null), `matchesSelection`, `applyFilter(matches, selectedEventIds, now)`, `fetchLive({ selectedEventIds })`, `fetchEventList()`, `resolveSelectedEventIds({ argv, env, filePath })`, `{ ids, names }` selection shape — used identically across Tasks 5–9.
- **No placeholders:** every code step shows complete code; manual smoke tests (Task 9) cover the I/O paths not unit-tested.
