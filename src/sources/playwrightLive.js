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
const DEFAULT_BROWSER_CHANNEL = process.platform === 'win32' ? 'msedge' : null;

let browser = null;

async function ensureBrowser() {
  if (browser) return;
  const channel = process.env.PLAYWRIGHT_CHANNEL || DEFAULT_BROWSER_CHANNEL;
  const launchOptions = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  if (channel) launchOptions.channel = channel;

  try {
    browser = await chromium.launch(launchOptions);
  } catch (e) {
    if (!channel) throw e;
    console.warn(`[playwright] could not launch browser channel "${channel}" (${e.message}); falling back to bundled Chromium`);
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }
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
        leftPick: !!mh.querySelector('.results-left')?.classList.contains('pick'),
        rightPick: !!mh.querySelector('.results-right')?.classList.contains('pick'),
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

// Fuzzy map-name match: handles cases like "Dust2" where the scorebot regex
// captures only the letters part ("dust"), while the mapholder carries "Dust2".
function sbMapMatches(mapholderName, liveMapName) {
  const a = (mapholderName || '').toLowerCase();
  const b = (liveMapName || '').toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// A CS2 map is definitively over when the winner's round total equals a valid
// win condition: 13 for normal play, then 16, 19, 22 … for each OT period
// (CS2 OT adds 3 rounds per side, win condition rises by 3 each time).
function isDecisiveWin(ln, rn) {
  if (ln == null || rn == null) return false;
  if (ln > rn && ln >= 13 && (ln - 13) % 3 === 0) return true;
  if (rn > ln && rn >= 13 && (rn - 13) % 3 === 0) return true;
  return false;
}

export function inferTeamSides(dom, teamAName, teamBName) {
  const { ctTeam, tTeam } = dom;

  if (teamMatches(ctTeam, teamAName) || teamMatches(tTeam, teamBName)) return ['CT', 'T'];
  if (teamMatches(tTeam, teamAName) || teamMatches(ctTeam, teamBName)) return ['T', 'CT'];
  return [null, null];
}

// Map the scorebot's CT/T scores onto teamA/teamB by team identity. The scorebot
// renders ctScore:tScore and the CT/T assignment flips at halftime, so we cannot
// rely on side order — we match the CT-team and T-team names against the index
// team names. Returns [scoreA, scoreB], or [null, null] if it can't be mapped
// confidently (better no score than a swapped one).
export function mapLiveScore(dom, teamAName, teamBName) {
  const { ctScore, tScore } = dom;
  if (ctScore == null || tScore == null) return [null, null];

  const [teamASide] = inferTeamSides(dom, teamAName, teamBName);
  if (teamASide === 'CT') return [ctScore, tScore];
  if (teamASide === 'T') return [tScore, ctScore];
  return [null, null]; // names didn't match — don't risk a swap
}

export function mergeMapData(baseMatch, dom, prevLiveMap = null) {
  let mapsWonA = 0;
  let mapsWonB = 0;
  const nonWon = []; // { name, idx, ln, rn } — maps not yet decided, in DOM order
  // When sbMap is blank (halftime break, tech pause, brief scorebot gap), fall
  // back to the previously-known live map so a transient .won class on the
  // current mapholder is not miscounted as a series win.
  const liveMapName = (dom.sbMap || prevLiveMap || '').toLowerCase();

  dom.mhs.forEach((mh, idx) => {
    const ln = /^\d+$/.test(mh.left || '') ? Number(mh.left) : null;
    const rn = /^\d+$/.test(mh.right || '') ? Number(mh.right) : null;
    // Normally the scorebot's "live map" is not yet a completed map, even if
    // its mapholder briefly carries a .won class (match point / OT). Treat it
    // as undecided to avoid over-reporting the series (G2 vs BIG: 2-0 shown
    // mid-second-map). Exception: if the mapholder score is a decisive CS2 win
    // condition (13, 16, 19 … rounds for the winner), the scorebot is stale —
    // it's still reporting the finished map after the map ended. Trust .won.
    const isLive = liveMapName && sbMapMatches(mh.name, liveMapName);
    const decisive = isDecisiveWin(ln, rn);
    if ((!isLive || decisive) && mh.leftWon) mapsWonA++;
    else if ((!isLive || decisive) && mh.rightWon) mapsWonB++;
    else nonWon.push({ name: mh.name, idx, ln, rn });
  });

  let currentMap = null;
  let mapPosition = null;
  let mapScoreA = null;
  let mapScoreB = null;
  const [teamASide, teamBSide] = inferTeamSides(dom, baseMatch.teamAName, baseMatch.teamBName);

  // The scorebot widget (#scoreboardElement → dom.sbMap) names the map that is
  // ACTUALLY live right now. The mapholder list cannot tell us this: between
  // maps, or with an undecided decider listed, the "last non-won" holder is an
  // UPCOMING map, not the live one — that's how G2 vs BIG showed "Overpass"
  // while Mirage was being played. So sbMap wins. We match it back to a
  // mapholder only to recover proper casing ("dust2" → "Dust2") and position.
  if (dom.sbMap) {
    const i = dom.mhs.findIndex((x) => sbMapMatches(x.name, dom.sbMap));
    const mhMatch = i >= 0 ? dom.mhs[i] : null;
    const lnM = mhMatch ? (/^\d+$/.test(mhMatch.left || '') ? Number(mhMatch.left) : null) : null;
    const rnM = mhMatch ? (/^\d+$/.test(mhMatch.right || '') ? Number(mhMatch.right) : null) : null;
    // If the scorebot-named map already has a decisive final score it is done —
    // the scorebot is stale. Fall through to nonWon to pick the next live map.
    if (i >= 0 && !isDecisiveWin(lnM, rnM)) {
      currentMap = dom.mhs[i].name;
      mapPosition = i + 1;
    } else if (nonWon.length) {
      const next = nonWon[0];
      currentMap = next.name;
      mapPosition = next.idx + 1;
      mapScoreA = next.ln;
      mapScoreB = next.rn;
    } else if (i >= 0) {
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

  // Once a team has clinched the series (2:0 in a BO3, 3:0/3:1/3:2 in a BO5,
  // etc.) there is no decider to play. The mapholder list still carries the
  // unplayed final map, and the logic above would otherwise pick it as the
  // "next" map and mark it live — showing a phantom map that will never happen.
  // Drop the current map entirely so nothing is presented as being played.
  const mapsNeeded = Math.ceil((baseMatch.maxMaps ?? 3) / 2);
  if (mapsWonA >= mapsNeeded || mapsWonB >= mapsNeeded) {
    currentMap = null;
    mapScoreA = null;
    mapScoreB = null;
  }

  // The live round-by-round score from the scorebot widget is authoritative for
  // the current map; prefer it over any static mapholder score. It's mapped onto
  // teamA/teamB by identity (the widget is CT:T order, which flips at halftime).
  //
  // BUT only when the scorebot actually reports the map we're showing. Between
  // maps the widget keeps the FINISHED map's final round score while sbMap still
  // names that finished map; meanwhile currentMap has already advanced to the
  // next (unstarted) map. Applying the stale score there made the next map look
  // like it was already at 13:5. Gate on sbMap matching currentMap so the next
  // map shows no score until its own scorebot data arrives.
  const liveIsForCurrentMap = !!dom.sbMap && sbMapMatches(currentMap, dom.sbMap);
  const [liveA, liveB] = mapLiveScore(dom, baseMatch.teamAName, baseMatch.teamBName);
  if (liveIsForCurrentMap && liveA != null && liveB != null) {
    mapScoreA = liveA;
    mapScoreB = liveB;
  }

  // Full map list for the overlay: every map in the series with its state.
  // The live map (currentMap) wins over any transient .won class on it.
  const curLower = (currentMap || '').toLowerCase();
  const maps = dom.mhs.map((mh) => {
    const isLiveMap = curLower && sbMapMatches(mh.name, curLower);
    let state = 'upcoming';
    if (isLiveMap) state = 'live';
    else if (mh.leftWon) state = 'doneA';
    else if (mh.rightWon) state = 'doneB';
    const pickedBy = mh.leftPick ? 'A' : mh.rightPick ? 'B' : null;
    const scoreA = /^\d+$/.test(mh.left || '') ? Number(mh.left) : null;
    const scoreB = /^\d+$/.test(mh.right || '') ? Number(mh.right) : null;
    return { name: mh.name, state, pickedBy, scoreA, scoreB };
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
    teamASide,
    teamBSide,
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
const lastGood = new Map(); // matchId -> { mapScoreA, mapScoreB, map, mapsWonA, mapsWonB, mapPosition, teamASide, teamBSide, ts }
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
    // Guard against HLTV scorebot glitches: within the SAME map the cumulative
    // round total can never decrease. The scorebot occasionally emits a stale or
    // half-synced snapshot (observed: a real 9:3 map flashing to 5:1 with swapped
    // sides for one poll). Such a regressed total is impossible, so reject it and
    // hold the last-good score + sides for this poll instead of flipping to it.
    if (cached && merged.map === cached.map
        && cached.mapScoreA != null && cached.mapScoreB != null
        && (merged.mapScoreA + merged.mapScoreB) < (cached.mapScoreA + cached.mapScoreB)) {
      return {
        store: null,
        result: {
          ...merged,
          mapScoreA: cached.mapScoreA,
          mapScoreB: cached.mapScoreB,
          teamASide: cached.teamASide ?? merged.teamASide ?? null,
          teamBSide: cached.teamBSide ?? merged.teamBSide ?? null,
        },
      };
    }
    // Live score present — this is the authoritative snapshot; store it whole.
    return {
      store: {
        mapScoreA: merged.mapScoreA, mapScoreB: merged.mapScoreB, map: merged.map,
        mapsWonA: merged.mapsWonA, mapsWonB: merged.mapsWonB, mapPosition: merged.mapPosition,
        teamASide: merged.teamASide ?? null, teamBSide: merged.teamBSide ?? null, ts: now,
      },
      result: merged,
    };
  }

  if (!cached) return { store: null, result: merged };

  if (hasContent && merged.map === cached.map) {
    // Same map, score momentarily blank (freezetime/halftime/TECH PAUSE). Keep the
    // last score for as long as this map stays live — NO time limit. Map name and
    // maps-won come from the current read.
    return {
      store: null,
      result: {
        ...merged,
        mapScoreA: cached.mapScoreA,
        mapScoreB: cached.mapScoreB,
        teamASide: merged.teamASide ?? cached.teamASide ?? null,
        teamBSide: merged.teamBSide ?? cached.teamBSide ?? null,
      },
    };
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
    const cachedEntry = lastGood.get(m.matchId);
    try {
      // NOTE: do NOT route/abort assets here. Blocking stylesheet/font/image
      // requests on the match page crashes the chromium renderer a few seconds
      // in (verified), which then hangs the next page.evaluate.
      ctx = await makeContext();
      const page = await ctx.newPage();
      await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForHydration(page);
      const dom = await readDom(page);
      merged = mergeMapData(m, dom, cachedEntry?.map || null);
    } catch (e) {
      console.warn(`[playwright] enrich match ${m.matchId} failed: ${e.message}`);
    } finally {
      if (ctx) { try { await ctx.close(); } catch {} }
    }

    const { store, result } = reconcileWithCache(merged, cachedEntry, now);
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
