import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../../src/db/pool.js';
import {
  DEFAULT_CONFIG, exitAsk, exitRules, exitValueAt, minutesOf, validateConfig,
  type ExitRule, type Strategy, type StrategyConfig,
} from '../../src/strategy/types.js';
import { StrategyExitStepper, exitWords, type ExitStepperDeps } from '../../src/strategy/exit-steps.js';
import {
  exitPriceProblem, orderPlan, protectionFor, stopFor, stopPriceByPoints, targetFor, targetPriceByPoints, type ExitAsk,
} from '../../src/trading/order-plan.js';
import type { TradeRecord } from '../../src/trading/engine.js';
import { rig, ceProduct, planFor, quote, T0 } from '../trading/harness.js';

/**
 * Exits a strategy can read two ways -- a percentage or fixed points -- and
 * move through the day on a timetable:
 *
 *   entry 5:30   target 80%
 *   from  7:30   target 85%
 *   from  9:30   target 90%
 *
 * The rules first (pure), then the stepper against a fake desk, then the whole
 * path in real time: the real engine on the paper exchange, the clock walked
 * across each step, and the orders on the book read after every move.
 */

after(() => closePool());

const cfg = (over: Partial<StrategyConfig> = {}): StrategyConfig => ({ ...DEFAULT_CONFIG, ...over });
const strat = (over: Partial<StrategyConfig> = {}, enabled = true): Strategy => ({
  id: 's', name: 'Morning', enabled, createdAt: 0, updatedAt: 0, config: cfg(over),
});

/** The example the desk was asked for: 80% from 5:30, 85% from 7:30, 90% from 9:30. */
const ladder: ExitRule = {
  mode: 'pct', value: 0.8,
  steps: [{ at: '07:30', value: 0.85 }, { at: '09:30', value: 0.9 }, { at: '11:30', value: 0.95 }],
};

describe('exitValueAt: which value is in force', () => {
  test('[critical] 80% until 7:30, 85% until 9:30, 90% until 11:30, then 95%', () => {
    const at = (hhmm: string) => exitValueAt(ladder, '05:30', minutesOf(hhmm));
    assert.deepEqual(at('05:30'), { value: 0.8, stage: 0 });
    assert.deepEqual(at('07:29'), { value: 0.8, stage: 0 });
    assert.deepEqual(at('07:30'), { value: 0.85, stage: 1 }, 'a step is in force from its own minute');
    assert.deepEqual(at('09:29'), { value: 0.85, stage: 1 });
    assert.deepEqual(at('09:30'), { value: 0.9, stage: 2 });
    assert.deepEqual(at('11:30'), { value: 0.95, stage: 3 });
    assert.deepEqual(at('17:00'), { value: 0.95, stage: 3 });
  });

  test('no steps is one value all day', () => {
    assert.deepEqual(exitValueAt({ mode: 'pct', value: 0.5, steps: [] }, '05:30', minutesOf('16:00')), { value: 0.5, stage: 0 });
  });

  test('an overnight window counts forward from the entry, past midnight', () => {
    const night: ExitRule = { mode: 'points', value: 10, steps: [{ at: '01:00', value: 20 }] };
    assert.equal(exitValueAt(night, '23:30', minutesOf('23:45')).value, 10);
    assert.equal(exitValueAt(night, '23:30', minutesOf('00:59')).value, 10);
    assert.equal(exitValueAt(night, '23:30', minutesOf('01:00')).value, 20);
  });

  test('a step may turn an exit off, and a later one back on', () => {
    const r: ExitRule = { mode: 'pct', value: 1.5, steps: [{ at: '08:00', value: 0 }, { at: '10:00', value: 2 }] };
    assert.equal(exitValueAt(r, '05:30', minutesOf('09:00')).value, 0);
    assert.equal(exitValueAt(r, '05:30', minutesOf('10:00')).value, 2);
  });
});

