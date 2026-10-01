import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { entryBoard, fillOf, pickTargets, readMethod, rrOf, timeframeRows, MAX_ZONE_ATR, MIN_RR, TP_STEP_ATR } from '../../src/entry/engine.js';
import { atr } from '../../src/entry/prims.js';
import { METHODS } from '../../src/entry/methods.js';
import type { EntryContext, Frames } from '../../src/entry/types.js';
import { ctxOf, path, wave } from './bars.js';

/**
 * The engine, one fact at a time.
 *
 * A 5m breakout is built to be a TRADE on its own timeframe -- a close over the
 * 20-bar high on four times the volume, a stop 2.2 ATR away, an ask wall far
 * enough above for R:R 3.7 -- and each case changes one thing and
 * says which state that must give, and why. TEST.md's rule throughout: a box
 * only when every critical confirmation holds.
 */

const BREAKOUT = METHODS.find((m) => m.id === 'breakout')!;
/** An ask wall just over the breakout: R:R 1.12 to it -- no room (the 2R fallback with no wall clears 1.8). */
const NEAR_WALL = [{ side: 'ask' as const, price: 84_300, size: 5_000 }];
const MOMENTUM = METHODS.find((m) => m.id === 'momentum')!;

function breakoutBars(o: { volume?: number } = {}): Candle[] {
  const bars = path(wave(60, 84_000, 40, 10));
  const t = bars[bars.length - 1]!.time;
  bars.push({ time: t + 300, open: 84_125, high: 84_205, low: 84_120, close: 84_200, volume: o.volume ?? 400 });
  return bars;
}

/** Now = just after the last 5m candle closed. */
const nowAfter = (bars: readonly Candle[], lagSec = 5) => (bars[bars.length - 1]!.time + 300 + lagSec) * 1000;

function single(over: Partial<EntryContext> = {}, bars = breakoutBars()): EntryContext {
  return ctxOf({
    now: nowAfter(bars),
    frames: { '5m': bars },
    walls: [{ side: 'ask', price: 84_900, size: 5_000 }],
    ...over,
  });
}

test('[critical] a breakout with room to its target is a TRADE on its own timeframe, with a box', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single());
  assert.equal(r.state, 'TRADE', r.reason);
  assert.equal(r.dir, 'long');
  assert.ok(r.plan);
  assert.equal(r.plan.tp1, 84_900);
  assert.match(r.plan.tpWhy[0]!, /ask wall 84,900/);
  assert.ok(r.plan.rr >= MIN_RR);
  assert.ok(r.plan.stop < 84_120, 'the stop sits past the breakout candle, with a buffer');
  assert.match(r.plan.why!.stop, /^the breakout candle's far end 84,120 − 0\.25 ATR$/, 'the SL says its structure and buffer');
  assert.equal(r.plan.why!.tp1, 'ask wall 84,900');
});

test('[critical] a step not yet there is WAIT, says which, and draws no box', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({}, breakoutBars({ volume: 100 })));
  assert.equal(r.state, 'WAIT');
  assert.match(r.reason, /waiting for 5m: RVOL 1.5 or more/);
  assert.equal(r.plan, null, 'TEST.md: no entry / SL / TP until every confirmation holds');
});

test('[critical] no room to a target is NO TRADE, even with every step green -- a near wall leaves R:R 1.12', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ walls: NEAR_WALL }));
  assert.equal(r.state, 'NO_TRADE');
  assert.equal(r.gates.find((g) => g.ok === false)?.key, 'rr');
  assert.match(r.reason, /R:R to ask wall 84,300 is 1\.12 -- no room/);
});

test('[critical] stale candles are NO TRADE', () => {
  const bars = breakoutBars();
  const r = readMethod(BREAKOUT, 'single', '5m', single({ now: nowAfter(bars, 3_600) }, bars));
  assert.equal(r.state, 'NO_TRADE');
  assert.equal(r.gates.find((g) => g.ok === false)?.key, 'data');
});

test('big-move risk pointing the other way is NO TRADE', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ bigMove: { band: 'high', direction: -0.6 } }));
  assert.equal(r.gates.find((g) => g.ok === false)?.key, 'big-move');
});

test('fifteen minutes before settlement is NO TRADE', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({
    options: { spot: 84_200, atmIv: 0.4, emDay: 2_000, callWall: null, putWall: null, maxPain: null, toSettleSec: 600 },
  }));
  assert.equal(r.gates.find((g) => g.ok === false)?.key, 'settle');
});

