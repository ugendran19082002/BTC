import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from '../../src/market/delta.js';
import { allReads, entryBoard, fillOf, MAX_TP1_R, pickTargets, TP1_FALLBACK_R, readMethod, rrOf, targetLevels, zoneOf, timeframeRows, MAX_ZONE_ATR, MIN_RR, TP_STEP_ATR } from '../../src/entry/engine.js';
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
/** An ask wall just over the breakout and nothing past it: TP1 under 1R -- no room (the 2R fallback with no wall clears it). */
const NEAR_WALL = [{ side: 'ask' as const, price: 84_250, size: 5_000 }];
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
  // The ask wall is ~8R away -- past the 2R band -- so TGT1 is 1.5R and the wall is TGT2.
  const fill = r.plan.entryHi, risk = fill - r.plan.stop;
  assert.ok(Math.abs(r.plan.tp1 - (fill + 1.5 * risk)) < 1e-6);
  assert.match(r.plan.tpWhy[0]!, /^1\.5R -- no level between 1R and 2R \(the next, ask wall 84,900, is \d+\.\dR\)$/);
  assert.equal(r.plan.tp2, 84_900);
  assert.ok(r.plan.rr >= MIN_RR);
  assert.ok(r.plan.stop < 84_120, 'the stop sits past the breakout candle, with a buffer');
  assert.match(r.plan.why!.stop, /^the breakout candle's far end 84,120 − 0\.25 ATR$/, 'the SL says its structure and buffer');
  assert.equal(r.plan.why!.tp2, 'ask wall 84,900');
});

test('[critical] a step not yet there is WAIT, says which, and draws no box', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({}, breakoutBars({ volume: 100 })));
  assert.equal(r.state, 'WAIT');
  assert.match(r.reason, /waiting for 5m: RVOL 1.5 or more/);
  assert.equal(r.plan, null, 'TEST.md: no entry / SL / TP until every confirmation holds');
});

test('[critical] no room to a target is NO TRADE, even with every step green -- a near wall leaves TP1 under 1R', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ walls: NEAR_WALL }));
  assert.equal(r.state, 'NO_TRADE');
  assert.equal(r.gates.find((g) => g.ok === false)?.key, 'rr');
  assert.match(r.reason, /R:R to ask wall 84,250 is 0\.\d\d -- no room/);
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