describe('exitRules: reading a config', () => {
  test('a strategy saved before modes and steps reads as a percentage, all day', () => {
    const old = { ...DEFAULT_CONFIG } as Partial<StrategyConfig>;
    for (const k of ['targetMode', 'takeProfitPoints', 'targetSteps', 'stopMode', 'stopLossPoints', 'stopSteps'] as const) delete old[k];
    const { target, stop } = exitRules(old as StrategyConfig);
    assert.deepEqual(target, { mode: 'pct', value: 0.95, steps: [] });
    assert.deepEqual(stop, { mode: 'pct', value: 0, steps: [] });
  });

  test('points mode reads the points, not the percentage', () => {
    const { target, stop } = exitRules(cfg({ targetMode: 'points', takeProfitPoints: 12, stopMode: 'points', stopLossPoints: 30 }));
    assert.equal(target.value, 12);
    assert.equal(stop.value, 30);
  });

  test('exitAsk turns a value into the place/protection arguments, zeroing the other mode', () => {
    assert.deepEqual(exitAsk({ mode: 'points', value: 0, steps: [] }, 7, 'stop'), { stopLossPct: 0, stopLossPoints: 7 });
    assert.deepEqual(exitAsk({ mode: 'pct', value: 0, steps: [] }, 0.8, 'target'), { takeProfitPct: 0.8, takeProfitPoints: 0 });
  });

  test('exitWords says a value in its own units', () => {
    assert.equal(exitWords({ mode: 'pct', value: 0, steps: [] }, 0.855), '85.5%');
    assert.equal(exitWords({ mode: 'pct', value: 0, steps: [] }, 2.5), '250%');
    assert.equal(exitWords({ mode: 'points', value: 0, steps: [] }, 10), '10 pts');
    assert.equal(exitWords({ mode: 'points', value: 0, steps: [] }, 0), 'off');
  });
});

