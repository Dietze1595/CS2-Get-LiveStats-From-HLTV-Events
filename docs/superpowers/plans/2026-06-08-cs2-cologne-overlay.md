# CS2 Cologne Major Live Scoreboard Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js backend that polls HLTV for live CS2 Cologne Major Stage 2/3 matches and serves them to the existing OBS overlay (`index.html`) via `/live.json`.

**Architecture:** Single Node process. A background poller every 8s queries two backends in order (primary: `hltv` npm package; fallback: `fanden/hltv-match-api` on localhost:8080), normalizes results, filters by event name, resolves local logo paths, and caches the snapshot. An HTTP server serves `index.html`, `/logos/*`, and `/live.json`. No tests beyond a mock-mode smoke check.

**Tech Stack:** Node.js 20+ (built-in `node:http`, `node:fs`, `node:path`, `node:url`, global `fetch`), `hltv` npm package as the only runtime dep. No build step, no framework.

**Spec:** `docs/superpowers/specs/2026-06-08-cs2-cologne-overlay-design.md`

---

## File Structure

```
cs-Overlay/
├── index.html                          # MODIFY: drop name-based logo fallback
├── package.json                        # CREATE: hltv dep, start script
├── server.js                           # CREATE: HTTP server + poller loop
├── src/
│   ├── fetcher.js                      # CREATE: primary+fallback orchestration
│   ├── sources/
│   │   ├── npmHltv.js                  # CREATE: hltv-npm adapter → normal form
│   │   └── fanden.js                   # CREATE: fanden REST adapter → normal form
│   ├── filter.js                       # CREATE: regex event filter + 60s logger
│   ├── logos.js                        # CREATE: teams.json → logo URL resolver
│   ├── mapper.js                       # CREATE: normal form → overlay /live.json shape
│   └── mock.js                         # CREATE: read mock-live.json when MOCK_LIVE set
├── mock-live.json                      # CREATE: fixture for offline testing
└── logos/                              # EXISTS
    ├── teams.json                      # EXISTS
    └── *.png / *.svg                   # EXISTS
```

Each `src/*.js` module is one file with one responsibility — they're small enough to hold in context entirely, and they don't depend on each other except through the `fetcher` orchestrator.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "cs-overlay",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "hltv": "^3.4.1"
  },
  "engines": {
    "node": ">=20"
  }
}
```

ESM (`"type": "module"`) is required because the `hltv` package is ESM-only since v3. Mock mode runs via env var: `MOCK_LIVE=1 node server.js` (PowerShell: `$env:MOCK_LIVE="1"; node server.js`).

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 3: Install the dependency**

Run: `npm install`
Expected: creates `node_modules/` and `package-lock.json`, no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "scaffold: package.json with hltv dep"
```

---

## Task 2: Logo resolver

**Files:**
- Create: `src/logos.js`

- [ ] **Step 1: Implement `src/logos.js`**

```js
// src/logos.js
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGOS_DIR = resolve(__dirname, '..', 'logos');

let byHltvId = new Map();
let byNameLower = new Map();

export function loadTeams() {
  const path = resolve(LOGOS_DIR, 'teams.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  byHltvId = new Map();
  byNameLower = new Map();
  for (const t of raw.teams || []) {
    if (!t.currentFile) continue;
    if (existsSync(resolve(LOGOS_DIR, t.currentFile))) {
      if (t.hltvId != null) byHltvId.set(Number(t.hltvId), t.currentFile);
      if (t.name) byNameLower.set(String(t.name).toLowerCase(), t.currentFile);
      if (t.slug) byNameLower.set(String(t.slug).toLowerCase(), t.currentFile);
    }
  }
  return { teams: raw.teams.length };
}

export function resolveLogo({ name, hltvId } = {}) {
  if (hltvId != null) {
    const f = byHltvId.get(Number(hltvId));
    if (f) return `/logos/${f}`;
  }
  if (name) {
    const f = byNameLower.get(String(name).toLowerCase());
    if (f) return `/logos/${f}`;
  }
  return null;
}
```