test('a wide spread is NO TRADE', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ spreadPct: 0.2 }));
  assert.equal(r.gates.find((g) => g.ok === false)?.key, 'spread');
});

test('nothing forming, or too few candles, says so', () => {
  const flat = path(wave(70));
  assert.equal(readMethod(BREAKOUT, 'single', '5m', ctxOf({ now: nowAfter(flat), frames: { '5m': flat } })).reason, 'nothing forming');
  assert.match(readMethod(BREAKOUT, 'single', '5m', ctxOf({ frames: { '5m': flat.slice(0, 30) } })).reason, /not enough 5m candles/);
});

test('[critical] momentum that is already extended is not chased', () => {
  // Six bars already running away from the average, then the displacement.
  const bars = path([...wave(60, 84_000, 20, 10), 84_060, 84_120, 84_180, 84_240, 84_300, 84_360]);
  const t = bars[bars.length - 1]!.time;
  bars.push({ time: t + 300, open: 84_360, high: 84_705, low: 84_355, close: 84_700, volume: 900 });
  const r = readMethod(MOMENTUM, 'single', '5m', single({ walls: [{ side: 'ask', price: 88_000, size: 1 }] }, bars));
  assert.equal(r.state, 'NO_TRADE');
  assert.match(r.reason, /extended: opened .* ATR from the 20 EMA -- no chase/);
});

// ------------------------------------------------------------ with the timeframe chain

/**
 * A trend on a higher timeframe, drifting `drift` a bar -- below the entry, so
 * its swing highs are not resistance just over it (which the engine rightly
 * reads as no room).
 */
const htf = (step: number, drift: number) => path(wave(80, 80_000, 40, 10, drift), { step });

function withChain(o: { h1?: number; h4?: number; bull3m?: boolean } = {}): EntryContext {
  const five = breakoutBars();
  const nowSec = five[five.length - 1]!.time + 300 + 5;
  const one = path([84_180, 84_185, 84_190, 84_195], { step: 60, t0: nowSec - 5 - 4 * 60, w: 2 });
  const three = path(o.bull3m === false ? [84_200, 84_190] : [84_180, 84_195], { step: 180, t0: nowSec - 5 - 2 * 180, w: 2 });
  const frames: Frames = {
    '4h': htf(14_400, o.h4 ?? 6), '1h': htf(3_600, o.h1 ?? 6), '30m': htf(1_800, 6), '15m': htf(900, 6),
    '5m': five, '3m': three, '1m': one,
  };
  return ctxOf({ now: nowSec * 1000, frames, walls: [{ side: 'ask', price: 84_900, size: 5_000 }] });
}

test('[critical] with the timeframe chain: every timeframe agreeing is a TRADE, the chain in TEST.md order', () => {
  const r = readMethod(BREAKOUT, 'mtf', '5m', withChain());
  assert.equal(r.state, 'TRADE', r.reason);
  assert.equal(r.tf, '5m', 'the entry is read on 5m with the chain');
  assert.deepEqual([...new Set(r.steps.map((s) => s.tf))], ['4h', '1h', '30m', '15m', '5m', '3m', '1m']);
  assert.equal(r.alignment, 100);
});

test('[critical] with the timeframe chain: 1H and 4H both against is NO TRADE', () => {
  const r = readMethod(BREAKOUT, 'mtf', '5m', withChain({ h1: -6, h4: -6 }));
  assert.equal(r.state, 'NO_TRADE');
  assert.match(r.reason, /1H and 4H are both down/);
});

test('with the timeframe chain: a 3m candle the wrong way is WAIT for the confirmation', () => {
  const r = readMethod(BREAKOUT, 'mtf', '5m', withChain({ bull3m: false }));
  assert.equal(r.state, 'WAIT');
  assert.match(r.reason, /3m: confirmation/);
});

test('[critical] without the chain the higher timeframes are not read: the same 1H/4H downtrend does not block it', () => {
  const ctx = withChain({ h1: -6, h4: -6 });
  const r = readMethod(BREAKOUT, 'single', '5m', ctx);
  assert.notEqual(r.gates.find((g) => g.key === 'htf')?.ok, false);
  assert.equal(r.steps.every((s) => s.tf === '5m'), true);
});

// ------------------------------------------------------------ the board

test('[critical] the board is 24 reads: the twelve methods with the chain, then the twelve without', () => {
  const board = entryBoard(withChain());
  assert.equal(board.length, 24);
  assert.deepEqual(board.slice(0, 12).map((r) => [r.n, r.mode]), METHODS.map((m) => [m.n, 'mtf']));
  assert.deepEqual(board.slice(12).map((r) => [r.n, r.mode]), METHODS.map((m) => [m.n, 'single']));
});