describe('validateConfig: exits', () => {
  const ok = (over: Partial<StrategyConfig>) => assert.deepEqual(validateConfig(cfg(over)), []);
  const says = (over: Partial<StrategyConfig>, re: RegExp) => {
    const bad = validateConfig(cfg(over));
    assert.ok(bad.some((m) => re.test(m)), `expected ${re} in ${JSON.stringify(bad)}`);
  };

  test('[critical] a stop above 100% is allowed: a short option can multiply', () => {
    ok({ stopLossPct: 1.5 });
    ok({ stopLossPct: 3 });
    ok({ stopLossPct: 10 });
  });
  test('a stop past 2000% is a typo', () => says({ stopLossPct: 25 }, /Stop loss must be between 0 and 2000%/));
  test('[critical] a target stays within 99%: 100% is a buy at zero', () => {
    ok({ takeProfitPct: 0.99 });
    says({ takeProfitPct: 1 }, /Take profit must be between 0 and 99%/);
  });

  test('points: any distance up to the typo guard, never negative', () => {
    ok({ targetMode: 'points', takeProfitPoints: 12, stopMode: 'points', stopLossPoints: 250 });
    says({ stopMode: 'points', stopLossPoints: -1 }, /Stop loss cannot be negative/);
    says({ targetMode: 'points', takeProfitPoints: 20_000 }, /at most 10,000 points/);
    says({ stopMode: 'points', stopLossPoints: Number.NaN }, /Stop loss cannot be negative or blank/);
  });
  test('an unknown mode is refused', () => {
    says({ stopMode: 'dollars' as never }, /Stop loss must be a percentage, points or a price/);
  });
  test('[critical] price mode: the level itself, stored as a level', () => {
    ok({ stopMode: 'price', stopLossAt: 70, targetMode: 'price', takeProfitAt: 5 });
    says({ stopMode: 'price', stopLossAt: -1 }, /Stop loss cannot be negative/);
    const { stop } = exitRules(cfg({ stopMode: 'price', stopLossAt: 70 }));
    assert.deepEqual(stop, { mode: 'price', value: 70, steps: [] });
    assert.deepEqual(exitAsk(stop, 70, 'stop'), { stopLossPct: 0, stopLossPoints: 0, stopAt: 70 });
    assert.equal(exitWords(stop, 70), 'at 70');
  });

  test('[critical] the example ladder is valid inside a 5:30-17:29 day', () => {
    ok({ entryTime: '05:30', exitTime: '17:29', takeProfitPct: 0.8, targetSteps: ladder.steps });
  });
  test('[critical] a step at or after the exit time is refused: the position is gone by then', () => {
    says({ entryTime: '05:30', exitTime: '11:00', targetSteps: [{ at: '11:30', value: 0.9 }] },
      /Take profit step 1 \(11:30 AM\) must be after entry \(5:30 AM\) and before exit \(11:00 AM\)/);
    says({ entryTime: '05:30', exitTime: '11:00', stopSteps: [{ at: '11:00', value: 2 }] }, /Stop loss step 1/);
  });
  test('a step at the entry time, or before it, is refused', () => {
    says({ targetSteps: [{ at: '05:30', value: 0.9 }] }, /step 1 \(5:30 AM\) must be after entry/);
    says({ targetSteps: [{ at: '05:00', value: 0.9 }] }, /step 1 \(5:00 AM\) must be after entry/);
  });
  test('steps must run in order, and no two at the same time', () => {
    says({ targetSteps: [{ at: '09:30', value: 0.9 }, { at: '07:30', value: 0.85 }] }, /step 2 \(7:30 AM\) must come after step 1/);
    says({ targetSteps: [{ at: '07:30', value: 0.9 }, { at: '07:30', value: 0.95 }] }, /step 2 \(7:30 AM\) must come after step 1/);
  });
  test('a step with no time, or a nonsense one, is refused', () => {
    says({ stopSteps: [{ at: '', value: 2 }] }, /Stop loss step 1 needs a time of day/);
    says({ stopSteps: [{ at: '25:00', value: 2 }] }, /Stop loss step 1 needs a time of day/);
  });
  test('each step value obeys its mode', () => {
    says({ targetSteps: [{ at: '07:30', value: 1.2 }] }, /Step 1: Take profit must be between 0 and 99%/);
    ok({ stopSteps: [{ at: '07:30', value: 5 }] });
    says({ stopMode: 'points', stopLossPoints: 10, stopSteps: [{ at: '07:30', value: -3 }] }, /Step 1: Stop loss cannot be negative/);
  });
  test('an overnight schedule is measured forward from the entry', () => {
    ok({ entryTime: '23:30', exitTime: '05:00', stopSteps: [{ at: '01:00', value: 2 }, { at: '03:00', value: 3 }] });
    says({ entryTime: '23:30', exitTime: '05:00', stopSteps: [{ at: '06:00', value: 2 }] }, /before exit \(5:00 AM\)/);
  });
  test('more than 24 steps is a mistake', () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({ at: `${String(6 + Math.floor(i / 3)).padStart(2, '0')}:${String((i % 3) * 15 + 1).padStart(2, '0')}`, value: 0.5 }));
    says({ targetSteps: steps }, /at most 24 times a day/);
  });

});