- [ ] **Step 2: Quick smoke-check via REPL**

Run:
```bash
node --input-type=module -e "import('./src/logos.js').then(m=>{m.loadTeams();console.log(m.resolveLogo({name:'Vitality'}));console.log(m.resolveLogo({hltvId:5995}));console.log(m.resolveLogo({name:'Nope'}));})"
```
Expected output:
```
/logos/vitality.png
/logos/g2.png
null
```

- [ ] **Step 3: Commit**

```bash
git add src/logos.js
git commit -m "feat(logos): resolver via teams.json with hltvId and name lookup"
```

---

## Task 3: Event filter

**Files:**
- Create: `src/filter.js`

- [ ] **Step 1: Implement `src/filter.js`**

```js
// src/filter.js
const DEFAULT = /cologne.*stage\s*[23]/i;

export function buildFilter(envValue) {
  if (!envValue) return DEFAULT;
  try {
    return new RegExp(envValue, 'i');
  } catch (e) {
    console.warn(`[filter] invalid EVENT_FILTER regex (${envValue}), falling back to default. ${e.message}`);
    return DEFAULT;
  }
}

const seenEvents = new Map(); // event -> last-seen ms
let lastDump = 0;

export function applyFilter(matches, regex, now = Date.now()) {
  for (const m of matches) {
    if (m.event) seenEvents.set(m.event, now);
  }
  if (now - lastDump > 60_000) {
    lastDump = now;
    const recent = [...seenEvents.entries()]
      .filter(([, t]) => now - t < 5 * 60_000)
      .map(([name]) => name);
    if (recent.length) {
      console.log(`[filter] events seen in last 5min: ${recent.join(' | ')}`);
    }
  }
  return matches.filter((m) => m.event && regex.test(m.event));
}
```

- [ ] **Step 2: Quick smoke-check**

Run:
```bash
node --input-type=module -e "import('./src/filter.js').then(({buildFilter,applyFilter})=>{const r=buildFilter();const out=applyFilter([{event:'BLAST Open Cologne 2026 - Stage 2'},{event:'IEM Katowice'},{event:'BLAST Open Cologne 2026 - Stage 3'}],r);console.log(JSON.stringify(out));})"
```
Expected output:
```
[{"event":"BLAST Open Cologne 2026 - Stage 2"},{"event":"BLAST Open Cologne 2026 - Stage 3"}]
```

- [ ] **Step 3: Commit**

```bash
git add src/filter.js
git commit -m "feat(filter): regex event filter with 60s event-name dump"
```

---

## Task 4: Mapper (normal form → overlay shape)

**Files:**
- Create: `src/mapper.js`

The mapper converts the internal normal form into the exact shape `index.html` expects, dropping `teamA`/`teamB` per spec.

- [ ] **Step 1: Implement `src/mapper.js`**

```js
// src/mapper.js
import { resolveLogo } from './logos.js';

export function mapToOverlay(normalized, sourceLabel) {
  return {
    source: sourceLabel,
    matches: normalized.map((m) => ({
      teamALogo: resolveLogo({ name: m.teamAName, hltvId: m.teamAHltvId }),
      teamBLogo: resolveLogo({ name: m.teamBName, hltvId: m.teamBHltvId }),
      mapScoreA: m.mapScoreA ?? null,
      mapScoreB: m.mapScoreB ?? null,
      mapsWonA: m.mapsWonA ?? 0,
      mapsWonB: m.mapsWonB ?? 0,
      map: m.map ?? null,
      mapPosition: m.mapPosition ?? ((m.mapsWonA ?? 0) + (m.mapsWonB ?? 0) + 1),
      maxMaps: m.maxMaps ?? 3,
      status: m.status ?? 'LIVE',
    })),
  };
}
```

- [ ] **Step 2: Quick smoke-check**

