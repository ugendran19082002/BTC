import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capSwapOf, capSwapProblem, pickCapSwap, CAP_SWAP_DEFAULT, type SwapCandidate } from '../../src/strategy/types.js';

/** Making room at the cap (owner, 16 Nov 2026: "Max-open swap @70 update"). */
test('the setting: off unless set; a bad number falls back to the default; what cannot be saved says why', () => {
  assert.deepEqual(capSwapOf(null), CAP_SWAP_DEFAULT);
  assert.deepEqual(capSwapOf('not json'), CAP_SWAP_DEFAULT);
  assert.deepEqual(capSwapOf('{"on":true,"pct":70,"perMin":20}'), { on: true, pct: 70, perMin: 20 });
  assert.deepEqual(capSwapOf('{"on":true,"pct":7,"perMin":0}'), { on: true, pct: 70, perMin: 20 });
  assert.equal(capSwapProblem(null), null);
  assert.equal(capSwapProblem({ on: true, pct: 75 }), null);
  assert.match(capSwapProblem({ on: 'yes' })!, /on: true or false/);
  assert.match(capSwapProblem({ on: true, pct: 70.5 })!, /whole per cent from 50 to 95/);
  assert.match(capSwapProblem({ on: true, pct: 99 })!, /whole per cent from 50 to 95/);
  assert.match(capSwapProblem({ on: true, perMin: 0 })!, /1 to 120/);
  assert.match(capSwapProblem([1])!, /\{"on": true/);
});

const c = (tradeId: string, side: 'CE' | 'PE', soldAt: number, askNow: number | null): SwapCandidate => ({ tradeId, side, soldAt, askNow });

test('[critical] the sale bought back is the one that has kept the most of its premium, at the share asked or more', () => {
  const book = [c('a', 'CE', 20, 7), c('b', 'PE', 18, 4.5), c('c', 'PE', 30, 9), c('d', 'CE', 10, 2.8)];
  // kept: a 65%, b 75%, c 70%, d 72%
  assert.deepEqual(pickCapSwap(book, null, 70)?.tradeId, 'b');
  assert.ok(Math.abs(pickCapSwap(book, null, 70)!.kept - 0.75) < 1e-9);
  assert.equal(pickCapSwap(book, null, 76), null, 'none has kept 76%');
  // Exactly the share asked counts.
  assert.equal(pickCapSwap([c('c', 'PE', 30, 9)], null, 70)?.tradeId, 'c');
});

test('[critical] at a side\'s own limit only a sale on that side makes room', () => {
  const book = [c('pe', 'PE', 18, 1), c('ce', 'CE', 20, 5.5)];
  assert.equal(pickCapSwap(book, 'CE', 70)?.tradeId, 'ce', 'the call, though the put has kept more');
  assert.equal(pickCapSwap([c('pe', 'PE', 18, 1)], 'CE', 70), null);
});

test('a sale with no price to judge it by is never bought back', () => {
  assert.equal(pickCapSwap([c('x', 'PE', 18, null), c('y', 'PE', 0, 1)], null, 50), null);
});
