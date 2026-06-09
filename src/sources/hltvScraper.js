// src/sources/hltvScraper.js
//
// Direct scraper for HLTV's current HTML structure (as of 2026-06).
// Replaces the broken `hltv` npm package adapter — that package's selectors
// (`liveMatch-container`, `upcomingMatch`) no longer exist on hltv.org.
//
// Uses got-scraping for TLS-fingerprint spoofing (Cloudflare bypass) and
// cheerio for safe HTML parsing.

import { gotScraping } from 'got-scraping';
import { load } from 'cheerio';
import * as playwrightLive from './playwrightLive.js';
import { matchesSelection } from '../filter.js';

const INDEX_URL = 'https://www.hltv.org/matches';
const FETCH_TIMEOUT_MS = 6000;

function formatToMax(format) {
  const f = String(format || '').toLowerCase();
  if (f.includes('bo5')) return 5;
  if (f.includes('bo3')) return 3;
  if (f.includes('bo1')) return 1;
  return 3;
}

const RETRY_DELAY_MS = 1500;
const MAX_ATTEMPTS = 2;

const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

async function fetchHtml(url) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await gotScraping({
      url,
      timeout: { request: FETCH_TIMEOUT_MS },
      throwHttpErrors: false,
      headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 110 }], devices: ['desktop'], operatingSystems: ['windows', 'macos'] },
      headers: BROWSER_HEADERS,
    });
    if (res.statusCode === 200) return res.body;
    lastStatus = res.statusCode;
    // Cloudflare 403 is often transient with got-scraping — one retry usually clears it
    if (res.statusCode === 403 && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    break;
  }
  throw new Error(`HTTP ${lastStatus} for ${url}`);
}

// Module-scope cache: event-id -> event-name. Filled opportunistically from any
// wrapper that exposes data-event-headline (only LIVE wrappers do), with on-demand
// /events/{id} lookup for upcoming-only events.
const eventNames = new Map();

function parseIndex(html) {
  const $ = load(html);
  const matches = [];

  $('.match-wrapper').each((_, el) => {
    const $el = $(el);
    const matchId = $el.attr('data-match-id');
    const eventId = $el.attr('data-event-id');
    const team1Id = $el.attr('team1');
    const team2Id = $el.attr('team2');
    const isLive = $el.attr('live') === 'true' || $el.hasClass('live-match-container');

    // Skip TBD bracket placeholders ("Winner of A vs Winner of B"). These have
    // no team IDs and no team divs — useless to display.
    if (!team1Id || !team2Id) return;

    // Live wrappers carry the event headline; upcoming wrappers don't (we'll
    // resolve via /events/{id} later if needed).
    const headline = $el.find('.match-event').attr('data-event-headline');
    if (headline && eventId) eventNames.set(Number(eventId), headline);

    // Upcoming has a single .match-meta with "bo3" etc. Live has two — one is
    // "Live" (match-meta-live), the other is the format.
    let format = '';
    $el.find('.match-meta').each((__, mEl) => {
      const $m = $(mEl);
      if (!$m.hasClass('match-meta-live')) format = $m.text().trim();
    });

    // Prefer .match-teamname; fall back to logo img alt/title because some
    // Cloudflare-degraded HTML versions strip the textual team name divs.
    const teams = $el.find('.match-team');
    const teamName = ($team) =>
      $team.find('.match-teamname').first().text().trim()
      || $team.find('.match-team-logo-container img').first().attr('alt')?.trim()
      || $team.find('.match-team-logo-container img').first().attr('title')?.trim()
      || '';
    const teamAName = teamName($(teams[0]));
    const teamBName = teamName($(teams[1]));

    const url = $el.find('a.match-info').attr('href')
      || $el.find('a.match-top').attr('href');

    // .match-time data-unix is set for upcoming matches (ms epoch).
    const unixRaw = $el.find('.match-time').attr('data-unix');
    const startTime = unixRaw && /^\d+$/.test(unixRaw) ? Number(unixRaw) : null;

    matches.push({
      matchId: matchId ? Number(matchId) : null,
      eventId: eventId ? Number(eventId) : null,
      event: headline || (eventId ? eventNames.get(Number(eventId)) || '' : ''),
      status: isLive ? 'LIVE' : 'UPCOMING',
      teamAName,
      teamBName,
      teamAHltvId: team1Id ? Number(team1Id) : null,
      teamBHltvId: team2Id ? Number(team2Id) : null,
      maxMaps: formatToMax(format),
      url: url ? `https://www.hltv.org${url}` : null,
      startTime,
      source: 'hltv-scraper',
    });
  });

  // Backfill event names for entries that didn't have a live wrapper sibling.
  for (const m of matches) {
    if (!m.event && m.eventId && eventNames.has(m.eventId)) {
      m.event = eventNames.get(m.eventId);
    }
  }

  // HLTV lists the same match twice (pinned section + chronological section).
  // Dedupe by matchId, keeping the first (which is always the more complete one
  // because the pinned section comes first in DOM order).
  const seen = new Set();
  return matches.filter((m) => {
    if (m.matchId == null) return true;
    if (seen.has(m.matchId)) return false;
    seen.add(m.matchId);
    return true;
  });
}

