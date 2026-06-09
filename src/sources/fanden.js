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
    teamAHltvId: null,
    teamBHltvId: null,
    mapScoreA: m.team1Score ?? null,
    mapScoreB: m.team2Score ?? null,
    mapsWonA,
    mapsWonB,
    map: null,
    mapPosition: mapsWonA + mapsWonB + 1,
    maxMaps: formatToMax(m.format),
    source: 'fanden',
  };
}