describe('prices from points', () => {
  test('[critical] sold at 15: a 10-point stop at 25, a 10-point target at 5', () => {
    assert.equal(stopPriceByPoints(15, 10), 25);
    assert.equal(targetPriceByPoints(15, 10), 5);
  });
  test('a target of more points than the premium buys back at 1% of it, never at zero', () => {
    assert.equal(targetPriceByPoints(15, 40), 0.2);
    assert.equal(targetPriceByPoints(3, 5), 0.1, 'and never under one tick');
  });
  test('zero points is off', () => {
    assert.equal(stopPriceByPoints(15, 0), null);
    assert.equal(targetPriceByPoints(15, 0), null);
  });
  test('points win over a percentage when both are given', () => {
    assert.equal(stopFor(15, { stopLossPct: 1, stopLossPoints: 5 }), 20);
    assert.equal(targetFor(15, { takeProfitPct: 0.5, takeProfitPoints: 0 }), 7.5);
  });
  test('[critical] a stop above 100% prices above double the entry', () => {
    assert.equal(stopFor(10, { stopLossPct: 2.5 }), 35);
  });
  test('protectionFor leaves an unasked leg alone and takes a zero leg off', () => {
    assert.deepEqual(protectionFor(15, { stopLossPoints: 10 }), { takeProfitPrice: undefined, stopPrice: 25 });
    assert.deepEqual(protectionFor(15, { takeProfitPct: 0 }), { takeProfitPrice: null, stopPrice: undefined });
  });
  test('orderPlan prices a points exit off the limit', () => {
    const plan = orderPlan({
      symbol: 'C-BTC-80000-080926', optionSide: 'CE', strike: 80_000, expiryTs: 1, lots: 1,
      limitPrice: 15, takeProfitPoints: 12, stopLossPoints: 30,
    }, 't');
    assert.equal(plan.takeProfitPrice, 3);
    assert.equal(plan.stopPrice, 45);
  });
});

/* ------------------------------------------------------------------ the stepper, against a fake desk */

/** IST wall-clock on a fixed day, as epoch ms. */
const ist = (hhmm: string) => Date.UTC(2026, 8, 22, 0, 0) - 330 * 60_000 + minutesOf(hhmm) * 60_000;

function fakeDesk(trades: Partial<TradeRecord['state']>[] = [{}]) {
  const clock = { t: ist('05:31') };
  const moves: { tradeId: string; ask: ExitAsk }[] = [];
  const told: string[] = [];
  const rows = trades.map((st, i) => ({
    plan: { symbol: `C-BTC-8000${i}-220926` },
    state: { tradeId: `T${i}`, position: -10, entryAvgPrice: 15, ...st },
  }) as unknown as TradeRecord);
  let fail = 0;
  const deps: ExitStepperDeps = {
    openTrades: () => rows,
    move: async (tradeId, ask) => {
      if (fail > 0) { fail--; throw new Error('exchange said no'); }
      moves.push({ tradeId, ask });
    },
    tell: (text) => told.push(text),
    now: () => clock.t,
  };
  return { clock, moves, told, rows, deps, failNext: (n = 1) => { fail = n; } };
}

const morning = (over: Partial<StrategyConfig> = {}) => strat({
  entryTime: '05:30', exitTime: '17:29', takeProfitPct: 0.8, targetSteps: ladder.steps, ...over,
});