test('[critical] the score is quality out of 100, and what is not recorded is said, not counted', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single());
  assert.equal(r.scoreParts.reduce((s, p) => s + p.max, 0), 100);
  assert.ok(r.score !== null && r.score <= 100);
  assert.equal(r.scoreParts.find((p) => p.name === 'Footprint')?.got, null);
  assert.equal(r.scoreParts.find((p) => p.name === 'Probability')?.got, null);
});

test('[critical] R:R is the points to the target over the points to the stop -- no fee term (removed 1 Oct 2026)', () => {
  assert.equal(rrOf(100, 99, 102), 2);
  // A short: the same arithmetic mirrored.
  assert.equal(rrOf(100, 101, 98), 2);
  assert.equal(rrOf(84_000, 83_800, 84_370), 1.85);
  assert.equal(rrOf(100, 100, 102), 0, 'no risk, no R:R');
});

test('the timeframe rows: each of the chain\'s seven, its trend and what its swings did', () => {
  const rows = timeframeRows(withChain({ h1: -6 }));
  assert.deepEqual(rows.map((r) => r.tf), ['4h', '1h', '30m', '15m', '5m', '3m', '1m']);
  assert.deepEqual([rows[0]!.label, rows[0]!.structure], ['Bullish', 'HH / HL']);
  assert.deepEqual([rows[1]!.label, rows[1]!.structure], ['Bearish', 'LH / LL']);
  assert.equal(rows[6]!.label, 'Not read', 'four 1m candles are not enough to read');
});

test('[critical] every read with a setup carries the whole hard-gate checklist: rule, value, verdict', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({}));
  assert.deepEqual(r.gates.map((g) => g.key), ['data', 'spread', 'stop', 'rr', 'htf', 'big-move', 'em', 'settle']);
  for (const g of r.gates) assert.ok(g.rule.length > 0 && g.value !== undefined, `${g.key} says its rule and what it read`);
  const htf = r.gates.find((g) => g.key === 'htf')!;
  assert.equal(htf.ok, null, 'without the chain the HTF gate is not part of the read -- listed, never "passed"');
  assert.match(r.gates.find((g) => g.key === 'rr')!.value!, /^\d+\.\d\d$/);
});

test('[critical] a gate that was not read refuses nothing, and a failed one is the reason', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ walls: NEAR_WALL }));
  assert.equal(r.gates.find((g) => g.key === 'spread')?.ok, null, 'no spread read');
  assert.equal(r.state, 'NO_TRADE');
  assert.equal(r.gates.find((g) => g.ok === false)?.key, 'rr');
});

test('the method gate is listed only for the methods that have one', () => {
  const bars = path([...wave(60, 84_000, 20, 10), 84_060, 84_120, 84_180, 84_240, 84_300, 84_360]);
  const t = bars[bars.length - 1]!.time;
  bars.push({ time: t + 300, open: 84_360, high: 84_705, low: 84_355, close: 84_700, volume: 900 });
  const r = readMethod(MOMENTUM, 'single', '5m', single({ walls: [{ side: 'ask', price: 88_000, size: 1 }] }, bars));
  assert.equal(r.gates.at(-1)?.key, 'method');
  assert.match(r.gates.at(-1)!.rule, /no chase/);
  assert.equal(readMethod(BREAKOUT, 'single', '5m', single({})).gates.some((g) => g.key === 'method'), false);
});

test('[critical] a gate switched off still reads and shows ✗, but refuses nothing; Data fresh cannot be switched off', () => {
  const on = readMethod(BREAKOUT, 'single', '5m', single({ walls: NEAR_WALL }));
  assert.equal(on.state, 'NO_TRADE');
  const off = readMethod(BREAKOUT, 'single', '5m', single({ walls: NEAR_WALL, gatesOff: ['rr'] }));
  const rr = off.gates.find((g) => g.key === 'rr')!;
  assert.deepEqual([rr.ok, rr.enabled], [false, false], 'still read, still refusing on its own terms, but switched off');
  assert.equal(off.state, 'TRADE', 'nothing else refuses it');
  const bars = breakoutBars();
  const stale = readMethod(BREAKOUT, 'single', '5m', single({ now: nowAfter(bars, 3_600), gatesOff: ['data'] }, bars));
  assert.equal(stale.gates.find((g) => g.key === 'data')?.enabled, true);
  assert.equal(stale.state, 'NO_TRADE');
});