Run:
```bash
node --input-type=module -e "import('./src/logos.js').then(L=>{L.loadTeams();return import('./src/mapper.js');}).then(({mapToOverlay})=>{const out=mapToOverlay([{teamAName:'Vitality',teamBName:'G2',mapScoreA:13,mapScoreB:11,mapsWonA:1,mapsWonB:0,map:'Mirage',maxMaps:3,status:'LIVE'}],'mock');console.log(JSON.stringify(out,null,2));})"
```
Expected: `source: 'mock'`, one match with `teamALogo: '/logos/vitality.png'`, `teamBLogo: '/logos/g2.png'`, `mapPosition: 2`, no `teamA`/`teamB` fields.

- [ ] **Step 3: Commit**

```bash
git add src/mapper.js
git commit -m "feat(mapper): normalize to overlay shape without team names"
```

---

## Task 5: Source adapter — `hltv` npm

**Files:**
- Create: `src/sources/npmHltv.js`

- [ ] **Step 1: Implement `src/sources/npmHltv.js`**

```js
// src/sources/npmHltv.js
import HLTV from 'hltv';

const PER_CALL_TIMEOUT_MS = 6000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function formatToMax(format) {
  const f = String(format || '').toLowerCase();
  if (f.includes('bo5')) return 5;
  if (f.includes('bo3')) return 3;
  if (f.includes('bo1')) return 1;
  return 3;
}

export async function fetchLive() {
  const list = await withTimeout(HLTV.getMatches(), PER_CALL_TIMEOUT_MS, 'getMatches');
  const live = list.filter((m) => m.live === true || m.status === 'LIVE');

  const enriched = await Promise.all(live.map(async (m) => {
    let detail = null;
    try {
      detail = await withTimeout(HLTV.getMatch({ id: m.id }), PER_CALL_TIMEOUT_MS, `getMatch(${m.id})`);
    } catch (e) {
      console.warn(`[npmHltv] getMatch(${m.id}) failed: ${e.message}`);
    }
    return normalize(m, detail);
  }));

  return enriched;
}

function normalize(list, detail) {
  const t1 = list.team1 || {};
  const t2 = list.team2 || {};
  const maps = (detail && detail.maps) || [];
  const currentMap = maps.find((mp) => mp.live) || maps.find((mp) => mp.result == null) || null;
  const mapsWonA = maps.filter((mp) => mp.winnerTeam && mp.winnerTeam.id === t1.id).length;
  const mapsWonB = maps.filter((mp) => mp.winnerTeam && mp.winnerTeam.id === t2.id).length;

  const currentResult = currentMap && currentMap.result;
  const mapScoreA = currentResult ? currentResult.team1TotalRounds ?? null : null;
  const mapScoreB = currentResult ? currentResult.team2TotalRounds ?? null : null;

  return {
    matchId: list.id,
    event: (list.event && list.event.name) || detail?.event?.name || '',
    status: 'LIVE',
    teamAName: t1.name,
    teamBName: t2.name,
    teamAHltvId: t1.id,
    teamBHltvId: t2.id,
    mapScoreA,
    mapScoreB,
    mapsWonA,
    mapsWonB,
    map: currentMap ? currentMap.name : null,
    mapPosition: currentMap ? (maps.indexOf(currentMap) + 1) : null,
    maxMaps: formatToMax(list.format || detail?.format?.type),
    source: 'hltv-npm',
  };
}
```

Important: the `hltv` package's shape can drift; this adapter is defensive (`?.`, fallbacks). If the live smoke-test reveals different field names, fix here only.

- [ ] **Step 2: Commit (deferred smoke-test until orchestrator exists)**

```bash
git add src/sources/npmHltv.js
git commit -m "feat(source): hltv npm adapter with per-call timeouts"
```

---

## Task 6: Source adapter — fanden REST

**Files:**
- Create: `src/sources/fanden.js`

- [ ] **Step 1: Implement `src/sources/fanden.js`**

