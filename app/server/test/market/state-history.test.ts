import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVAL_WINDOW_MIN, evaluateSignalOutcome, gradeStates, noteState, outcomeFor, outcomeWords, recentStates, stateHistorySchema,
} from '../../src/market/state-history.js';
import { closePool, one, query } from '../../src/db/pool.js';
import type { StateRead } from '../../src/market/state-read.js';
import type { Candle } from '../../src/market/delta.js';
import type { Plan } from '../../src/domain/market-state.js';

const bar = (high: number, low: number): Candle =>
  ({ time: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1 });

const long: Plan = { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 };
const short: Plan = { side: 'DOWN', trigger: 86_200, target1: 85_800, target2: 85_400, invalidation: 86_600 };

test('[critical] a setup whose trigger was never reached did not happen', () => {
  /*
   * The bug that made the history useless (24 Sep 2026). A breakout watch says
   * "over 86,800 this goes to 87,200". If price never reached 86,800 there was
   * no trade to be right or wrong about -- and the old grader called it WRONG,
   * so the screen filled with red for calls that were never anything but a
   * plan. Nothing happened. That is what it says now.
   */
  const never = [bar(86_700, 86_500), bar(86_650, 86_400)];
  assert.equal(outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: never }), 'NOT_TRIGGERED');
  // and the same for a breakdown that never broke down
  assert.equal(
    outcomeFor({ plan: short, side: 'DOWN', stage: 'WATCH', after: [bar(86_500, 86_300)] }),
    'NOT_TRIGGERED',
  );
});

test('[critical] once it triggers, the target before the invalidation is the target hit', () => {
  const triggered = [bar(86_900, 86_700), bar(87_250, 86_850)];
  assert.equal(outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: triggered }), 'TARGET_HIT');
  assert.equal(
    outcomeFor({ plan: short, side: 'DOWN', stage: 'WATCH', after: [bar(86_150, 85_750)] }),
    'TARGET_HIT',
  );
});

test('[critical] triggered and then through the invalidation is invalidated', () => {
  assert.equal(
    outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: [bar(86_900, 86_700), bar(86_800, 86_350)] }),
    'INVALIDATED',
  );
  // A bar that reached both counts against: the order is not in the bar.
  assert.equal(
    outcomeFor({ plan: long, side: 'UP', stage: 'CONFIRMED', after: [bar(87_300, 86_300)] }),
    'INVALIDATED',
  );
});

test('[critical] a confirmed state is already through its trigger', () => {
  // Price was past the level when the desk called it, so the trigger is not
  // asked for again -- only what happened next.
  assert.equal(
    outcomeFor({ plan: long, side: 'UP', stage: 'CONFIRMED', after: [bar(87_250, 86_900)] }),
    'TARGET_HIT',
  );
});

test('triggered, and then neither, is expired -- not a miss', () => {
  // Price drifted. Counting that either way would be choosing an answer
  // rather than measuring one.
  assert.equal(
    outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: [bar(86_900, 86_700), bar(87_100, 86_900)] }),
    'EXPIRED',
  );
  assert.equal(outcomeFor({ plan: long, side: 'UP', stage: 'WATCH', after: [] }), 'EXPIRED');
});

test('a call with no plan behind it is not graded at all', () => {
  assert.equal(outcomeFor({ plan: null, side: null, stage: 'RANGE', after: [bar(87_300, 86_300)] }), 'NOT_GRADED');
  assert.equal(outcomeFor({ plan: long, side: null, stage: 'RANGE', after: [bar(87_300, 86_300)] }), 'NOT_GRADED');
});

test('[critical] each timeframe is given a window its own move fits in', () => {
  // Four bars is right for a five-minute chart and far too short for an hourly
  // one: an hourly setup that needs an afternoon was done in four hours.
  assert.equal(EVAL_WINDOW_MIN['5m'], 30);
  assert.equal(EVAL_WINDOW_MIN['1h'], 240);
  assert.ok(EVAL_WINDOW_MIN['4h']! > EVAL_WINDOW_MIN['1h']!);
});

