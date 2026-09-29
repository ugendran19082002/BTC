import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold, paperRows, recordTrendPaper, resetTrendPaper, trendPaper, trendPaperSchema, writePaper, TREND_PAPER_START } from '../../src/strategy/trend-paper.js';
import { runTrend, type TrendBar } from '../../src/strategy/trend-breakout.js';
import { closePool, query } from '../../src/db/pool.js';

const H = 3600;
const here = dirname(fileURLToPath(import.meta.url));

beforeEach(async () => { await trendPaperSchema(); await query('TRUNCATE trend_paper'); resetTrendPaper(); });
after(() => closePool());

test('[critical] the server runs the chart\'s own trend plan: its copy has not drifted from app/web/src/lib/trend/breakout.ts', () => {
  const web = readFileSync(join(here, '../../../web/src/lib/trend/breakout.ts'), 'utf8');
  const server = readFileSync(join(here, '../../src/strategy/trend-breakout.ts'), 'utf8');
  assert.equal(server.slice(server.indexOf('\n') + 1), web, 'run `npm run sync:trend`');
});

const hbar = (t: number, close: number): TrendBar => ({ time: t, open: close, high: close + 10, low: close - 10, close });
/** 30 flat hours from the start, then a breakout that runs. */
const hours = (n = 40) => Array.from({ length: n }, (_, i) => hbar(TREND_PAPER_START + i * H, i < 30 ? 100 : 120 + (i - 30) * 20));

test('4H candles are folded from whole groups of four hours only', () => {
  const four = fold(hours(10), 4 * H);
  assert.equal(four.length, 2, 'the last two hours are not a whole 4H candle');
  assert.deepEqual([four[0]!.open, four[0]!.close], [100, 100]);
});

test('[critical] a trade seen within 15 minutes of its signal is live; one written later is replayed, and kept apart', async () => {
  const hs = hours();
  const rows = paperRows('1H', runTrend(hs), hs, H);
  assert.equal(rows.length, 1);
  const signal = rows[0]!.entryTime; // the close of the breakout hour
  await writePaper(rows, signal + 5 * 60);
  await writePaper([{ ...rows[0]!, tf: '4H' }], signal + 3 * H);
  const log = await trendPaper();
  assert.deepEqual(log.summary.map((s) => [s.tf, s.live, s.replayed]), [['1H', 1, 0], ['4H', 0, 1]]);
  assert.equal(log.trades.find((t) => t.tf === '1H')!.live, true);
});

test('[critical] written once; an open trade follows its trail and then its exit; a closed one never changes', async () => {
  const hs = hours();
  const open = paperRows('1H', runTrend(hs), hs, H)[0]!;
  assert.equal(await writePaper([open], open.entryTime + 60), 1);
  assert.equal(await writePaper([open], open.entryTime + 120), 0, 'nothing changed, nothing written');
  const closed = { ...open, stop: open.stop + 50, exitTime: open.entryTime + 5 * H, exit: open.stop + 50, rNet: 1.2 };
  assert.equal(await writePaper([closed], open.entryTime + 6 * H), 1);
  assert.equal(await writePaper([{ ...closed, exit: 1, rNet: -9 }], open.entryTime + 7 * H), 0, 'a closed trade is final');
  const log = await trendPaper();
  assert.equal(log.trades[0]!.rNet, 1.2);
  assert.equal(log.summary[0]!.closed, 1);
});

test('the recorder fetches closed hours from the fixed start and writes the plan\'s trades', async () => {
  const hs = hours();
  const fetch = async (_s: string, from: number, to: number) => hs.filter((b) => b.time >= from && b.time <= to).map((b) => ({ ...b, volume: 1 }));
  const now = (hs[hs.length - 1]!.time + H + 60) * 1000;
  assert.equal(await recordTrendPaper(now, fetch), 1);
  assert.equal(await recordTrendPaper(now, fetch), 0, 'the same hours again change nothing');
});