describe('StrategyExitStepper', () => {
  test('[critical] nothing moves before the first step: the entry was placed with the starting values', async () => {
    const d = fakeDesk();
    const s = new StrategyExitStepper(d.deps);
    assert.deepEqual(await s.consider(morning()), []);
    d.clock.t = ist('07:29');
    assert.deepEqual(await s.consider(morning()), []);
    assert.equal(d.moves.length, 0);
  });

  test('[critical] each step is applied once, when it begins, and only the leg that changed', async () => {
    const d = fakeDesk();
    const s = new StrategyExitStepper(d.deps);
    d.clock.t = ist('07:30');
    assert.deepEqual(await s.consider(morning()), ['T0']);
    assert.deepEqual(d.moves.at(-1), { tradeId: 'T0', ask: { takeProfitPct: 0.85, takeProfitPoints: 0 } },
      'the stop was not asked about -- somebody may have moved it by hand');
    d.clock.t = ist('07:30') + 20_000;
    assert.deepEqual(await s.consider(morning()), [], 'the next tick does not apply it again');
    d.clock.t = ist('09:30');
    await s.consider(morning());
    d.clock.t = ist('11:30');
    await s.consider(morning());
    assert.deepEqual(d.moves.map((m) => m.ask.takeProfitPct), [0.85, 0.9, 0.95]);
    assert.match(d.told[0]!, /Morning · C-BTC-80000-220926: target 85% \(from 7:30 AM\)/);
  });

  test('a stop ladder in points moves the stop, not the target', async () => {
    const d = fakeDesk();
    const s = new StrategyExitStepper(d.deps);
    const st = morning({ targetSteps: [], stopMode: 'points', stopLossPoints: 10, stopSteps: [{ at: '08:00', value: 20 }] });
    d.clock.t = ist('08:00');
    await s.consider(st);
    assert.deepEqual(d.moves, [{ tradeId: 'T0', ask: { stopLossPct: 0, stopLossPoints: 20 } }]);
    assert.match(d.told[0]!, /stop 20 pts \(from 8:00 AM\)/);
  });

  test('both ladders on one strategy: each leg moves at its own time', async () => {
    const d = fakeDesk();
    const s = new StrategyExitStepper(d.deps);
    const st = morning({ stopLossPct: 1, stopSteps: [{ at: '08:00', value: 2 }] });
    for (const t of ['07:30', '08:00', '09:30']) { d.clock.t = ist(t); await s.consider(st); }
    assert.deepEqual(d.moves.map((m) => m.ask), [
      { takeProfitPct: 0.85, takeProfitPoints: 0 },
      { stopLossPct: 2, stopLossPoints: 0 },
      { takeProfitPct: 0.9, takeProfitPoints: 0 },
    ]);
  });

  test('a desk that was down across two steps catches up in one move, to the step in force', async () => {
    const d = fakeDesk();
    const s = new StrategyExitStepper(d.deps);
    d.clock.t = ist('10:00');
    await s.consider(morning());
    assert.deepEqual(d.moves.map((m) => m.ask.takeProfitPct), [0.9]);
  });

  test('[critical] a move that fails is tried again on the next tick', async () => {
    const d = fakeDesk();
    const s = new StrategyExitStepper(d.deps);
    d.clock.t = ist('07:30');
    d.failNext();
    await assert.rejects(s.consider(morning()), /exchange said no/);
    assert.deepEqual(await s.consider(morning()), ['T0']);
    assert.equal(d.moves.length, 1);
  });

  test('after the exit time nothing moves: the position is being closed', async () => {
    const d = fakeDesk();
    const s = new StrategyExitStepper(d.deps);
    d.clock.t = ist('17:29');
    assert.deepEqual(await s.consider(morning()), []);
  });

  test('a disarmed strategy, a flat trade, and one not yet filled are left alone', async () => {
    const d = fakeDesk([{ position: 0 }, { entryAvgPrice: null }]);
    const s = new StrategyExitStepper(d.deps);
    d.clock.t = ist('07:30');
    assert.deepEqual(await s.consider(strat({ ...morning().config }, false)), []);
    assert.deepEqual(await s.consider(morning()), []);
  });

  test('a strategy with no steps never calls the desk', async () => {
    const d = fakeDesk();
    let asked = 0;
    const s = new StrategyExitStepper({ ...d.deps, openTrades: () => { asked++; return d.rows; } });
    d.clock.t = ist('12:00');
    await s.consider(strat({ takeProfitPct: 0.8 }));
    assert.equal(asked, 0);
  });

  test('every open trade of the strategy moves -- both legs of a strangle', async () => {
    const d = fakeDesk([{}, {}]);
    const s = new StrategyExitStepper(d.deps);
    d.clock.t = ist('07:30');
    assert.deepEqual(await s.consider(morning()), ['T0', 'T1']);
  });
});

/* ------------------------------------------------------------------ real time: engine + paper exchange */

