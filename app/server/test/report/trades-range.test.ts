import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { HELD_MAX, RANGE_MAX, clearTradesRange, tradesSavedBetween, type RangeDeps } from '../../src/report/trades-range.js';
import type { TradeRecord } from '../../src/trading/engine.js';

/**
 * The reports' trades (owner, 4 Nov 2026: "fix all, best practice"): every trade of the range, not the newest 5,000 --
 * 18,368 in 32 days by then, so a week lost its older half -- with the days before yesterday kept once read, and checked.
 */
const DAY = 86_400_000, IST = 5.5 * 3_600_000;
const NOW = Date.parse('2026-11-04T15:00:00+05:30');
const midnight = (ms: number) => Math.floor((ms + IST) / DAY) * DAY - IST;
const TODAY = midnight(NOW);

/** A journal in memory: trades by save time; counts the reads it is asked for. */
function journal(saved: { id: string; at: number; account?: number; v?: number }[]) {
  const reads: [number, number][] = [];
  let marks = 0;
  const rec = (t: { id: string; v?: number }) => ({ plan: { tradeId: t.id }, state: { tradeId: t.id, v: t.v ?? 0 } } as unknown as TradeRecord);
  const inRange = (from: number, to: number, account: number | null) => saved.filter((t) => t.at >= from && t.at < to && (account === null || t.account === account));
  const deps: RangeDeps = {
    read: async (from, to, limit, account) => { reads.push([from, to]); return inRange(from, to, account).sort((a, b) => b.at - a.at).slice(0, limit).map(rec); },
    fingerprints: async (from, to, account) => {
      marks++;
      const out = new Map<number, { size: number; savedSum: number }>();
      for (const t of inRange(from, to, account)) {
        const d = midnight(t.at), m = out.get(d) ?? { size: 0, savedSum: 0 };
        out.set(d, { size: m.size + 1, savedSum: m.savedSum + (t.at - d) });
      }
      return out;
    },
  };
  return { deps, reads, marks: () => marks, saved };
}
const ids = (r: { records: TradeRecord[] }) => r.records.map((x) => (x.state as unknown as { tradeId: string }).tradeId);

beforeEach(() => clearTradesRange());

test('[critical] every trade of a ten-day range -- newest first, none twice -- and the days before yesterday read once', async () => {
  // Two trades a day for ten days, the last today; the range from 05:30 nine days back, as a report asks.
  const saved = Array.from({ length: 10 }, (_, i) => [0, 1].map((k) => ({ id: `d${i}-${k}`, at: TODAY - i * DAY + 8 * 3_600_000 + k * 60_000 }))).flat();
  const j = journal(saved);
  const from = TODAY - 9 * DAY + IST, to = NOW + 1;
  const first = await tradesSavedBetween(from, to, null, NOW, j.deps);
  assert.equal(first.records.length, 20, 'all twenty: the first day\'s are at 08:00, inside a range from 05:30');
  assert.deepEqual(ids(first), saved.filter((t) => t.at >= from).sort((a, b) => b.at - a.at).map((t) => t.id), 'newest first, each once');
  assert.equal(first.truncated, false);
  const readsFirst = j.reads.length;
  // Again: the kept days are checked, not read; today and yesterday, and the part day at the front, are read again.
  const second = await tradesSavedBetween(from, to, null, NOW, j.deps);
  assert.deepEqual(ids(second), ids(first));
  assert.equal(j.reads.length - readsFirst, 2, 'the part day at the front, and yesterday-to-now: two reads, not ten');
  assert.equal(j.marks(), 2, 'one small check a read');
});

