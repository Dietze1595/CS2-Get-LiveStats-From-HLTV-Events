// src/fetcher.js
import * as hltvScraper from './sources/hltvScraper.js';
import * as fanden from './sources/fanden.js';
import * as mock from './mock.js';

const MAX_PRIMARY_FAILS = 3;
const PRIMARY_BACKOFF_MS = 60_000;

let primaryFailStreak = 0;
let primarySkipUntil = 0;

function primaryAvailable(now) {
  return now >= primarySkipUntil;
}

export async function fetchLive({ now = Date.now(), selectedEventIds = null } = {}) {
  if (process.env.MOCK_LIVE) {
    const matches = await mock.fetchLive();
    return { matches, source: 'mock', error: null };
  }

  const errors = [];

  if (primaryAvailable(now)) {
    try {
      const matches = await hltvScraper.fetchLive({ selectedEventIds });
      primaryFailStreak = 0;
      return { matches, source: 'hltv-scraper', error: null };
    } catch (e) {
      errors.push(`hltv-scraper: ${e.message}`);
      primaryFailStreak++;
      if (primaryFailStreak >= MAX_PRIMARY_FAILS) {
        primarySkipUntil = now + PRIMARY_BACKOFF_MS;
        console.warn(`[fetcher] primary skipped for ${PRIMARY_BACKOFF_MS / 1000}s after ${primaryFailStreak} failures`);
      }
    }
  } else {
    errors.push(`hltv-scraper: skipped (backoff)`);
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