// Resolve missing event names by hitting /events/{id}. Cached forever per id.
async function resolveEventNames(matches) {
  const missing = [...new Set(
    matches
      .filter((m) => !m.event && m.eventId && !eventNames.has(m.eventId))
      .map((m) => m.eventId)
  )];
  if (!missing.length) return;
  await Promise.all(missing.map(async (id) => {
    try {
      const html = await fetchHtml(`https://www.hltv.org/events/${id}/x`);
      const $ = load(html);
      const name = $('h1').first().text().trim() || $('.event-header-name').first().text().trim();
      if (name) eventNames.set(id, name);
    } catch (e) {
      console.warn(`[hltv-scraper] event ${id} name lookup failed: ${e.message}`);
    }
  }));
  // Re-apply to matches in place
  for (const m of matches) {
    if (!m.event && m.eventId && eventNames.has(m.eventId)) {
      m.event = eventNames.get(m.eventId);
    }
  }
}

async function fetchIndexHtml() {
  let html;
  try {
    html = await fetchHtml(INDEX_URL);
  } catch (e) {
    console.warn(`[hltv-scraper] index via got-scraping failed (${e.message}), falling back to Playwright`);
    return await playwrightLive.fetchIndexHtml(INDEX_URL);
  }
  // Cloudflare sometimes serves a 200 with a degraded HTML stub (no .match-wrapper
  // rows). Detect and fall through to Playwright.
  if (!/match-wrapper/.test(html)) {
    console.warn('[hltv-scraper] got-scraping returned HTML without .match-wrapper rows, falling back to Playwright');
    return await playwrightLive.fetchIndexHtml(INDEX_URL);
  }
  return html;
}

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

export async function fetchLive({ selectedEventIds = null } = {}) {
  const indexHtml = await fetchIndexHtml();
  const baseMatches = parseIndex(indexHtml);

  if (baseMatches.length === 0) {
    await playwrightLive.enrich([]).catch(() => {});
    return [];
  }

  // Resolve any missing event names so upcoming matches can be filtered too.
  await resolveEventNames(baseMatches);

  const selectedMatches = baseMatches.filter((m) => matchesSelection(m, selectedEventIds));
  const liveToEnrich = selectedMatches.filter((m) => m.status === 'LIVE');
  const upcoming = selectedMatches.filter((m) => m.status === 'UPCOMING');

  const enriched = await playwrightLive.enrich(liveToEnrich).catch((e) => {
    console.warn(`[hltv-scraper] playwright enrich batch failed: ${e.message}`);
    return liveToEnrich;
  });

  return [
    ...enriched,
    ...upcoming,
  ];
}

export const shutdown = playwrightLive.shutdown;
