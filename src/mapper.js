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
      // Full series map list: [{ name, state }] where state is
      // 'live' | 'doneA' | 'doneB' | 'upcoming'. Empty for upcoming matches.
      maps: Array.isArray(m.maps) ? m.maps : [],
      status: m.status ?? 'LIVE',
      // Unix ms epoch; only set for UPCOMING matches.
      startTime: m.startTime ?? null,
    })),
  };
}