```js
// src/sources/fanden.js
const TIMEOUT_MS = 6000;
const BASE = process.env.FANDEN_URL || 'http://localhost:8080';

function formatToMax(format) {
  const f = String(format || '').toLowerCase();
  if (f.includes('bo5')) return 5;
  if (f.includes('bo3')) return 3;
  if (f.includes('bo1')) return 1;
  return 3;
}

export async function fetchLive() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/matches/live`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`fanden HTTP ${res.status}`);
    const arr = await res.json();
    return (Array.isArray(arr) ? arr : []).map(normalize);
  } finally {
    clearTimeout(t);
  }
}

function normalize(m) {
  const mapsWonA = m.team1MapWins ?? 0;
  const mapsWonB = m.team2MapWins ?? 0;
  return {
    matchId: m.matchId,
    event: m.event || '',
    status: m.isLive ? 'LIVE' : 'UNKNOWN',
    teamAName: m.team1Name,
    teamBName: m.team2Name,
    teamAHltvId: null,         // fanden doesn't expose team IDs reliably
    teamBHltvId: null,
    mapScoreA: m.team1Score ?? null,
    mapScoreB: m.team2Score ?? null,
    mapsWonA,
    mapsWonB,
    map: null,                 // fanden does not expose current map name
    mapPosition: mapsWonA + mapsWonB + 1,
    maxMaps: formatToMax(m.format),
    source: 'fanden',
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/sources/fanden.js
git commit -m "feat(source): fanden REST adapter as fallback"
```

---

## Task 7: Mock source

**Files:**
- Create: `mock-live.json`
- Create: `src/mock.js`

- [ ] **Step 1: Write `mock-live.json`**

```json
[
  {
    "matchId": "mock-1",
    "event": "BLAST Open Cologne 2026 - Stage 2",
    "status": "LIVE",
    "teamAName": "Vitality",
    "teamBName": "G2",
    "teamAHltvId": 9565,
    "teamBHltvId": 5995,
    "mapScoreA": 9,
    "mapScoreB": 7,
    "mapsWonA": 1,
    "mapsWonB": 0,
    "map": "Overpass",
    "mapPosition": 2,
    "maxMaps": 3,
    "source": "mock"
  },
  {
    "matchId": "mock-2",
    "event": "BLAST Open Cologne 2026 - Stage 3",
    "status": "LIVE",
    "teamAName": "Spirit",
    "teamBName": "MOUZ",
    "teamAHltvId": 7020,
    "teamBHltvId": 4494,
    "mapScoreA": 13,
    "mapScoreB": 11,
    "mapsWonA": 0,
    "mapsWonB": 0,
    "map": "Mirage",
    "mapPosition": 1,
    "maxMaps": 3,
    "source": "mock"
  },
  {
    "matchId": "mock-3-filtered-out",
    "event": "IEM Katowice 2026",
    "status": "LIVE",
    "teamAName": "FaZe",
    "teamBName": "NAVI",
    "mapScoreA": 5,
    "mapScoreB": 5,
    "mapsWonA": 0,
    "mapsWonB": 0,
    "map": "Inferno",
    "mapPosition": 1,
    "maxMaps": 3,
    "source": "mock"
  }
]
```

The third entry exists to verify the event filter actually drops non-Cologne matches.

- [ ] **Step 2: Implement `src/mock.js`**

```js
// src/mock.js
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'mock-live.json');

export async function fetchLive() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}
```

- [ ] **Step 3: Commit**

```bash
git add mock-live.json src/mock.js
git commit -m "feat(mock): offline fixture source for smoke tests"
```

---

## Task 8: Fetcher orchestrator

**Files:**
- Create: `src/fetcher.js`

This module decides which source to try, handles primary backoff, and reports errors.

- [ ] **Step 1: Implement `src/fetcher.js`**

```js
// src/fetcher.js
import * as npmHltv from './sources/npmHltv.js';
import * as fanden from './sources/fanden.js';
import * as mock from './mock.js';

const MAX_PRIMARY_FAILS = 3;
const PRIMARY_BACKOFF_MS = 60_000;

