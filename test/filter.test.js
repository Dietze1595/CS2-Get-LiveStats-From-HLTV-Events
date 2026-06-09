import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSelection, applyFilter } from '../src/filter.js';

test('matchesSelection includes matches whose eventId is selected', () => {
  const sel = new Set([10, 20]);
  assert.equal(matchesSelection({ eventId: 10 }, sel), true);
  assert.equal(matchesSelection({ eventId: 99 }, sel), false);
});

test('matchesSelection excludes matches without an eventId when a set is given', () => {
  assert.equal(matchesSelection({ eventId: null }, new Set([10])), false);
});

test('matchesSelection excludes a match with a missing eventId field', () => {
  assert.equal(matchesSelection({}, new Set([10])), false);
});

test('matchesSelection passes everything through when selection is null (mock mode)', () => {
  assert.equal(matchesSelection({ eventId: null }, null), true);
  assert.equal(matchesSelection({ eventId: 5 }, null), true);
});

test('applyFilter keeps only selected events', () => {
  const matches = [
    { eventId: 10, event: 'A', status: 'LIVE' },
    { eventId: 20, event: 'B', status: 'LIVE' },
    { eventId: null, event: 'Mock', status: 'LIVE' },
  ];
  const out = applyFilter(matches, new Set([10]));
  assert.deepEqual(out.map((m) => m.eventId), [10]);
});

test('applyFilter passes all matches through in mock mode (null selection)', () => {
  const matches = [
    { eventId: null, event: 'Mock1', status: 'LIVE' },
    { eventId: null, event: 'Mock2', status: 'LIVE' },
  ];
  assert.equal(applyFilter(matches, null).length, 2);
});
