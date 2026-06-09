import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelectionInput, aggregateEvents, parseArgs, parseEventIdsEnv } from '../src/events.js';

test('parseSelectionInput parses a simple list', () => {
  assert.deepEqual(parseSelectionInput('1,3,5', 5), [1, 3, 5]);
});

test('parseSelectionInput tolerates whitespace', () => {
  assert.deepEqual(parseSelectionInput(' 2 , 1 ', 3), [1, 2]);
});

test('parseSelectionInput dedupes and sorts', () => {
  assert.deepEqual(parseSelectionInput('3,1,3,1', 3), [1, 3]);
});

test('parseSelectionInput accepts a single value', () => {
  assert.deepEqual(parseSelectionInput('2', 3), [2]);
});

test('parseSelectionInput rejects empty input', () => {
  assert.throws(() => parseSelectionInput('   ', 3), /no selection/);
});

test('parseSelectionInput rejects non-numeric tokens', () => {
  assert.throws(() => parseSelectionInput('1,x', 3), /invalid entry/);
});

test('parseSelectionInput rejects out-of-range indices', () => {
  assert.throws(() => parseSelectionInput('0', 3), /out of range/);
  assert.throws(() => parseSelectionInput('4', 3), /out of range/);
});

test('aggregateEvents groups matches by eventId with live/upcoming counts', () => {
  const matches = [
    { eventId: 10, event: 'Cologne Major', status: 'LIVE' },
    { eventId: 10, event: 'Cologne Major', status: 'UPCOMING' },
    { eventId: 20, event: 'Katowice', status: 'UPCOMING' },
  ];
  const events = aggregateEvents(matches);
  assert.deepEqual(events, [
    { eventId: 10, name: 'Cologne Major', liveCount: 1, upcomingCount: 1 },
    { eventId: 20, name: 'Katowice', liveCount: 0, upcomingCount: 1 },
  ]);
});

test('aggregateEvents sorts live events first, then by name', () => {
  const matches = [
    { eventId: 1, event: 'Zeta Cup', status: 'UPCOMING' },
    { eventId: 2, event: 'Alpha Cup', status: 'UPCOMING' },
    { eventId: 3, event: 'Mid Cup', status: 'LIVE' },
  ];
  const events = aggregateEvents(matches);
  assert.deepEqual(events.map((e) => e.eventId), [3, 2, 1]);
});

test('aggregateEvents skips matches without an eventId', () => {
  const matches = [
    { eventId: null, event: 'Mock Event', status: 'LIVE' },
    { eventId: 5, event: 'Real', status: 'LIVE' },
  ];
  const events = aggregateEvents(matches);
  assert.deepEqual(events.map((e) => e.eventId), [5]);
});

test('aggregateEvents falls back to a placeholder name when missing', () => {
  const events = aggregateEvents([{ eventId: 7, event: '', status: 'LIVE' }]);
  assert.equal(events[0].name, 'event 7');
});

test('parseArgs detects --lastEvent', () => {
  assert.equal(parseArgs(['--lastEvent']).lastEvent, true);
  assert.equal(parseArgs(['--lastEvent=true']).lastEvent, true);
  assert.equal(parseArgs(['--lastEvent=false']).lastEvent, false);
  assert.equal(parseArgs([]).lastEvent, false);
});

test('parseEventIdsEnv parses a comma list into a Set', () => {
  const ids = parseEventIdsEnv('10, 20 ,30');
  assert.ok(ids instanceof Set);
  assert.deepEqual([...ids].sort((a, b) => a - b), [10, 20, 30]);
});

test('parseEventIdsEnv returns null for empty/undefined', () => {
  assert.equal(parseEventIdsEnv(undefined), null);
  assert.equal(parseEventIdsEnv(''), null);
  assert.equal(parseEventIdsEnv('   '), null);
});

test('parseEventIdsEnv ignores non-numeric tokens', () => {
  const ids = parseEventIdsEnv('10,x,20');
  assert.deepEqual([...ids].sort((a, b) => a - b), [10, 20]);
});

test('aggregateEvents upgrades a placeholder name when a later row has the name', () => {
  const matches = [
    { eventId: 9, event: '', status: 'LIVE' },
    { eventId: 9, event: 'Late Name', status: 'UPCOMING' },
  ];
  const events = aggregateEvents(matches);
  assert.equal(events[0].name, 'Late Name');
});