let primaryFailStreak = 0;
let primarySkipUntil = 0;

function primaryAvailable(now) {
  return now >= primarySkipUntil;
}

export async function fetchLive({ now = Date.now() } = {}) {
  if (process.env.MOCK_LIVE) {
    const matches = await mock.fetchLive();
    return { matches, source: 'mock', error: null };
  }

  const errors = [];

  if (primaryAvailable(now)) {
    try {
      const matches = await npmHltv.fetchLive();
      primaryFailStreak = 0;
      return { matches, source: 'hltv-npm', error: null };
    } catch (e) {
      errors.push(`hltv-npm: ${e.message}`);
      primaryFailStreak++;
      if (primaryFailStreak >= MAX_PRIMARY_FAILS) {
        primarySkipUntil = now + PRIMARY_BACKOFF_MS;
        console.warn(`[fetcher] primary skipped for ${PRIMARY_BACKOFF_MS / 1000}s after ${primaryFailStreak} failures`);
      }
    }
  } else {
    errors.push(`hltv-npm: skipped (backoff)`);
  }

  try {
    const matches = await fanden.fetchLive();
    return { matches, source: 'fanden', error: null };
  } catch (e) {
    errors.push(`fanden: ${e.message}`);
  }

  return { matches: null, source: null, error: errors.join(' | ') };
}

// for tests
export function _resetBackoff() {
  primaryFailStreak = 0;
  primarySkipUntil = 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/fetcher.js
git commit -m "feat(fetcher): primary+fallback orchestration with 60s backoff"
```

---

## Task 9: HTTP server + poller loop

**Files:**
- Create: `server.js`

- [ ] **Step 1: Implement `server.js`**

```js
// server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTeams } from './src/logos.js';
import { buildFilter, applyFilter } from './src/filter.js';
import { mapToOverlay } from './src/mapper.js';
import { fetchLive } from './src/fetcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 8000);
const FILTER = buildFilter(process.env.EVENT_FILTER);

loadTeams();

const cache = {
  payload: { source: null, matches: [] },
  fetchedAt: 0,
  lastError: null,
};

async function pollOnce() {
  const start = Date.now();
  const { matches, source, error } = await fetchLive();
  const elapsed = Date.now() - start;

  if (error || !matches) {
    cache.lastError = error || 'no matches and no source';
    console.warn(`[poll] failed in ${elapsed}ms: ${cache.lastError}`);
    return;
  }

  const filtered = applyFilter(matches, FILTER);
  cache.payload = mapToOverlay(filtered, source);
  cache.fetchedAt = Date.now();
  cache.lastError = null;
  console.log(`[poll] source=${source} ok=true raw=${matches.length} filtered=${filtered.length} elapsed=${elapsed}ms`);
}

// Mime + safe static file serving from project root for index.html and logos.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function safeJoin(base, sub) {
  const target = normPath(resolve(base, '.' + sub));
  if (!target.startsWith(base)) return null;
  return target;
}