test('[critical] an entry zone is never wider than half an ATR, and it is kept at the edge price reaches first', () => {
  const FVG = METHODS.find((m) => m.id === 'fvg-retest')!;
  // A long: a wide gap under price. Whatever the method asks for, the plan narrows it from the top.
  const bars = path(wave(60, 84_000, 20, 10));
  const a = atr(bars)!;
  const wide = { ...FVG, detect: () => ({ dir: 1 as const, steps: [], zone: [83_000, 83_900] as [number, number], stop: 82_900, triggerTime: bars.at(-1)!.time }) };
  const r = readMethod(wide, 'single', '5m', single({ gatesOff: ['rr', 'stop'] }, bars));
  assert.equal(r.state, 'TRADE');
  assert.equal(r.plan!.entryHi, 83_900, 'the top: where a long fills');
  assert.ok(Math.abs(r.plan!.entryHi - r.plan!.entryLo - MAX_ZONE_ATR * a) < 1e-6, 'half an ATR, not 900 points');
});

test('[critical] risk and R:R are measured from where the trade fills -- the near edge -- not the middle of the zone', () => {
  assert.equal(fillOf({ entryLo: 100, entryHi: 110 }, 1), 110, 'a long fills at the top');
  assert.equal(fillOf({ entryLo: 100, entryHi: 110 }, -1), 100, 'a short at the bottom');
  const r = readMethod(BREAKOUT, 'single', '5m', single({ gatesOff: ['rr'] }));
  const p = r.plan!;
  assert.ok(Math.abs(p.rr - rrOf(fillOf(p, r.dir === 'long' ? 1 : -1), p.stop, p.tp1)) < 1e-12);
});

test('[critical] targets are spaced: TP2 at least half an ATR past TP1 -- a level 29 points on is skipped, not a second target', () => {
  const bars = path(wave(60, 84_000, 20, 10));
  const a = atr(bars)!;
  const close = bars.at(-1)!.close;
  const FVG = METHODS.find((m) => m.id === 'fvg-retest')!;
  // A short: entry just over the close, and three levels under it -- the second only 29 points past the first.
  const shortSetup = { ...FVG, detect: () => ({
    dir: -1 as const, steps: [], zone: [close, close + 20] as [number, number], stop: close + 300, triggerTime: bars.at(-1)!.time,
    targets: [{ price: close - 100, why: 'first' }, { price: close - 129, why: 'too close' }, { price: close - 100 - Math.ceil(TP_STEP_ATR * a) - 5, why: 'far enough' }],
  }) };
  const r = readMethod(shortSetup, 'single', '5m', single({ gatesOff: ['rr', 'stop'] }, bars));
  assert.equal(r.plan!.tp1, close - 100);
  assert.equal(r.plan!.tp2, close - 100 - Math.ceil(TP_STEP_ATR * a) - 5, 'the level 29 points on is skipped');
  assert.deepEqual(r.plan!.tpWhy.slice(0, 2), ['first', 'far enough']);
  // No level far enough: no TP2, rather than an invented one.
  const none = { ...FVG, detect: () => ({ ...shortSetup.detect(), targets: [{ price: close - 100, why: 'first' }, { price: close - 129, why: 'too close' }] }) };
  const n = readMethod(none, 'single', '5m', single({ gatesOff: ['rr', 'stop'] }, bars));
  assert.ok(n.plan!.tp2 === null || (close - 100 - n.plan!.tp2) >= TP_STEP_ATR * a, 'never within half an ATR of TP1');
});

test('[critical] the execution step reads the live price: the tape\'s last trade while fresh, else the last closed 1m candle', () => {
  const base = withChain();
  const exec = (r: ReturnType<typeof readMethod>) => r.steps.find((s) => s.tf === '1m')!;
  // Fresh LTP at the entry: in, and it says so.
  const live = readMethod(BREAKOUT, 'mtf', '5m', { ...base, ltp: { price: 84_190, at: base.now - 2_000 } });
  assert.equal(exec(live).ok, true);
  assert.match(exec(live).label, /LTP 84,190/);
  // Fresh LTP far above the zone: the price has left it, whatever the last closed candle said.
  const gone = readMethod(BREAKOUT, 'mtf', '5m', { ...base, ltp: { price: 86_000, at: base.now - 2_000 } });
  assert.equal(exec(gone).ok, false);
  assert.equal(gone.state, 'WAIT');
  // A stale LTP (the socket down) is not the price: the last closed 1m close is.
  const stale = readMethod(BREAKOUT, 'mtf', '5m', { ...base, ltp: { price: 86_000, at: base.now - 60_000 } });
  assert.match(exec(stale).label, /last 1m close/);
  assert.equal(exec(stale).ok, true);
});