test('[critical] the board is every method with the chain, then every method without -- the twelve first', () => {
  const board = entryBoard(withChain()), n = METHODS.length;
  assert.equal(board.length, 2 * n);
  assert.deepEqual(board.slice(0, n).map((r) => [r.n, r.mode]), METHODS.map((m) => [m.n, 'mtf']));
  assert.deepEqual(board.slice(n).map((r) => [r.n, r.mode]), METHODS.map((m) => [m.n, 'single']));
  assert.deepEqual(board.slice(0, 12).map((r) => r.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'the twelve first');
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
  assert.deepEqual(r.gates.map((g) => g.key), ['data', 'plan', 'spread', 'mark', 'stop', 'rr', 'htf', 'big-move', 'em', 'settle']);
  for (const g of r.gates) assert.ok(g.rule.length > 0 && g.value !== undefined, `${g.key} says its rule and what it read`);
  const htf = r.gates.find((g) => g.key === 'htf')!;
  assert.equal(htf.ok, null, 'without the chain the HTF gate is not part of the read -- listed, never "passed"');
  assert.match(r.gates.find((g) => g.key === 'rr')!.value!, /^\d+\.\d\d$/);
});

test('[critical] a gate that was not read refuses nothing, and a failed one is the reason', () => {
  const r = readMethod(BREAKOUT, 'single', '5m', single({ walls: NEAR_WALL }));
  assert.equal(r.gates.find((g) => g.key === 'spread')?.ok, null, 'no spread read');
  assert.equal(r.gates.find((g) => g.key === 'mark')?.ok, null, 'no mark read: not read, never passed');
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
  // A long: a wide gap reaching up to just under the price. Whatever the method asks for, the plan narrows it
  // from the top. (Right under the price, so the plan stays in play -- Plan valid, 1 Oct 2026 audit.)
  const bars = path(wave(60, 84_000, 20, 10));
  const a = atr(bars)!;
  const top = bars.at(-1)!.close - 5;
  const wide = { ...FVG, detect: () => ({
    dir: 1 as const, steps: [], zone: [top - 900, top] as [number, number], stop: top - 1_000, triggerTime: bars.at(-1)!.time,
    targets: [{ price: top + 3_000, why: 'far above' }],
  }) };
  const r = readMethod(wide, 'single', '5m', single({ gatesOff: ['rr', 'stop'] }, bars));
  assert.equal(r.state, 'TRADE', JSON.stringify(r.gates.filter((g) => g.ok === false)));
  assert.equal(r.plan!.entryHi, top, 'the top: where a long fills');
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
  // And the plan is no longer a trade at all: at 86,000 the price is past TGT1 (Plan valid, 1 Oct 2026 audit).
  assert.equal(gone.state, 'NO_TRADE');
  assert.match(gone.reason, /already reached TGT1|ATR from the price/);
  // A stale LTP (the socket down) is not the price: the last closed 1m close is.
  const stale = readMethod(BREAKOUT, 'mtf', '5m', { ...base, ltp: { price: 86_000, at: base.now - 60_000 } });
  assert.match(exec(stale).label, /last 1m close/);
  assert.equal(exec(stale).ok, true);
});

// ------------------------------------------------------------ the owner's SL/TP tables (1 Oct 2026)

const L = (price: number, kind: 'own' | 'entry' | 'htf' | 'wall' | 'oi', why = `${kind} ${price}`) => ({ price, why, kind });
/** The owner's example: a long filled at 84,000, SL 83,800 -- risk 200. 1 ATR = 100. */
const PICK = { dir: 1 as const, a: 100, entry: 84_000, risk: 200, emEdge: null, minRr: 1.8, maxRr: 3 };

test('[critical] TP1 is the nearest VALID target, not the nearest: 0.75R and 1R are skipped, 2R taken -- and it says so', () => {
  const levels = [L(84_150, 'entry'), L(84_200, 'entry'), L(84_400, 'entry'), L(84_800, 'htf'), L(85_200, 'htf')];
  const t = pickTargets({ tp1: 'nearest', tp2: 'htf' }, levels, PICK);
  assert.equal(t.tp1, 84_400, '84,150 is 0.75R and 84,200 1.00R, under 1.8R; 84,400 is 2.00R');
  assert.equal(t.why[0], 'entry 84400 (2 nearer under 1.8R skipped)');
  assert.equal(t.tp2, 84_800, 'then the next HTF level');
});

test('[critical] the method looks at its own kind first: a continuation swing before a nearer wall, a book wall before a swing, the OI wall first', () => {
  const levels = [L(84_380, 'wall'), L(84_420, 'oi'), L(84_460, 'entry'), L(84_900, 'htf'), L(85_100, 'wall')];
  assert.equal(pickTargets({ tp1: 'swing', tp2: 'htf' }, levels, PICK).tp1, 84_460);
  assert.equal(pickTargets({ tp1: 'book', tp2: 'book' }, levels, PICK).tp1, 84_380);
  assert.equal(pickTargets({ tp1: 'oi', tp2: 'oi' }, levels, PICK).tp1, 84_420);
  assert.equal(pickTargets({ tp1: 'nearest', tp2: 'htf' }, levels, PICK).tp1, 84_380, 'any kind: the nearest that pays');
  // Its own kind does not pay: the nearest of any kind that does.
  assert.equal(pickTargets({ tp1: 'swing', tp2: 'htf' }, [L(84_100, 'entry'), L(84_500, 'htf')], PICK).tp1, 84_500);
});

test('[critical] nothing pays 1.8R: TP1 is the nearest of its kind, and the R:R gate will refuse -- never a made-up far target', () => {
  const t = pickTargets({ tp1: 'swing', tp2: 'htf' }, [L(84_150, 'wall'), L(84_200, 'entry'), L(84_300, 'htf')], PICK);
  assert.equal(t.tp1, 84_200);
  assert.equal(t.why[0], 'entry 84200', 'no "skipped" note when it is not a valid target either');
  assert.deepEqual(pickTargets({ tp1: 'nearest', tp2: 'htf' }, [], PICK), { tp1: 84_300, tp2: null, tp3: null, why: ['1.5R -- no level found beyond the entry'] });
});

test('[critical] VWAP reversion: TP1 is the VWAP whatever it pays -- reverting to it is the method -- and TP2 the band past it', () => {
  const levels = [L(84_090, 'entry'), L(84_200, 'own', 'VWAP 84,200'), L(84_350, 'own', 'VWAP +1σ 84,350'), L(84_600, 'htf')];
  const t = pickTargets({ tp1: 'own', tp2: 'own' }, levels, PICK);
  assert.deepEqual([t.tp1, t.tp2, t.why.slice(0, 2)], [84_200, 84_350, ['VWAP 84,200', 'VWAP +1σ 84,350']]);
});

test('[critical] TP2 from the method\'s pool past TP1; options take the next OI wall, with max pain as TP3 past it', () => {
  const levels = [L(84_400, 'entry'), L(84_500, 'htf'), L(84_700, 'wall'), L(84_900, 'oi'), L(85_000, 'oi')];
  assert.equal(pickTargets({ tp1: 'nearest', tp2: 'htf' }, levels, PICK).tp2, 84_500);
  assert.equal(pickTargets({ tp1: 'nearest', tp2: 'book' }, levels, PICK).tp2, 84_700);
  const o = pickTargets({ tp1: 'oi', tp2: 'oi' }, levels, { ...PICK, maxRr: 5, ownTp3: { price: 85_400, why: 'max pain 85,400' }, emEdge: 85_900 });
  assert.deepEqual([o.tp1, o.tp2, o.tp3, o.why[2]], [84_900, 85_000, 85_400, 'max pain 85,400']);
  assert.equal(pickTargets({ tp1: 'oi', tp2: 'oi' }, levels, { ...PICK, maxRr: 5, ownTp3: { price: 84_950, why: 'mp' }, emEdge: 85_900 }).tp3, 85_900,
    'max pain behind TP2 is no target: the expected-move edge instead');
  // Nothing of the pool past TP1: the next real level of any kind.
  assert.equal(pickTargets({ tp1: 'nearest', tp2: 'htf' }, [L(84_400, 'entry'), L(84_460, 'wall')], PICK).tp2, 84_460);
});

test('TP2 and TP3 are each at least half an ATR past the one before', () => {
  const t = pickTargets({ tp1: 'nearest', tp2: 'next' }, [L(84_400, 'entry'), L(84_430, 'entry')], { ...PICK, emEdge: 84_440 });
  assert.deepEqual([t.tp2, t.tp3], [null, null], '30 and 40 points past TP1 are under 0.5 ATR (50)');
});

test('[critical] a swing price has already traded through is consumed -- no target', () => {
  // Swing highs at 84,300, 84,350 and 84,500: the first two each taken out by a later bar, the last still standing.
  const bars = path([84_000, 84_100, 84_300, 84_100, 84_000, 84_050, 84_350, 84_150, 84_100, 84_500, 84_200, 84_100, 84_050], { w: 5 });
  const swings = targetLevels(1, 84_060, bars, ctxOf({ walls: [] }), undefined).filter((l) => l.kind === 'entry').map((l) => l.price);
  assert.ok(swings.length > 0 && swings.every((p) => p >= 84_500), `only the standing swing: ${swings.join(', ')}`);
});

test('every method has its target rule from the tables', () => {
  const spec = Object.fromEntries(METHODS.slice(0, 12).map((m) => [m.n, `${m.targets.tp1}/${m.targets.tp2}`]));
  assert.deepEqual(spec, {
    1: 'swing/htf', 2: 'swing/htf', 3: 'nearest/htf', 4: 'swing/next', 5: 'swing/htf', 6: 'swing/htf',
    7: 'nearest/htf', 8: 'nearest/next', 9: 'swing/htf', 10: 'own/own', 11: 'book/book', 12: 'oi/oi',
  });
});

test('[critical] the entry zone never reaches past its own stop: kept 0.1 ATR on the safe side, either way', () => {
  // The live 1m retest long: stop 83,789.71, zone 83,789.50-83,793.79 -- its low was below the stop.
  const long = zoneOf(1, 83_789.5, 83_793.79, 83_789.71, 10);
  assert.deepEqual([long.lo, long.hi], [83_790.71, 83_793.79]);
  const short = zoneOf(-1, 83_470.55, 83_484, 83_483.45, 100); // its high was above its stop
  assert.equal(short.lo, 83_470.55);
  assert.ok(Math.abs(short.hi - 83_473.45) < 1e-6, `kept 10 under the stop: ${short.hi}`);
  // Nothing left between the stop and the far edge: a zero-width zone at the fill edge; the stop band gate judges the risk.
  const sliver = zoneOf(1, 99, 100, 99.95, 10);
  assert.deepEqual([sliver.lo, sliver.hi], [100, 100]);
  // A zone well clear of its stop is left as it was.
  assert.deepEqual(zoneOf(1, 84_000, 84_040, 83_800, 100), { lo: 84_000, hi: 84_040 });
});

test('[critical] TGT1 is a real level between 1R and 2R (owner, 1 Oct 2026): 0.75R skipped, 1.00R taken; the gate agrees', () => {
  assert.deepEqual([MIN_RR, MAX_TP1_R, TP1_FALLBACK_R], [1, 2, 1.5]);
  const levels = [L(84_150, 'entry'), L(84_200, 'entry'), L(84_400, 'entry'), L(84_800, 'htf'), L(85_200, 'htf')];
  const { minRr: _m, maxRr: _x, ...atDefault } = PICK;
  const t = pickTargets({ tp1: 'nearest', tp2: 'htf' }, levels, atDefault);
  assert.deepEqual([t.tp1, t.why[0], t.tp2], [84_200, 'entry 84200 (1 nearer under 1R skipped)', 84_800]);
});

test('[critical] nothing real between 1R and 2R: TGT1 is 1.5R, says why, and the far level becomes TGT2 -- not a 6R TGT1', () => {
  const { minRr: _m, maxRr: _x, ...atDefault } = PICK;
  const t = pickTargets({ tp1: 'swing', tp2: 'htf' }, [L(84_100, 'entry'), L(85_200, 'htf', '4h swing high 85,200')], atDefault);
  assert.equal(t.tp1, 84_300);
  assert.equal(t.why[0], '1.5R -- no level between 1R and 2R (the next, 4h swing high 85,200, is 6.0R)');
  assert.equal(t.tp2, 85_200);
  // The method's own kind past 2R, another kind inside the band: the one inside the band.
  assert.equal(pickTargets({ tp1: 'swing', tp2: 'htf' }, [L(84_300, 'wall'), L(84_700, 'entry')], atDefault).tp1, 84_300);
  // VWAP reversion keeps VWAP even past 2R: reverting to it is the method.
  assert.equal(pickTargets({ tp1: 'own', tp2: 'own' }, [L(84_900, 'own', 'VWAP 84,900')], atDefault).tp1, 84_900);
});

test('[critical] the perpetual is the price; the mark checks it: a last trade far from the mark refuses -- a wick, not a level', () => {
  const at = (ltp: number, mark: number) => readMethod(BREAKOUT, 'single', '5m', single({
    ltp: { price: ltp, at: nowAfter(breakoutBars()) - 1_000 }, quote: { mark, index: mark + 40, at: nowAfter(breakoutBars()) - 1_000 },
  })).gates.find((g) => g.key === 'mark')!;
  assert.deepEqual([at(84_200, 84_190).ok, at(84_200, 84_190).value], [true, '0.012% off']);
  const wick = at(84_400, 84_200);
  assert.deepEqual([wick.ok, wick.why], [false, 'the last trade is 0.24% from the mark price -- a wick, not a level']);
  // A mark gone stale is not read.
  const stale = readMethod(BREAKOUT, 'single', '5m', single({ ltp: { price: 84_400, at: 0 }, quote: { mark: 84_200, index: null, at: 0 } }));
  assert.equal(stale.gates.find((g) => g.key === 'mark')!.ok, null);
});

test('[critical] 2h is read exactly as any other timeframe: the same bars give the same TRADE, stop and targets (6 Oct 2026)', () => {
  // The 5m breakout's candles, laid on 2h bars: a method reads prices, not the length of a bar.
  const TWO_H = 7_200;
  const five = breakoutBars();
  const t0 = Math.ceil(five[0]!.time / TWO_H) * TWO_H;
  const two = five.map((b, i) => ({ ...b, time: t0 + i * TWO_H }));
  const ctx = (bars: readonly Candle[], tfSec: number, tf: '5m' | '2h') => ctxOf({
    now: (bars[bars.length - 1]!.time + tfSec + 5) * 1000, frames: { [tf]: bars }, walls: [{ side: 'ask', price: 84_900, size: 5_000 }],
  });
  const on5 = readMethod(BREAKOUT, 'single', '5m', ctx(five, 300, '5m'));
  const on2 = readMethod(BREAKOUT, 'single', '2h', ctx(two, TWO_H, '2h'));
  assert.equal(on2.state, 'TRADE', on2.reason);
  assert.equal(on2.tf, '2h');
  assert.deepEqual([on2.dir, on2.plan!.entryLo, on2.plan!.entryHi, on2.plan!.stop, on2.plan!.tp1, on2.plan!.tp2],
    [on5.dir, on5.plan!.entryLo, on5.plan!.entryHi, on5.plan!.stop, on5.plan!.tp1, on5.plan!.tp2]);
  assert.equal(on2.triggerTime, two[two.length - 1]!.time, 'triggered by its own last closed 2h bar');
  // Its candles gone stale is NO TRADE, by its own bar length -- as for every timeframe.
  const stale = readMethod(BREAKOUT, 'single', '2h', { ...ctx(two, TWO_H, '2h'), now: (two[two.length - 1]!.time + TWO_H * 4) * 1000 });
  assert.equal(stale.state, 'NO_TRADE');
  // With no 2h candles it says so, and the chain is untouched: 2h is not one of its steps.
  assert.match(readMethod(BREAKOUT, 'single', '2h', ctxOf({ frames: { '5m': five } })).reason, /not enough 2h candles/);
  assert.ok(!timeframeRows(ctxOf({ frames: { '2h': two } })).some((r) => (r.tf as string) === '2h'));
});

test('[critical] adding 2h changes nothing that was there: every existing timeframe, and the chain, reads the same with 2h candles as without (6 Oct 2026)', () => {
  // Every one of the 81 methods, with the chain and on each timeframe that was read before -- the whole board.
  const before = ['3m', '5m', '15m', '30m', '1h', '4h'] as const;
  for (const o of [{}, { h1: -6, h4: -6 }, { bull3m: false }] as const) {
    const without = withChain(o);
    const withTwo: EntryContext = { ...without, frames: { ...without.frames, '2h': htf(7_200, -9) } };
    // A 2h trend the other way from everything else: if any read looked at it, it would show.
    assert.deepEqual(allReads(withTwo, before), allReads(without, before));
    assert.deepEqual(entryBoard(withTwo, '5m'), entryBoard(without, '5m'));
  }
  // And the 2h reads are there beside them, one per method.
  const all = allReads(withChain());
  assert.equal(all.filter((r) => r.mode === 'single' && r.tf === '2h').length, METHODS.length);
  assert.equal(all.filter((r) => r.mode === 'mtf').length, METHODS.length, 'the chain is still read once, on 5m');
});
