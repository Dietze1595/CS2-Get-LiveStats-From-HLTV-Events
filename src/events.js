// src/events.js
//
// Event discovery + interactive selection for the overlay. Uses a chosen set
// of HLTV event IDs rather than a name-regex filter.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

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
    if (m.event && e.name === `event ${m.eventId}`) e.name = m.event;
    if (m.status === 'LIVE') e.liveCount++;
    else e.upcomingCount++;
  }
  const hasLive = (e) => (e.liveCount > 0 ? 1 : 0);
  return [...byId.values()].sort(
    (a, b) => hasLive(b) - hasLive(a) || a.name.localeCompare(b.name)
  );
}

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
    return { ids: new Set(data.ids.map(Number)), names: Array.isArray(data.names) ? data.names : [] };
  } catch {
    return null;
  }
}

// Fetch the live HLTV index and aggregate it into a distinct event list.
// Dynamic import keeps the heavy scrape stack out of the pure-helper test path.
export async function fetchAvailableEvents() {
  const { fetchEventList } = await import('./sources/hltvScraper.js');
  const matches = await fetchEventList();
  return aggregateEvents(matches);
}

// Render the numbered list, read one line from stdin, and resolve the chosen
// indices to { ids: Set, names: [] }. Re-prompts on invalid input. Rejects if
// stdin closes (EOF / non-TTY) before a valid selection is made.
export function promptSelection(events) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    rl.on('close', () => {
      if (!done) reject(new Error('stdin closed before a valid selection was made'));
    });
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
          done = true;
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
  try {
    saveSelection(filePath, selection);
  } catch (e) {
    console.warn(`[events] could not save selection to ${filePath}: ${e.message}`);
  }
  console.log(`[events] tracking: ${selection.names.join(', ')}`);
  return selection;
}
