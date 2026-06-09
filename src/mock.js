// src/mock.js
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', 'mock-live.json');

export async function fetchLive() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}