test('[critical] the word "wrong" is not on the live screen at all', () => {
  /*
   * It belongs on a backtest page, after a window has closed, beside what was
   * predicted and what happened. On a live screen most of what it marked had
   * not finished yet.
   */
  assert.equal(outcomeWords('TARGET_HIT'), 'Target hit');
  assert.equal(outcomeWords('INVALIDATED'), 'Invalidated');
  assert.equal(outcomeWords('NOT_TRIGGERED'), 'Not triggered');
  assert.equal(outcomeWords('EXPIRED'), 'Expired');
  assert.equal(outcomeWords('NOT_GRADED'), '—');
  assert.equal(outcomeWords(null), 'Waiting', 'still inside its window says so');
  for (const o of ['TARGET_HIT', 'INVALIDATED', 'NOT_TRIGGERED', 'EXPIRED', 'NOT_GRADED', null] as const) {
    assert.doesNotMatch(outcomeWords(o), /wrong/i);
  }
});

/*
 * What a call is worth answering for, the row has to hold. The first version
 * kept the verdict and the levels only, which lists the calls and cannot
 * answer the one question worth asking of them -- which readings ever paid --
 * because the inputs cannot be worked out again from the bars afterwards.
 */
const read = (over: Partial<StateRead> = {}): StateRead => ({
  at: Date.UTC(2026, 8, 23, 6, 0),
  tf: '15m',
  bars: [{ time: 1_758_600_000, open: 86_400, high: 86_700, low: 86_300, close: 86_554, volume: 342 }],
  state: {
    event: 'BREAKOUT_WATCH', stage: 'WATCH', side: 'UP', confirmed: false,
    level: { resistance: 86_800, support: 86_200 }, against: 86_800, distance: -246, confidence: 76,
    parts: { levelBreak: 0.3, volume: 1, candle: 0.8, retest: 0, flow: 0.9, mtf: 0.71, regime: 1 },
    checks: [{ label: 'Close over 86,800', ok: false }],
    plan: { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 },
    plans: {
      up: { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 },
      down: { side: 'DOWN', trigger: 86_200, target1: 85_800, target2: 85_400, invalidation: 86_600 },
    },
    volumeRatio: 1.8, volumeRead: 'STRONG',
    words: 'Price is near resistance.',
    insight: 'If 86,800 breaks, the next move is towards 87,200.',
  },
  patterns: {
    all: [],
    shown: [{ name: 'Ascending Triangle', bias: 'BULLISH', kind: 'structure', note: 'Higher lows', barsAgo: 0 }],
  },
  indicators: {
    all: [],
    shown: [{ key: 'rsi', label: 'RSI (14)', value: 62, text: '62', read: 'Neutral', bias: 'NEUTRAL', gauge: 0.62 }],
  },
  lines: [],
  inputs: {
    atr: 400, oiChangePct: 2.1, cvdSlope: 120, aggressorBuyPct: 58,
    mtf: { up: 5, down: 2, total: 7 }, regime: 'TREND_UP',
  },
  ...over,
} as StateRead);

beforeEach(async () => { await stateHistorySchema(); await query('TRUNCATE market_states'); });
after(() => closePool());

test('[critical] the whole reading is written down with the call, not just the verdict', async () => {
  const id = await noteState(read());
  assert.ok(id);
  const row = await one<{
    words: string; insight: string; volume_ratio: number; atr: number;
    parts: Record<string, number>; inputs: Record<string, unknown>;
    patterns: { name: string }[]; indicators: { key: string }[];
  }>('SELECT words, insight, volume_ratio, atr, parts, inputs, patterns, indicators FROM market_states WHERE id = $1', [id]);
  assert.equal(row?.insight, 'If 86,800 breaks, the next move is towards 87,200.');
  assert.equal(row?.volume_ratio, 1.8);
  assert.equal(row?.atr, 400);
  assert.equal(row?.parts.mtf, 0.71);
  assert.equal(row?.inputs.regime, 'TREND_UP');
  assert.equal(row?.patterns[0]?.name, 'Ascending Triangle');
  assert.equal(row?.indicators[0]?.key, 'rsi');
});

