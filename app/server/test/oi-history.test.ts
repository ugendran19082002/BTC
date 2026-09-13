import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What open interest was, so the board can say what it has changed by.
 *
 * Delta's ticker carries the current figure and nothing else, so the change is
 * only readable because the desk remembers. The property that matters most is
 * the one in the first test: before there is any history, the answer is
 * *nothing*, never zero. "No change" and "I have not been running long enough
 * to know" are different facts, and a board that prints +0 on a desk which
 * started a minute ago is lying about both.
 */

// Its own file per run, and set before the module is loaded so it opens there.
const dir = mkdtempSync(join(tmpdir(), 'oi-history-'));
process.env.MARKET_DB = join(dir, 'market.db');

const { noteOpenInterest, openInterestChange, oiReading, closeOiHistory } =
  await import('../src/market/oi-history.js');

const HOUR = 3600;
const T0 = 1_789_000_000;          // seconds
const legs = (ce: number, pe: number) => [
  { cp: 'C' as const, strike: 80_000, oi: ce },
  { cp: 'P' as const, strike: 74_400, oi: pe },
];
const snap = (ts: number, spot = 77_000) => ({ expiry: '140926', spot, ts });

beforeEach(() => {
  closeOiHistory();
  rmSync(process.env.MARKET_DB!, { force: true });
  rmSync(`${process.env.MARKET_DB!}-wal`, { force: true });
  rmSync(`${process.env.MARKET_DB!}-shm`, { force: true });
});

// ---------------------------------------------------------------------------

test('[critical] with no history the answer is nothing, not zero', () => {
  const now = snap(T0);
  noteOpenInterest(now, legs(400_000, 300_000));

  // one bucket exists, and it is this one -- there is nothing an hour back
  const change = openInterestChange(now, legs(400_000, 300_000), 1);
  assert.equal(change.size, 0, 'an empty map, so the column reads as absent');
});

test('a change is the difference against the bucket an hour back', () => {
  noteOpenInterest(snap(T0 - HOUR), legs(400_000, 300_000));
  const now = snap(T0);
  noteOpenInterest(now, legs(460_000, 291_000));

  const change = openInterestChange(now, legs(460_000, 291_000), 1);
  const ce = change.get('C80000')!;
  const pe = change.get('P74400')!;

  assert.equal(ce.change, 60_000);
  assert.ok(Math.abs(ce.changePct! - 15) < 1e-9, 'fifteen percent more open');
  assert.equal(pe.change, -9_000);
  assert.ok(pe.changePct! < 0);
});

test('[critical] a young desk answers over what it has, and says so', () => {
  // Up for twenty minutes, asked for an hour. Without the fallback the column
  // is blank for a full hour after every restart -- which is most of the times
  // anyone is watching it.
  noteOpenInterest(snap(T0 - 20 * 60), legs(400_000, 300_000));
  const now = snap(T0);
  const change = openInterestChange(now, legs(410_000, 300_000), 1);

  const ce = change.get('C80000')!;
  // Buckets round down to five minutes, so twenty minutes ago lands in a bucket
  // up to five minutes older than that -- the window is 20 to 25, never 60.
  assert.ok(
    ce.overMinutes >= 20 && ce.overMinutes <= 25,
    `twenty minutes, rounded out to its bucket — got ${ce.overMinutes}`,
  );
  assert.notEqual(ce.overMinutes, 60, 'a window nobody can see the length of reads as the one they asked for');
});

test('what BTC did over the same window comes back with it', () => {
  noteOpenInterest(snap(T0 - HOUR, 76_000), legs(400_000, 300_000));
  const now = snap(T0, 77_520);
  const change = openInterestChange(now, legs(410_000, 300_000), 1);
  assert.ok(Math.abs(change.get('C80000')!.spotChangePct! - 2) < 1e-9, 'two percent up');
});

