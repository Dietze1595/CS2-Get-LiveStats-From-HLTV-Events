import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { safeResolve } from '../src/staticFiles.js';

test('safeResolve allows paths inside the base directory', () => {
  const base = resolve('logos');
  assert.equal(safeResolve(base, '/g2.png'), resolve(base, 'g2.png'));
});

test('safeResolve rejects path traversal outside the base directory', () => {
  const base = resolve('logos');
  assert.equal(safeResolve(base, '/../package.json'), null);
});
