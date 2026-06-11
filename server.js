// server.js
import http from 'node:http';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTeams } from './src/logos.js';
import { applyFilter } from './src/filter.js';
import { resolveSelectedEventIds } from './src/events.js';
import { mapToOverlay } from './src/mapper.js';
import { fetchLive } from './src/fetcher.js';
import { selectDisplayMatches } from './src/display.js';
import { safeResolve, serveFile } from './src/staticFiles.js';
import { shutdown as shutdownScraper } from './src/sources/hltvScraper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 8000);
// How far ahead an upcoming match may be to fill an empty card, and how long
// past its scheduled time it still counts as "next" (delayed start).
const UPCOMING_WINDOW_MS = Number(process.env.UPCOMING_WINDOW_HOURS || 24) * 60 * 60_000;
const UPCOMING_GRACE_MS = 20 * 60_000;
let selectedEventIds = null; // resolved at startup before the poll loop begins
// Persistent slot↔match memory so cards stay pinned to their stream slot across
// polls (the top card holds its match for its whole lifetime, no swapping).
const slotAssignments = new Map();

loadTeams();

const cache = {
  payload: { source: null, matches: [] },
  fetchedAt: 0,
  lastError: null,
};

async function pollOnce() {
  const start = Date.now();
  const { matches, source, error } = await fetchLive({ selectedEventIds });
  const elapsed = Date.now() - start;

  if (error || !matches) {
    cache.lastError = error || 'no matches and no source';
    console.warn(`[poll] failed in ${elapsed}ms: ${cache.lastError}`);
    return;
  }

  const filtered = applyFilter(matches, selectedEventIds);

  const { live, upcoming, display } = selectDisplayMatches(filtered, Date.now(), {
    windowMs: UPCOMING_WINDOW_MS,
    graceMs: UPCOMING_GRACE_MS,
    assignments: slotAssignments,
  });
  cache.payload = mapToOverlay(display, source);
  cache.fetchedAt = Date.now();
  cache.lastError = null;
  console.log(`[poll] source=${source} ok=true raw=${matches.length} filtered=${filtered.length} live=${live.length} upcoming=${upcoming.length} shown=${display.length} elapsed=${elapsed}ms`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/live.json') {
    const body = cache.lastError
      ? { ...cache.payload, error: cache.lastError }
      : cache.payload;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    // no-cache so the overlay always picks up the latest renderer; OBS browser
    // sources love to hold on to stale HTML otherwise.
    return serveFile(res, resolve(__dirname, 'index.html'), {
      'Cache-Control': 'no-store',
    });
  }

  if (pathname.startsWith('/logos/')) {
    const sub = pathname.slice('/logos/'.length);
    const target = safeResolve(resolve(__dirname, 'logos'), '/' + sub);
    if (!target || !existsSync(target)) { res.writeHead(404); res.end('404'); return; }
    return serveFile(res, target);
  }

  res.writeHead(404); res.end('404');
});

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

// Clean shutdown so Chromium doesn't leak.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down…`);
  try {
    await shutdownScraper();
  } catch (e) {
    console.warn(`[server] shutdown error: ${e.message}`);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