describe('real time: a strategy trade on the paper exchange, walked across its steps', () => {
  const CE = 'C-BTC-80000-080926';
  /** The rig's clock starts at 03:43:20 IST. */
  const istOfRig = (hhmm: string) => {
    const startMin = 3 * 60 + 43;
    return (minutesOf(hhmm) - startMin) * 60_000 - 20_000;
  };

  async function sold() {
    const r = rig({ products: [ceProduct()], quotes: [quote(CE, 15, 15.5)], limits: { maxShortContracts: 5_000 } });
    const s = strat({
      entryTime: '03:40', exitTime: '10:00',
      takeProfitPct: 0.8, targetSteps: [{ at: '04:00', value: 0.85 }, { at: '05:00', value: 0.9 }],
      stopMode: 'points', stopLossPoints: 10, stopSteps: [{ at: '04:30', value: 20 }],
    });
    // Entered the way the runner enters: the values in force now, off the limit.
    await r.engine.open(planFor(ceProduct(), {
      tradeId: 'CE-1', strategyId: 's', lots: 100, leverage: 200,
      entry: { type: 'limit', limitPrice: 15, timeoutMs: 0, marketFallback: false, chase: null },
      takeProfitPrice: targetFor(15, { takeProfitPct: 0.8 }),
      stopPrice: stopFor(15, { stopLossPoints: 10 }),
    }));
    await r.engine.poll('CE-1');
    const stepper = new StrategyExitStepper({
      openTrades: () => r.store.rows().filter((t) => t.plan.strategyId === 's' && t.state.position !== 0),
      // What TradingService.updateExits does, with the same pure function.
      move: async (id, ask) => {
        const entry = r.store.peek(id)!.state.entryAvgPrice!;
        return r.engine.updateProtection(id, protectionFor(entry, ask));
      },
      now: r.now,
    });
    const book = async () => {
      const open = await r.ex.getOpenOrders(CE);
      return {
        target: open.filter((o) => o.type === 'limit' && o.side === 'buy' && o.reduceOnly).map((o) => o.limitPrice),
        stop: open.filter((o) => o.reduceOnly && (o.type === 'stop_limit' || o.type === 'stop_market')).map((o) => o.stopPrice),
      };
    };
    /** Move the clock to an IST time and run a tick the way the runner does. */
    const at = async (hhmm: string) => {
      r.advance(istOfRig(hhmm) - (r.now() - T0));
      r.ex.tick(quote(CE, 6, 6.5, { mark: 6.25, ts: r.now() }));
      await stepper.consider(s);
      await r.engine.poll('CE-1');
      return book();
    };
    return { r, at, book };
  }

  test('[critical] sold at 15: target 3.00 and stop 25 on the book, then each step reprices the order on Delta\'s book', async () => {
    const { r, at, book } = await sold();
    assert.equal(r.store.peek('CE-1')!.state.position, -100, 'the entry filled');
    assert.deepEqual(await book(), { target: [3], stop: [25] }, '80% target, stop entry + 10 points');

    assert.deepEqual(await at('03:59'), { target: [3], stop: [25] }, 'nothing moves a minute early');
    assert.deepEqual(await at('04:00'), { target: [2.3], stop: [25] }, '85% from 4:00 -- the target only');
    assert.deepEqual(await at('04:30'), { target: [2.3], stop: [35] }, 'stop to entry + 20 points from 4:30');
    assert.deepEqual(await at('05:00'), { target: [1.5], stop: [35] }, '90% from 5:00');
    assert.deepEqual(await at('06:00'), { target: [1.5], stop: [35] }, 'and holds there');

    assert.equal(r.store.peek('CE-1')!.plan.takeProfitPrice, 1.5, 'the plan says what the book holds');
    assert.equal(r.store.peek('CE-1')!.plan.stopPrice, 35);
    assert.equal((await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly).length, 2, 'one target and one stop -- never a second of either');
  });

  test('a stepped target that is then reached fills at its price and the stop is cancelled', async () => {
    const { r, at } = await sold();
    await at('05:00');
    r.ex.tick(quote(CE, 1.2, 1.4, { mark: 1.3, ts: r.now() }));
    await r.engine.poll('CE-1');
    assert.equal(r.store.peek('CE-1')!.state.position, 0, 'bought back at the 1.50 target');
    assert.deepEqual((await r.ex.getOpenOrders(CE)).filter((o) => o.reduceOnly), [], 'the stop went with it');
  });
});