async function serveFile(res, absPath) {
  try {
    const data = await readFile(absPath);
    res.writeHead(200, { 'Content-Type': MIME[extname(absPath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('404');
  }
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
    return serveFile(res, resolve(__dirname, 'index.html'));
  }

  if (pathname.startsWith('/logos/')) {
    const sub = pathname.slice('/logos/'.length);
    const target = safeJoin(resolve(__dirname, 'logos'), '/' + sub);
    if (!target || !existsSync(target)) { res.writeHead(404); res.end('404'); return; }
    return serveFile(res, target);
  }

  res.writeHead(404); res.end('404');
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] filter regex: ${FILTER}`);
  console.log(`[server] poll interval: ${POLL_MS}ms`);
  if (process.env.MOCK_LIVE) console.log('[server] MOCK_LIVE=1 — using mock-live.json');
  pollOnce();
  setInterval(pollOnce, POLL_MS);
});
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat(server): http server, static files, live.json, poller loop"
```

---

## Task 10: Adjust `index.html` — drop name-based fallback, simplify demo logos

**Files:**
- Modify: `index.html`

The overlay currently uses `m.teamA`/`m.teamB` for `title`, `alt`, and the initials-on-error fallback. Per spec we drop names entirely; logo box stays empty when no logo URL.

- [ ] **Step 1: Replace the `logo()` function**

Find this block in `index.html`:

```js
  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase() || '?';
  }
  function logo(url, name) {
    const ini = esc(initials(name));
    const fallbackJs = `(()=>{const s=this.src;if(s.endsWith('.svg')){this.src=s.replace(/\\.svg$/,'.png');return;}if(s.endsWith('.png')){this.src=s.replace(/\\.png$/,'.svg.png');return;}this.replaceWith(Object.assign(document.createElement('div'),{className:'fallbackLogo',textContent:'${ini}'}));})()`;
    if (url) return `<div class="logoBox" title="${esc(name)}"><img src="${esc(url)}" alt="${esc(name)}" onerror="${fallbackJs}"></div>`;
    return `<div class="logoBox" title="${esc(name)}"><div class="fallbackLogo">${ini}</div></div>`;
  }
```

Replace with:

```js
  function logo(url) {
    if (url) {
      return `<div class="logoBox"><img src="${esc(url)}" onerror="this.parentNode.innerHTML=''"></div>`;
    }
    return `<div class="logoBox"></div>`;
  }
```

- [ ] **Step 2: Update the two `logo()` call sites**

Find:
```js
          <div class="team">${logo(m.teamALogo, m.teamA)}</div>
```
Replace with:
```js
          <div class="team">${logo(m.teamALogo)}</div>
```

Find:
```js
          <div class="team">${logo(m.teamBLogo, m.teamB)}</div>
```
Replace with:
```js
          <div class="team">${logo(m.teamBLogo)}</div>
```

- [ ] **Step 3: Simplify demo data and drop `demoLogoFallback`**

Find this block:

```js
  const demoMatches = [
    { teamA: 'G2', teamB: 'FUT', teamALogo: '/logos/g2.svg', teamBLogo: '/logos/fut.svg',
      mapScoreA: 9, mapScoreB: 7, mapsWonA: 1, mapsWonB: 0,
      map: 'Overpass', mapPosition: 2, maxMaps: 3, status: 'LIVE' },
    { teamA: 'Spirit', teamB: '9z', teamALogo: '/logos/spirit.svg', teamBLogo: '/logos/9z.svg',
      mapScoreA: 13, mapScoreB: 11, mapsWonA: 0, mapsWonB: 0,
      map: 'Mirage', mapPosition: 1, maxMaps: 3, status: 'LIVE' }
  ];

  // Try multiple extensions for demo logos so .png/.webp etc. also work without
  // having to know the user's file type upfront.
  function demoLogoFallback(m) {
    for (const team of ['teamA','teamB']) {
      const slugSrc = (m[team] || '').toLowerCase().replace(/[^a-z0-9]+/g,'-');
      m[team+'Logo'] = `/logos/${slugSrc}.svg`; // .png/.webp tried by onerror chain
    }
    return m;
  }
```

Replace with:

```js
  const demoMatches = [
    { teamALogo: '/logos/g2.png', teamBLogo: '/logos/fut.svg',
      mapScoreA: 9, mapScoreB: 7, mapsWonA: 1, mapsWonB: 0,
      map: 'Overpass', mapPosition: 2, maxMaps: 3, status: 'LIVE' },
    { teamALogo: '/logos/spirit.png', teamBLogo: '/logos/9z.png',
      mapScoreA: 13, mapScoreB: 11, mapsWonA: 0, mapsWonB: 0,
      map: 'Mirage', mapPosition: 1, maxMaps: 3, status: 'LIVE' }
  ];
```

- [ ] **Step 4: Update the demo `render` call**

Find:
```js
      render({
        source: 'demo',
        matches: demoMatches.slice(0, n).map(demoLogoFallback)
      });
```
Replace with:
```js
      render({
        source: 'demo',
        matches: demoMatches.slice(0, n),
      });
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "ui: drop name-based logo fallback, simplify demo data"
```

---

## Task 11: End-to-end smoke test in mock mode

**Files:** (none modified — verification only)

- [ ] **Step 1: Start server in mock mode**

Run (PowerShell):
```powershell
$env:MOCK_LIVE="1"; node server.js
```

Or (bash):
```bash
MOCK_LIVE=1 node server.js
```

Expected console output (within ~1s):
```
[server] listening on http://localhost:3000
[server] filter regex: /cologne.*stage\s*[23]/i
[server] poll interval: 8000ms
[server] MOCK_LIVE=1 — using mock-live.json
[poll] source=mock ok=true raw=3 filtered=2 elapsed=<n>ms
```

The key signal: `raw=3 filtered=2` proves the filter is dropping the IEM Katowice mock entry.

- [ ] **Step 2: Check `/live.json` shape**

In another shell:
```bash
curl http://localhost:3000/live.json
```

Expected:
- `source: "mock"`
- Two entries in `matches`
- Each entry has `teamALogo`, `teamBLogo` (set to `/logos/vitality.png` etc.), `mapScoreA/B`, `mapsWonA/B`, `map`, `mapPosition`, `maxMaps`, `status`
- **No** `teamA` or `teamB` fields
- No `error` field

- [ ] **Step 3: Open the overlay in a browser**

Visit `http://localhost:3000/` — expect two cards rendering the mock matches with real logos. Visit `http://localhost:3000/?compact=1` — same matches, compact layout.

- [ ] **Step 4: Visit demo mode**

Visit `http://localhost:3000/?demo=2` — should show G2/FUT and Spirit/9z hardcoded matches, independent of poller.

- [ ] **Step 5: Stop and commit nothing**

No code changes in this task. If anything failed, return to the relevant task and fix.

---

## Task 12: Live smoke test (run when Cologne Major is actually live)

**Files:** (none modified — verification only)

- [ ] **Step 1: Start in live mode**

```bash
node server.js
```

- [ ] **Step 2: Watch for event-name dump**

After ~60s, you'll see a log line like:
```
[filter] events seen in last 5min: BLAST Open Cologne 2026 - Stage 2 | ESL Pro League S22 | ...
```

If the Cologne event string differs from what the default regex matches (e.g. it's actually called "ESL Cologne 2026"), update via env:

```powershell
$env:EVENT_FILTER="cologne.*stage\s*[23]|cologne.*play.?off"; node server.js
```

- [ ] **Step 3: Check `/live.json`**

```bash
curl http://localhost:3000/live.json
```

Should show the Cologne matches (or empty `matches: []` if no Cologne match is currently live — that's fine, the overlay handles it).

- [ ] **Step 4: Verify in OBS / browser**

Browser to `http://localhost:3000/?compact=1&scale=0.85` (or whatever scale fits your OBS scene). Confirm logos load, scores update within ~8s of HLTV's own update.

- [ ] **Step 5: If primary fails (HLTV captcha)**

You'll see `[poll] failed`. After 3 fails the primary skips for 60s. Bring up fanden as documented in its README, ensure it's reachable on `http://localhost:8080`, restart `node server.js` — the fetcher will fall through to it automatically.

---

## Notes for the Engineer

- **Why ESM:** the `hltv` npm package has been ESM-only since v3. We can't use CommonJS `require`.
- **Why no tests:** spec says manual smoke checks only. Don't add Jest/Vitest unless explicitly requested.
- **Don't add dependencies:** the only allowed runtime dep is `hltv`. If you find yourself wanting `express`, `axios`, `cheerio` — stop and reread the spec.
- **The `error` field on `/live.json`** is consumed by the existing overlay's `errorEl` and shown as a small red strip. Don't remove it.
- **If a logo file is missing**, `resolveLogo` returns `null`, mapper passes through `null`, overlay renders empty `.logoBox`. That's intentional per spec.
