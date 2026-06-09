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