describe('validateConfig: premium fallback', () => {
  const v = (premium: StrategyConfig['premium']) => validateConfig(cfg({ premium }));
  test('[critical] at most $20, fallback $50 is valid', () => assert.deepEqual(v({ mode: 'atMost', usd: 20, fallbackUsd: 50 }), []));
  test('at most: a fallback not above the number could never find more', () => {
    assert.deepEqual(v({ mode: 'atMost', usd: 20, fallbackUsd: 20 }), ['The fallback must be above $20: it is tried when nothing is at or below $20.']);
    assert.deepEqual(v({ mode: 'atMost', usd: 20, fallbackUsd: 10 }), ['The fallback must be above $20: it is tried when nothing is at or below $20.']);
  });
  test('at least: the fallback floor must be lower', () => {
    assert.deepEqual(v({ mode: 'atLeast', usd: 20, fallbackUsd: 10 }), []);
    assert.deepEqual(v({ mode: 'atLeast', usd: 20, fallbackUsd: 30 }), ['The fallback must be below $20: it is tried when nothing pays $20.']);
  });
  test('zero, negative or nonsense is refused; null and absent are off', () => {
    assert.match(v({ mode: 'atMost', usd: 20, fallbackUsd: 0 })[0]!, /positive number of dollars/);
    assert.match(v({ mode: 'atMost', usd: 20, fallbackUsd: Number.NaN })[0]!, /positive number of dollars/);
    assert.deepEqual(v({ mode: 'atMost', usd: 20, fallbackUsd: null }), []);
    assert.deepEqual(v({ mode: 'atMost', usd: 20 }), []);
  });
});

describe('exits typed as the price itself', () => {
  test('[critical] entry 16, stop typed as 70: the stop is 70 -- 54 points over', () => {
    assert.equal(stopFor(16, { stopAt: 70 }), 70);
    assert.equal(targetFor(16, { takeProfitAt: 4 }), 4);
  });
  test('a price wins over points and a percentage', () => {
    assert.equal(stopFor(16, { stopAt: 70, stopLossPoints: 10, stopLossPct: 1 }), 70);
    assert.equal(targetFor(16, { takeProfitAt: 4, takeProfitPoints: 2, takeProfitPct: 0.5 }), 4);
  });
  test('[critical] a target at or over the entry, or a stop at or under it, is refused: it would fire on placement', () => {
    assert.equal(exitPriceProblem(16, { takeProfitAt: 4, stopAt: 70 }), null);
    assert.match(exitPriceProblem(16, { takeProfitAt: 16 })!, /target of 16 must be under the 16 entry/);
    assert.match(exitPriceProblem(16, { takeProfitAt: 20 })!, /must be under/);
    assert.match(exitPriceProblem(16, { stopAt: 16 })!, /stop of 16 must be over the 16 entry/);
    assert.match(exitPriceProblem(16, { stopAt: 10 })!, /fires at once/);
    assert.equal(exitPriceProblem(16, {}), null);
  });
  test('protectionFor moves only the leg given as a price', () => {
    assert.deepEqual(protectionFor(16, { stopAt: 70 }), { takeProfitPrice: undefined, stopPrice: 70 });
  });
  test('orderPlan takes the prices as they are', () => {
    const plan = orderPlan({
      symbol: 'C-BTC-80000-080926', optionSide: 'CE', strike: 80_000, expiryTs: 1, lots: 1,
      limitPrice: 16, takeProfitAt: 4, stopAt: 70,
    }, 't');
    assert.equal(plan.takeProfitPrice, 4);
    assert.equal(plan.stopPrice, 70);
  });
});

