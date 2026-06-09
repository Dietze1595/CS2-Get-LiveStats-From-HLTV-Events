// src/sources/playwrightLive.js
//
// Headless-Chromium enrichment for live match scores.
//
// Got-scraping can fetch the match index and per-match static HTML through
// Cloudflare, but live round-by-round scores during a map are pushed only
// via WebSocket to the browser (wss://scorebot-lb.hltv.org/socket.io/).
// That WebSocket is itself Cloudflare-protected — no Node WS client gets
// through without a real browser TLS fingerprint. Playwright with a
// few stealth tweaks does.
//
// Pattern: one persistent browser + one persistent page per live match.
// The page loads once, its WebSocket stays open, and HLTV's own JS keeps
// the DOM in sync. Every poll we just read the current DOM — no extra
// navigation or HTTP traffic.

import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT_MS = 25000;
const EVAL_TIMEOUT_MS = 5000;

let browser = null;

async function ensureBrowser() {
  if (browser) return;
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

// A FRESH context per use is mandatory: a reused context's scorebot session goes
// stale after ~2 loads and the live widget then never hydrates (verified — shared
// context degraded to timeouts by the 3rd poll, fresh context hydrated every
// time). The browser stays warm; only the lightweight context is per-use.
async function makeContext() {
  const ctx = await browser.newContext({
    locale: 'en-US',
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

// HLTV's scorebot WebSocket (wss://scorebot-lb.hltv.org) connects on page load,
// delivers ONE initial score sync into the DOM, then closes after ~4s and sends
// no further frames in a headless context. A long-lived page therefore freezes
// at its first value. A fresh navigation re-triggers the initial sync, so we use
// ephemeral pages: open → wait for hydration → read → close, once per poll.
//
// page.reload() does NOT re-hydrate (verified) — only a fresh page + goto does.

// Hydration via a fresh context can take a while (observed 3–15s), so the
// timeout is generous. Misses are covered by the last-known-good cache.
const HYDRATE_TIMEOUT_MS = 14000;
const HYDRATE_POLL_MS = 400;

// Wait until the live score widget shows a real "n:n", or until timeout (the
// widget legitimately stays empty between maps/rounds — then we fall back to
// the static mapholder values, which the fresh page also carries).
async function waitForHydration(page) {
  const deadline = Date.now() + HYDRATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const sc = await page
      .evaluate(() => document.querySelector('.score.scoreText, .scoreText')?.textContent?.trim() || '')
      .catch(() => '');
    if (/\d+\s*:\s*\d+/.test(sc)) return;
    await page.waitForTimeout(HYDRATE_POLL_MS);
  }
}

async function readDom(page) {
  return Promise.race([
    page.evaluate(() => {
      const mhs = [...document.querySelectorAll('.mapholder')].map((mh) => ({
        name: mh.querySelector('.mapname')?.textContent?.trim() || null,
        left: mh.querySelector('.results-left .results-team-score')?.textContent?.trim() || null,
        right: mh.querySelector('.results-right .results-team-score')?.textContent?.trim() || null,
        leftWon: !!mh.querySelector('.results-left')?.classList.contains('won'),
        rightWon: !!mh.querySelector('.results-right')?.classList.contains('won'),
      }));
      // Live scoreboard widget — populated by HLTV's scorebot WebSocket once a map is live.
      // The score is rendered as ctScore:tScore (CT team first, T team second), NOT
      // teamA:teamB — and CT/T swaps at halftime. So we must read each side's score
      // AND which team is on it, then map back to teamA/teamB by name in mergeMapData.
      const numOf = (sel) => {
        const t = document.querySelector(sel)?.textContent?.trim();
        return t && /^\d+$/.test(t) ? Number(t) : null;
      };
      const teamFor = (headerCls) => {
        const thead = document.querySelector('#scoreboardElement thead.' + headerCls);
        return thead?.querySelector('.teamName')?.textContent?.trim() || null;
      };
      const ctScore = numOf('.ctScore');
      const tScore = numOf('.tScore');
      const ctTeam = teamFor('ctTeamHeaderBg');
      const tTeam = teamFor('tTeamHeaderBg');

      const sbText = document.querySelector('#scoreboardElement')?.textContent || '';
      // Map name is letters-only (e.g. "ancient", "inferno"). The scoreboard text
      // concatenates the map directly with the live score ("inferno10:4..."), so we
      // must stop at the first digit.
      const sbMap = sbText.match(/R:\s*\d+\s*-\s*([A-Za-z]+)/i)?.[1] || null;
      const round = Number(sbText.match(/R:\s*(\d+)/i)?.[1]) || null;
      return { mhs, ctScore, tScore, ctTeam, tTeam, sbMap, round };
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), EVAL_TIMEOUT_MS)),
  ]);
}

const normTeam = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function teamMatches(scoreboardName, indexName) {
  const a = normTeam(scoreboardName);
  const b = normTeam(indexName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// Map the scorebot's CT/T scores onto teamA/teamB by team identity. The scorebot
// renders ctScore:tScore and the CT/T assignment flips at halftime, so we cannot
// rely on side order — we match the CT-team and T-team names against the index
// team names. Returns [scoreA, scoreB], or [null, null] if it can't be mapped
// confidently (better no score than a swapped one).
export function mapLiveScore(dom, teamAName, teamBName) {
  const { ctScore, tScore, ctTeam, tTeam } = dom;
  if (ctScore == null || tScore == null) return [null, null];

  if (teamMatches(ctTeam, teamAName) || teamMatches(tTeam, teamBName)) {
    return [ctScore, tScore]; // teamA is CT
  }
  if (teamMatches(tTeam, teamAName) || teamMatches(ctTeam, teamBName)) {
    return [tScore, ctScore]; // teamA is T
  }
  return [null, null]; // names didn't match — don't risk a swap
}

export function mergeMapData(baseMatch, dom) {
  let mapsWonA = 0;
  let mapsWonB = 0;
  const nonWon = []; // { name, idx, ln, rn } — maps not yet decided, in DOM order
  const liveMapName = (dom.sbMap || '').toLowerCase();

  dom.mhs.forEach((mh, idx) => {
    const ln = /^\d+$/.test(mh.left || '') ? Number(mh.left) : null;
    const rn = /^\d+$/.test(mh.right || '') ? Number(mh.right) : null;
    // The map the scorebot reports as LIVE is never a completed map, even if its
    // mapholder briefly carries a .won class (match point / overtime / the instant
    // it ends). Counting it would over-report the series (G2 vs BIG showed 2-0
    // mid-second-map instead of 1-0). Treat the live map as undecided.
    const isLive = liveMapName && (mh.name || '').toLowerCase() === liveMapName;
    if (!isLive && mh.leftWon) mapsWonA++;
    else if (!isLive && mh.rightWon) mapsWonB++;
    else nonWon.push({ name: mh.name, idx, ln, rn });
  });

  let currentMap = null;
  let mapPosition = null;
  let mapScoreA = null;
  let mapScoreB = null;

  // The scorebot widget (#scoreboardElement → dom.sbMap) names the map that is
  // ACTUALLY live right now. The mapholder list cannot tell us this: between
  // maps, or with an undecided decider listed, the "last non-won" holder is an
  // UPCOMING map, not the live one — that's how G2 vs BIG showed "Overpass"
  // while Mirage was being played. So sbMap wins. We match it back to a
  // mapholder only to recover proper casing ("dust2" → "Dust2") and position.
  if (dom.sbMap) {
    const i = dom.mhs.findIndex((x) => (x.name || '').toLowerCase() === dom.sbMap.toLowerCase());
    if (i >= 0) {
      currentMap = dom.mhs[i].name;
      mapPosition = i + 1;
    } else {
      currentMap = dom.sbMap.charAt(0).toUpperCase() + dom.sbMap.slice(1);
      mapPosition = mapsWonA + mapsWonB + 1;
    }
  } else if (nonWon.length) {
    // No live widget (between maps) — show the NEXT map to be played (first
    // undecided one), not the last, and carry its static score if any.
    const next = nonWon[0];
    currentMap = next.name;
    mapPosition = next.idx + 1;
    mapScoreA = next.ln;
    mapScoreB = next.rn;
  }

  if (mapPosition == null) mapPosition = mapsWonA + mapsWonB + 1;

  // The live round-by-round score from the scorebot widget is authoritative for
  // the current map; prefer it over any static mapholder score. It's mapped onto
  // teamA/teamB by identity (the widget is CT:T order, which flips at halftime).
  const [liveA, liveB] = mapLiveScore(dom, baseMatch.teamAName, baseMatch.teamBName);
  if (liveA != null && liveB != null) {
    mapScoreA = liveA;
    mapScoreB = liveB;
  }

  // Full map list for the overlay: every map in the series with its state.
  // The live map (currentMap) wins over any transient .won class on it.
  const curLower = (currentMap || '').toLowerCase();
  const maps = dom.mhs.map((mh) => {
    const isLiveMap = curLower && (mh.name || '').toLowerCase() === curLower;
    let state = 'upcoming';
    if (isLiveMap) state = 'live';
    else if (mh.leftWon) state = 'doneA';
    else if (mh.rightWon) state = 'doneB';
    return { name: mh.name, state };
  });

  return {
    ...baseMatch,
    mapsWonA,
    mapsWonB,
    map: currentMap,
    mapScoreA,
    mapScoreB,
    mapPosition,
    maps,
  };
}

// Last-known-good cache per match. The scorebot widget is empty between rounds
// (freezetime), at halftime, during map transitions, and — crucially — for the
// entire duration of a tech pause, which can run many minutes. As long as the
// SAME map is still live we keep showing its last score; there is no time limit,
// because a match that actually ends drops out of the live list and the server
// simply stops enriching it (its stale entry is then never read again).
//
// The only time-bounded case is a fully empty/failed page read where we can't
// confirm the map identity — there a generous backstop avoids showing very old
// state if the page is just broken for a long time.
const lastGood = new Map(); // matchId -> { mapScoreA, mapScoreB, map, mapsWonA, mapsWonB, mapPosition, ts }
const EMPTY_READ_TTL_MS = 10 * 60_000; // backstop for unidentifiable (empty) reads

// Pure decision: given a freshly-read `merged` match, the cached last-good entry
// (or undefined), and the current time, decide what to return and whether to
// store. Extracted so it can be unit-tested without a browser.
//
// The key distinction is between "has a live round score" and "has any data".
// The round score (scoreText) blanks during pauses/freezetime while the map name
// (from the scorebot or the mapholders) stays set — so we key on the SCORE, not
// on whether any field is populated, or we'd cache a null score and flicker.
export function reconcileWithCache(merged, cached, now, emptyTtl = EMPTY_READ_TTL_MS) {
  const hasScore = merged.mapScoreA != null && merged.mapScoreB != null;
  const hasContent = !!merged.map || merged.mapsWonA > 0 || merged.mapsWonB > 0;

  if (hasScore) {
    // Live score present — this is the authoritative snapshot; store it whole.
    return {
      store: {
        mapScoreA: merged.mapScoreA, mapScoreB: merged.mapScoreB, map: merged.map,
        mapsWonA: merged.mapsWonA, mapsWonB: merged.mapsWonB, mapPosition: merged.mapPosition, ts: now,
      },
      result: merged,
    };
  }

  if (!cached) return { store: null, result: merged };

  if (hasContent && merged.map === cached.map) {
    // Same map, score momentarily blank (freezetime/halftime/TECH PAUSE). Keep the
    // last score for as long as this map stays live — NO time limit. Map name and
    // maps-won come from the current read.
    return { store: null, result: { ...merged, mapScoreA: cached.mapScoreA, mapScoreB: cached.mapScoreB } };
  }
  if (!hasContent && now - cached.ts < emptyTtl) {
    // Empty/failed page read — can't confirm the map; restore the whole snapshot,
    // but only within the backstop window.
    const { ts, ...fields } = cached;
    return { store: null, result: { ...merged, ...fields } };
  }
  // A different map is now live and its score hasn't arrived yet — show it with
  // no score rather than the previous map's score.
  return { store: null, result: merged };
}

// enrich(matches): for each match, open a FRESH context + page, wait for the
// scorebot to deliver its initial sync, read the DOM, then tear both down.
// Fresh navigation each poll keeps the score live; a fresh CONTEXT each time
// keeps the scorebot from going stale (see makeContext note).
export async function enrich(matches, now = Date.now()) {
  if (!matches.length) return matches;

  await ensureBrowser();

  const out = await Promise.all(matches.map(async (m) => {
    if (!m.url || m.matchId == null) return m;
    let ctx;
    let merged = m;
    try {
      // NOTE: do NOT route/abort assets here. Blocking stylesheet/font/image
      // requests on the match page crashes the chromium renderer a few seconds
      // in (verified), which then hangs the next page.evaluate.
      ctx = await makeContext();
      const page = await ctx.newPage();
      await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForHydration(page);
      const dom = await readDom(page);
      merged = mergeMapData(m, dom);
    } catch (e) {
      console.warn(`[playwright] enrich match ${m.matchId} failed: ${e.message}`);
    } finally {
      if (ctx) { try { await ctx.close(); } catch {} }
    }

    const { store, result } = reconcileWithCache(merged, lastGood.get(m.matchId), now);
    if (store) lastGood.set(m.matchId, store);
    return result;
  }));
  return out;
}

// fetchIndexHtml(url): use Playwright as a fallback when got-scraping is
// blocked by Cloudflare. Opens an ephemeral page, navigates, returns HTML,
// then closes the page. Browser stays warm for subsequent enrich() calls.
export async function fetchIndexHtml(url) {
  await ensureBrowser();
  const ctx = await makeContext();
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // Small delay so any JS-injected match rows have a chance to land.
    await page.waitForTimeout(800);
    return await page.content();
  } finally {
    try { await ctx.close(); } catch {}
  }
}

export async function shutdown() {
  if (browser) { try { await browser.close(); } catch {} ; browser = null; }
}