test('[critical] a kept day that changed is read again -- a trade saved since, one deleted -- and only that day', async () => {
  // Two a day: a day that loses one still has one, and is read again.
  const saved = Array.from({ length: 6 }, (_, i) => [{ id: `t${i}`, at: TODAY - (i + 2) * DAY + 3_600_000 }, { id: `k${i}`, at: TODAY - (i + 2) * DAY + 7_200_000 }]).flat();
  const j = journal(saved);
  const from = TODAY - 8 * DAY, to = NOW;
  await tradesSavedBetween(from, to, null, NOW, j.deps);
  // t3 saved again now: it leaves its old day for today; t5 deleted.
  saved.find((t) => t.id === 't3')!.at = NOW - 1_000;
  saved.find((t) => t.id === 't3')!.v = 2;
  saved.splice(saved.findIndex((t) => t.id === 't5'), 1);
  const before = j.reads.length;
  const r = await tradesSavedBetween(from, to, null, NOW, j.deps);
  assert.deepEqual(ids(r).filter((x) => x.startsWith('t')).sort(), ['t0', 't1', 't2', 't3', 't4']);
  assert.equal(ids(r).length, 11, 'each once: t3 from today, not again from its old day');
  assert.equal((r.records.find((x) => (x.state as unknown as { tradeId: string }).tradeId === 't3')!.state as unknown as { v: number }).v, 2, 'its state as saved now');
  assert.equal(j.reads.length - before, 3, 'the two days that changed, and yesterday-to-now');
});

test('a range with no whole day before yesterday is read as it is, once, nothing kept', async () => {
  const j = journal([{ id: 'a', at: NOW - 3_600_000 }, { id: 'b', at: TODAY - DAY + 3_600_000 }]);
  const r = await tradesSavedBetween(TODAY - DAY, NOW, null, NOW, j.deps);
  assert.deepEqual(ids(r), ['a', 'b']);
  assert.deepEqual(j.reads, [[TODAY - DAY, NOW]]);
  assert.equal(j.marks(), 0);
});

test('an account\'s trades are its own, kept apart from every account\'s', async () => {
  const j = journal([{ id: 'one', at: TODAY - 5 * DAY, account: 1 }, { id: 'two', at: TODAY - 5 * DAY + 1, account: 2 }]);
  assert.deepEqual(ids(await tradesSavedBetween(TODAY - 6 * DAY, NOW, 1, NOW, j.deps)), ['one']);
  assert.deepEqual(ids(await tradesSavedBetween(TODAY - 6 * DAY, NOW, null, NOW, j.deps)).sort(), ['one', 'two']);
  assert.deepEqual(ids(await tradesSavedBetween(TODAY - 6 * DAY, NOW, 2, NOW, j.deps)), ['two']);
});

test('[critical] more than the ceiling in a read is said; at most HELD_MAX trades kept, the days asked for last let go last', async () => {
  // Five old days of 10,000 each: half again over what is kept.
  const saved = Array.from({ length: 5 }, (_, d) => Array.from({ length: 10_000 }, (_, i) => ({ id: `${d}-${i}`, at: TODAY - (d + 3) * DAY + i }))).flat();
  const j = journal(saved);
  const r = await tradesSavedBetween(TODAY - 8 * DAY, NOW, null, NOW, j.deps);
  assert.equal(r.records.length, 50_000);
  assert.equal(r.truncated, false);
  // Asked again for the newest two days alone: they stay kept, and what is kept is within the ceiling.
  await tradesSavedBetween(TODAY - 4 * DAY, NOW, null, NOW, j.deps);
  const before = j.reads.length;
  await tradesSavedBetween(TODAY - 4 * DAY, NOW, null, NOW, j.deps);
  assert.equal(j.reads.length - before, 1, 'the two kept, only yesterday-to-now read');
  assert.ok(HELD_MAX >= 20_000);
  // A read that comes back full says so.
  const full = journal(Array.from({ length: RANGE_MAX + 5 }, (_, i) => ({ id: `f${i}`, at: NOW - 10 - (i % 1000) })));
  assert.equal((await tradesSavedBetween(TODAY, NOW, null, NOW, full.deps)).truncated, true);
});