// ------------------------------------------------------------ the owner's SL/TP table (1 Oct 2026)

const L = (price: number, kind: 'own' | 'entry' | 'htf' | 'wall' | 'oi', why = `${kind} ${price}`) => ({ price, why, kind });
const PICK = { dir: 1 as const, a: 100, entry: 84_000, risk: 150, emEdge: null };

test('[critical] TP2 is the next 1H/4H liquidity, not merely the next level; TP1 the nearest of any kind', () => {
  const levels = [L(84_120, 'entry'), L(84_180, 'wall'), L(84_260, 'entry'), L(84_400, 'htf')];
  const t = pickTargets({ tp1: 'nearest', tp2: 'htf' }, levels, PICK);
  assert.deepEqual([t.tp1, t.tp2, t.tp3], [84_120, 84_400, null]);
  // No HTF level past TP1: the next real level of any kind, never an invented one.
  assert.equal(pickTargets({ tp1: 'nearest', tp2: 'htf' }, levels.slice(0, 3), PICK).tp2, 84_180, 'the wall, 60 past TP1 (over 0.5 ATR)');
});

test('[critical] VWAP reversion: TP1 is the VWAP even with a swing nearer, TP2 the band past it', () => {
  const levels = [L(84_090, 'entry'), L(84_200, 'own', 'VWAP 84,200'), L(84_350, 'own', 'VWAP +1σ 84,350')];
  const t = pickTargets({ tp1: 'own', tp2: 'own' }, levels, PICK);
  assert.deepEqual([t.tp1, t.tp2, t.why.slice(0, 2)], [84_200, 84_350, ['VWAP 84,200', 'VWAP +1σ 84,350']]);
});

test('[critical] FVG and pullback take the previous swing on the entry timeframe as TP1', () => {
  const t = pickTargets({ tp1: 'swing', tp2: 'next' }, [L(84_080, 'wall'), L(84_150, 'entry'), L(84_300, 'htf')], PICK);
  assert.deepEqual([t.tp1, t.tp2], [84_150, 84_300]);
});

test('[critical] order flow aims TP2 at the next book wall; options at the next OI wall, with max pain as TP3 past it', () => {
  const levels = [L(84_100, 'entry'), L(84_300, 'htf'), L(84_450, 'wall'), L(84_600, 'oi')];
  assert.equal(pickTargets({ tp1: 'nearest', tp2: 'book' }, levels, PICK).tp2, 84_450);
  const o = pickTargets({ tp1: 'nearest', tp2: 'oi' }, levels, { ...PICK, ownTp3: { price: 85_000, why: 'max pain 85,000' }, emEdge: 85_500 });
  assert.deepEqual([o.tp1, o.tp2, o.tp3, o.why[2]], [84_100, 84_600, 85_000, 'max pain 85,000']);
  // Max pain behind TP2 is no target: the expected-move edge instead.
  assert.equal(pickTargets({ tp1: 'nearest', tp2: 'oi' }, levels, { ...PICK, ownTp3: { price: 84_550, why: 'mp' }, emEdge: 85_500 }).tp3, 85_500);
});

test('TP2 and TP3 are each at least half an ATR past the one before; with nothing past the zone, TP1 is 2R and says so', () => {
  const t = pickTargets({ tp1: 'nearest', tp2: 'next' }, [L(84_100, 'entry'), L(84_130, 'entry')], { ...PICK, emEdge: 84_140 });
  assert.deepEqual([t.tp2, t.tp3], [null, null], '30 and 40 points past TP1 are under 0.5 ATR (50)');
  assert.deepEqual(pickTargets({ tp1: 'nearest', tp2: 'htf' }, [], PICK), { tp1: 84_300, tp2: null, tp3: null, why: ['2R -- no level found beyond the entry'] });
});

test('every method has its target rule from the table', () => {
  const spec = Object.fromEntries(METHODS.map((m) => [m.n, `${m.targets.tp1}/${m.targets.tp2}`]));
  assert.deepEqual(spec, {
    1: 'nearest/htf', 2: 'nearest/htf', 3: 'nearest/htf', 4: 'swing/next', 5: 'nearest/htf', 6: 'nearest/htf',
    7: 'nearest/htf', 8: 'nearest/next', 9: 'swing/htf', 10: 'own/own', 11: 'nearest/book', 12: 'nearest/oi',
  });
});