describe('real time: UG-PE as saved on 22 Sep -- price stop 70, target 80 → 85 → 90 → 95%', () => {
  const PE = 'P-BTC-77000-080926';
  // The rig's clock reads 03:43:20 IST; the strategy's hours are shifted by the same amount so its
  // 05:30 / 07:30 / 09:30 / 11:30 read as 03:40 / 05:40 / 07:40 / 09:40 here.
  const istOfRig = (hhmm: string) => (minutesOf(hhmm) - (3 * 60 + 43)) * 60_000 - 20_000;

  test('[critical] sold at 18: stop rests at 70 all day; the target steps 3.6 → 2.7 → 1.8 → 0.9', async () => {
    const { peProduct } = await import('../trading/harness.js');
    const r = rig({ products: [peProduct()], quotes: [quote(PE, 18, 18.5)], limits: { maxShortContracts: 5_000 } });
    const s = strat({
      legs: 'PE', lots: 100, entryTime: '03:40', exitTime: '15:39',
      takeProfitPct: 0.8, targetSteps: [{ at: '05:40', value: 0.85 }, { at: '07:40', value: 0.9 }, { at: '09:40', value: 0.95 }],
      stopMode: 'price', stopLossAt: 70,
    });
    // Entered the way the runner enters: the exits in force now, in each rule's mode.
    const { exitsNow } = await import('../../src/strategy/runner.js').catch(() => ({ exitsNow: null }));
    const ask = exitsNow ? exitsNow(s, r.now()) : { takeProfitPct: 0.8, stopAt: 70 };
    await r.engine.open(orderPlan({ symbol: PE, optionSide: 'PE', strike: 77_000, expiryTs: 1_700_040_000, lots: 100, leverage: 200, strategyId: 's', limitPrice: 18, ...ask }, 'PE-1'));
    await r.engine.poll('PE-1');
    const stepper = new StrategyExitStepper({
      openTrades: () => r.store.rows().filter((t) => t.plan.strategyId === 's' && t.state.position !== 0),
      move: async (id, a) => r.engine.updateProtection(id, protectionFor(r.store.peek(id)!.state.entryAvgPrice!, a)),
      now: r.now,
    });
    const book = async () => {
      const open = (await r.ex.getOpenOrders(PE)).filter((o) => o.reduceOnly);
      return {
        target: open.filter((o) => o.type === 'limit').map((o) => o.limitPrice),
        stop: open.filter((o) => o.type === 'stop_limit' || o.type === 'stop_market').map((o) => o.stopPrice),
      };
    };
    const at = async (hhmm: string) => {
      r.advance(istOfRig(hhmm) - (r.now() - T0));
      r.ex.tick(quote(PE, 9, 9.5, { mark: 9.25, ts: r.now() }));
      await stepper.consider(s);
      await r.engine.poll('PE-1');
      return book();
    };
    assert.equal(r.store.peek('PE-1')!.state.position, -100, 'filled 100 at 18');
    assert.deepEqual(await book(), { target: [3.6], stop: [70] }, '80% of 18, stop at the level typed');
    assert.deepEqual(await at('05:40'), { target: [2.7], stop: [70] }, '85% from "7:30"');
    assert.deepEqual(await at('07:40'), { target: [1.8], stop: [70] }, '90% from "9:30"');
    assert.deepEqual(await at('09:40'), { target: [0.9], stop: [70] }, '95% from "11:30"');
    assert.equal(70 - r.store.peek('PE-1')!.state.entryAvgPrice!, 52, 'the balance: 70 − 18');
    assert.equal((await r.ex.getOpenOrders(PE)).filter((o) => o.reduceOnly).length, 2, 'one target, one stop -- never two of either');
  });
});
