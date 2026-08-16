import test from 'node:test';
import assert from 'node:assert/strict';

import { durToMin, minToDur, REST_DUR } from '../assets/coach/duration.js';

/* The app already stores durations as "H:MM" strings and "—" for rest
   (see durToMin in index.html). The engine must speak exactly that dialect, so
   generated sessions drop straight into the existing renderer and chart. */

test('durToMin parses the format the app already stores', () => {
  assert.equal(durToMin('1:15'), 75);
  assert.equal(durToMin('0:45'), 45);
  assert.equal(durToMin('2:00'), 120);
});

test('durToMin treats rest and empty values as zero', () => {
  assert.equal(durToMin('—'), 0);
  assert.equal(durToMin(''), 0);
  assert.equal(durToMin(null), 0);
  assert.equal(durToMin(undefined), 0);
});

test('durToMin accepts a bare number of minutes', () => {
  assert.equal(durToMin('90'), 90);
  assert.equal(durToMin(90), 90);
});

test('minToDur emits zero-padded minutes', () => {
  assert.equal(minToDur(75), '1:15');
  assert.equal(minToDur(45), '0:45');
  assert.equal(minToDur(120), '2:00');
  assert.equal(minToDur(5), '0:05');
});

test('minToDur renders nothing-to-do as the rest marker', () => {
  assert.equal(minToDur(0), REST_DUR);
});

test('minToDur and durToMin round-trip', () => {
  for (const m of [5, 30, 45, 75, 100, 195, 360]) {
    assert.equal(durToMin(minToDur(m)), m, `round-trip failed at ${m} minutes`);
  }
});