test('a strike Delta listed since is left out rather than counted from nothing', () => {
  noteOpenInterest(snap(T0 - HOUR), legs(400_000, 300_000));
  const now = snap(T0);
  const withNew = [...legs(400_000, 300_000), { cp: 'C' as const, strike: 84_000, oi: 5_000 }];

  const change = openInterestChange(now, withNew, 1);
  assert.ok(change.has('C80000'));
  assert.equal(change.has('C84000'), false, 'it was not open an hour ago, which is not the same as zero');
});

test('a strike with no open interest to read is skipped on both sides', () => {
  noteOpenInterest(snap(T0 - HOUR), [{ cp: 'C', strike: 80_000, oi: null }]);
  const now = snap(T0);
  assert.equal(openInterestChange(now, [{ cp: 'C', strike: 80_000, oi: null }], 1).size, 0);
});

// ---------------------------------------------------------------------------

test('[critical] a five-second poll does not write five-second rows', () => {
  const first = noteOpenInterest(snap(T0), legs(400_000, 300_000));
  const again = noteOpenInterest(snap(T0 + 5), legs(400_100, 300_100));
  const andAgain = noteOpenInterest(snap(T0 + 10), legs(400_200, 300_200));

  assert.ok(first !== null, 'the first poll of a bucket writes');
  assert.equal(again, null, 'the rest of that bucket does not');
  assert.equal(andAgain, null);
});

test('the next bucket writes again', () => {
  const first = noteOpenInterest(snap(T0), legs(400_000, 300_000));
  const next = noteOpenInterest(snap(T0 + 6 * 60), legs(410_000, 300_000));
  assert.ok(next !== null && next !== first, 'five minutes on is a new bucket');
});

test('anything older than two days is dropped as it writes', () => {
  noteOpenInterest(snap(T0 - 72 * HOUR), legs(100_000, 100_000));
  noteOpenInterest(snap(T0 - HOUR), legs(400_000, 300_000));
  noteOpenInterest(snap(T0), legs(460_000, 300_000));

  // the three-day-old bucket is gone, so asking across it falls back to the
  // newest bucket at or before the target rather than finding it
  const change = openInterestChange(snap(T0), legs(460_000, 300_000), 72);
  const ce = change.get('C80000');
  assert.ok(ce === undefined || ce.overMinutes <= 48 * 60, 'nothing older than the retention window survives');
});

// ---------------------------------------------------------------------------

test('the four quadrants read the way every futures screen reads them', () => {
  const at = (change: number, spotChangePct: number) =>
    oiReading({ change, changePct: 0, overMinutes: 60, spotChangePct });

  assert.equal(at(+5_000, +1.2), 'long_buildup');
  assert.equal(at(+5_000, -1.2), 'short_buildup');
  assert.equal(at(-5_000, +1.2), 'short_covering');
  assert.equal(at(-5_000, -1.2), 'long_unwinding');
});

test('a flat hour is not a direction', () => {
  assert.equal(oiReading({ change: 5_000, changePct: 1, overMinutes: 60, spotChangePct: 0.04 }), null);
  assert.equal(oiReading({ change: 0, changePct: 0, overMinutes: 60, spotChangePct: 1.2 }), null);
  assert.equal(oiReading({ change: 5_000, changePct: 1, overMinutes: 60, spotChangePct: null }), null);
});

// ---------------------------------------------------------------------------

test('[critical] a board is never taken down by its own bookkeeping', () => {
  // the file is gone and the handle is stale: the worst case is that the
  // column reads as absent, which is what it does before the first bucket
  noteOpenInterest(snap(T0), legs(400_000, 300_000));
  rmSync(process.env.MARKET_DB!, { force: true });
  closeOiHistory();
  rmSync(dir, { recursive: true, force: true });

  assert.doesNotThrow(() => noteOpenInterest(snap(T0 + HOUR), legs(410_000, 300_000)));
  assert.doesNotThrow(() => openInterestChange(snap(T0 + HOUR), legs(410_000, 300_000), 1));
});