test('the same state again is not a second row, and a different one is', async () => {
  // A row per poll would be a journal of how often the screen was open.
  assert.ok(await noteState(read()));
  assert.equal(await noteState(read()), null);
  const moved = read();
  assert.ok(await noteState({ ...moved, state: { ...moved.state, event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED' } }));
  const n = await one<{ n: string }>('SELECT COUNT(*) AS n FROM market_states');
  assert.equal(Number(n?.n), 2);
});

test('[critical] the list carries where price went, not only whether the plan worked', async () => {
  /*
   * The verdict answers "did the plan work"; the points answer "what did BTC
   * do", which is the other half. Recorded at grading rather than worked out
   * from the next row, which would make the figure depend on when the screen
   * happened to be open.
   */
  const id = await noteState(read());
  await query(
    'UPDATE market_states SET outcome = $1, graded_at = $2, resolved_close = $3, move_pts = $4 WHERE id = $5',
    ['TARGET_HIT', Date.now(), 86_904, 350, id],
  );
  const [row] = await recentStates('15m', 5);
  assert.equal(row?.outcome, 'TARGET_HIT');
  assert.equal(row?.resolvedClose, 86_904);
  assert.equal(row?.movePts, 350);
  assert.equal(row?.close, 86_554);
});

test('[critical] grading starts with the oldest ungraded call, not the newest', async () => {
  /*
   * It took the newest twenty at first, and the journal never graded anything.
   * The desk writes a row every time the state changes, so the newest ungraded
   * calls are the youngest ones -- all still inside their window, all skipped
   * -- and the older rows that were ready never came up. Every row on the card
   * sat at "—" while the grader ran on every poll.
   *
   * Nothing here needs candles: what is being pinned is which rows a pass
   * looks at, so the assertion is that the old one is no longer ungraded and
   * the young one still is.
   */
  const day = 24 * 3_600_000;
  const old = await noteState(read({ at: Date.now() - day }));
  // Two dozen younger rows, more than one pass will take.
  for (let i = 0; i < 24; i++) {
    await noteState(read({
      at: Date.now() - i * 1_000,
      state: { ...read().state, event: i % 2 ? 'BREAKOUT_WATCH' : 'RANGE', stage: i % 2 ? 'WATCH' : 'RANGE' },
    }));
  }
  await gradeStates(Date.now(), 20);
  const row = await one<{ outcome: string | null }>('SELECT outcome FROM market_states WHERE id = $1', [old]);
  assert.notEqual(row?.outcome, null, 'the day-old call was graded');
  const young = await one<{ n: string }>(
    'SELECT COUNT(*) AS n FROM market_states WHERE outcome IS NULL AND at > $1', [Date.now() - 60_000],
  );
  assert.ok(Number(young?.n) > 0, 'calls whose bars have not happened yet are left alone');
});

test('[critical] signal evaluation records first hit, timestamps, and excursions (MFE/MAE)', () => {
  const bars: Candle[] = [
    { time: 100, open: 86600, high: 86750, low: 86550, close: 86700, volume: 10 },
    { time: 105, open: 86700, high: 86950, low: 86700, close: 86900, volume: 15 },
    { time: 110, open: 86900, high: 87250, low: 86900, close: 87000, volume: 20 },
    { time: 115, open: 87000, high: 87050, low: 86800, close: 86850, volume: 10 },
  ];
  const audit = evaluateSignalOutcome({
    plan: long,
    side: 'UP',
    stage: 'WATCH',
    callAt: 95_000,
    closeAtCall: 86_600,
    windowMs: 30 * 60_000,
    after: bars,
  });

  assert.equal(audit.outcome, 'TARGET_HIT');
  assert.equal(audit.firstHit, 'TARGET');
  assert.equal(audit.firstHitPrice, 87_200);
  assert.equal(audit.firstHitTime, 110_000);
  assert.equal(audit.triggeredAt, 105_000);
  assert.equal(audit.mfePrice, 87_250);
  assert.equal(audit.mfe, 450); // 87,250 - 86,800
});

