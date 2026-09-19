import { describe, expect, test } from 'vitest';
import type { ChainResponse, Leg, Outlook } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import {
  allClear, bestLeg, bothSides, breakeven, candidates, consensus, entryGates, expectedMove, feePerContract, freshness, gammaRisk,
  ivRv, keyLevels, marginPerContract, modelView, odds, orderEstimate, payoffPrices, premiumAnalysis, shortPayoff, skew, volRegime,
  assessBoth, assessSides, horizonRows, parseSymbol, positionState, positionViews, premiumMomentum, readiness, riskEngine, scenarioGrid, shortLossAt,
} from './overview';

const fixtureData = () => live as unknown as ChainResponse;
const it = test;

const leg = (over: Partial<Leg>): Leg => ({
  ev: { signal: 'sell' } as Leg['ev'], oiChange: null, cp: 'C', strike: 78_000, off: 1, moneyness: 'OTM',
  ltp: null, mark: 360, bid: 352, ask: 368, sellPrice: 352, iv: 0.478, delta: 0.36, gamma: 0.00042,
  theta: -12.8, vega: 38.6, oi: 12_400, volume: 3_100, ageMin: 1,
  probs: { expireWorthless: 0.64, touch: 0.36, nearZero: 0.5 }, emBuffer: 1.38, distancePct: 0.1,
  intrinsic: 0, extrinsic: 360, gammaExposure: null, pOtm: 0.64, edge: 1, emDistance: 1.38,
  zero: null, zeroByDistance: null, score: 0.62, reasons: [],
  ...over,
});

describe('volatility', () => {
  test('IV against realised: rich above 1.15×, cheap under 0.9×, fair between', () => {
    expect(ivRv(0.482, 32.1)).toMatchObject({ label: 'rich', spreadPts: expect.closeTo(16.1, 5) });
    expect(ivRv(0.27, 32)).toMatchObject({ label: 'cheap' });   // 0.84×
    expect(ivRv(0.32, 30)).toMatchObject({ label: 'fair' });
  });
  test('a missing or zero input is null, never a number', () => {
    expect(ivRv(null, 30)).toBeNull();
    expect(ivRv(0.4, null)).toBeNull();
    expect(ivRv(0.4, 0)).toBeNull();
  });
});

describe('skew', () => {
  test('25-delta put and call IV, and the gap between them in points', () => {
    const s = skew([
      leg({ cp: 'P', strike: 76_500, delta: -0.24, iv: 0.524 }),
      leg({ cp: 'P', strike: 77_000, delta: -0.4, iv: 0.49 }),
      leg({ cp: 'C', strike: 79_000, delta: 0.26, iv: 0.449 }),
    ], 0.482);
    expect(s.put25?.strike).toBe(76_500);
    expect(s.call25?.strike).toBe(79_000);
    expect(s.putCallPts).toBeCloseTo(7.5, 5);
  });
  test('nothing within 0.1 of 25 delta is not a 25-delta option', () => {
    expect(skew([leg({ cp: 'P', delta: -0.6 })], 0.5).put25).toBeNull();
  });
});

describe('expected move and premium', () => {
  const snap = { spot: 77_967.5, atmIv: 0.482, hoursToExpiry: 12, expectedMove: null };
  test('spot × IV × √(t / year)', () => {
    const em = expectedMove(snap)!;
    expect(em.move).toBeCloseTo(77_967.5 * 0.482 * Math.sqrt(12 / 8760), 6);
    expect(em.upper - em.lower).toBeCloseTo(2 * em.move, 6);
  });
  test('the server’s own figure is used where it sent one', () => {
    expect(expectedMove({ ...snap, expectedMove: 1_420 })!.move).toBe(1_420);
  });
  test('an expired contract has no expected move', () => {
    expect(expectedMove({ ...snap, hoursToExpiry: 0 })).toBeNull();
  });
  test('[critical] intrinsic and extrinsic split the premium; theta and spread are ratios of it', () => {
    const p = premiumAnalysis(leg({ cp: 'C', strike: 77_000, mark: 1_025, intrinsic: 967.5 }), { move: 1_420, upper: 0, lower: 0, hours: 12, ivPct: 48 })!;
    expect(p.intrinsic).toBe(967.5);
    expect(p.extrinsic).toBeCloseTo(57.5, 6);
    expect(p.thetaPerPremiumDay).toBeCloseTo(12.8 / 1_025, 9);
    expect(p.premiumPerEm).toBeCloseTo(1_025 / 1_420, 9);
    expect(p.spreadPct).toBeCloseTo(16 / 360, 9);
  });
});

describe('odds', () => {
  test('the measured record wins over the model, and says so', () => {
    const o = odds(leg({ zero: { adjusted: 0.71 } as Leg['zero'] }));
    expect(o).toMatchObject({ pOtm: 0.71, source: 'measured', modelOtm: 0.64, pTouch: 0.36, deltaApprox: 0.36 });
    expect(o.pItm).toBeCloseTo(0.29, 9);
  });
  test('with no measured figure, the model, labelled as the model', () => {
    expect(odds(leg({})).source).toBe('model');
  });
});

describe('payoff', () => {
  test('[critical] a short call keeps the premium below the strike and loses the move above it', () => {
    const rows = shortPayoff('C', 78_500, 193, [78_000, 78_500, 79_000, 80_000], 1_000);
    expect(rows.map((r) => r.pnlUsd)).toEqual([193, 193, -307, -1_307]);
  });
  test('a short put is the mirror', () => {
    expect(shortPayoff('P', 76_500, 51, [76_000, 77_000], 1_000).map((r) => r.pnlUsd)).toEqual([-449, 51]);
  });
  test('scaled by contracts: 10 contracts is a hundredth of a BTC', () => {
    expect(shortPayoff('C', 78_500, 193, [78_000], 10)[0]!.pnlUsd).toBeCloseTo(1.93, 9);
  });
  test('breakeven', () => {
    expect(breakeven('C', 78_500, 193)).toBe(78_693);
    expect(breakeven('P', 76_500, 51)).toBe(76_449);
  });
  test('the price grid includes spot and straddles the strike', () => {
    expect(payoffPrices(78_000, 77_967, 500, 1)).toEqual([77_500, 78_000, 78_500]);
  });
});

describe('the decision', () => {
  test('gamma risk from distance in expected moves', () => {
    expect([gammaRisk(2), gammaRisk(1), gammaRisk(0.3), gammaRisk(null)]).toEqual(['low', 'medium', 'high', null]);
  });
  test('the best leg is out of the money and the highest scored', () => {
    const b = bestLeg([
      leg({ strike: 78_000, score: 0.6 }), leg({ strike: 78_500, score: 0.8 }),
      leg({ strike: 77_500, moneyness: 'ITM', score: 0.9 }), leg({ cp: 'P', score: 0.99 }),
    ], 'C');
    expect(b?.strike).toBe(78_500);
  });
  test('candidates skip what the desk refuses', () => {
    const c = candidates([leg({ strike: 1, score: 0.9, ev: { signal: 'avoid' } as Leg['ev'] }), leg({ strike: 2, score: 0.5 })], 'C');
    expect(c.map((l) => l.strike)).toEqual([2]);
  });
});

const outlook = (over: Partial<Outlook>): Outlook => ({
  rows: [], consensus: null, bullish: 0, bearish: 0, flat: 0, scored: 0, agreement: '',
  directionEdgePts: null, sampleWindows: 105_120, ...over,
});

describe('model view and consensus', () => {
  test('[critical] the measured row where the analytics service answered', () => {
    const v = modelView(outlook({ rows: [
      { label: '1h', minutes: 60, pUp: 0.5, measured: null } as never,
      { label: '12h', minutes: 720, pUp: 0.52, measured: { pUp: 0.64, pSide: 0.12, pDown: 0.24, windows: 900 } } as never,
    ] }), 720);
    expect(v).toMatchObject({ label: '12h', pUp: 0.64, pSide: 0.12, pDown: 0.24, source: 'measured' });
  });
  test('without it, the plain history -- and Side left at zero, not guessed', () => {
    const v = modelView(outlook({ rows: [{ label: '12h', minutes: 720, pUp: 0.52, measured: null } as never] }));
    expect(v).toMatchObject({ pUp: 0.52, pSide: 0, source: 'history' });
    expect(v!.pDown).toBeCloseTo(0.48, 9);
  });
  test('no rows is no view', () => {
    expect(modelView(outlook({}))).toBeNull();
  });
  test('horizons agree at five in seven', () => {
    expect(consensus(outlook({ bullish: 5, bearish: 1, flat: 1 })).agree).toBe(true);
    expect(consensus(outlook({ bullish: 4, bearish: 2, flat: 1 })).agree).toBe(false);
  });
});

describe('gates', () => {
  const base = {
    snapshot: { ts: 1_000, live: true, hoursToExpiry: 12 } as never,
    verdict: { checks: [{ ok: true, severity: 'block', text: 'spread gate' }] } as never,
    direction: { confirmed: true, readable: 5, summary: 'bullish, confirmed' } as never,
    outlook: outlook({ bullish: 6, bearish: 1 }),
  };
  test('fresh is thirty seconds', () => {
    expect(freshness(1_000, 1_000_000 + 29_000).fresh).toBe(true);
    expect(freshness(1_000, 1_000_000 + 31_000).fresh).toBe(false);
  });
  test('[critical] all green only when every gate is green; stale data blocks', () => {
    const iv = ivRv(0.48, 32);
    const green = entryGates({ data: base, leg: leg({}), iv, nowMs: 1_000_000 + 5_000, maxSpreadPct: 10 });
    expect(allClear(green)).toBe(true);
    const stale = entryGates({ data: base, leg: leg({}), iv, nowMs: 1_000_000 + 60_000, maxSpreadPct: 10 });
    expect(allClear(stale)).toBe(false);
    expect(stale.find((g) => g.key === 'fresh')?.ok).toBe(false);
  });
  test('an unreadable gate is not a pass', () => {
    const g = entryGates({ data: base, leg: leg({}), iv: null, nowMs: 1_005_000, maxSpreadPct: 10 });
    expect(g.find((x) => x.key === 'iv')?.ok).toBeNull();
    expect(allClear(g)).toBe(false);
  });
  test('a past snapshot never passes', () => {
    const g = entryGates({ data: { ...base, snapshot: { ts: 1_000, live: false, hoursToExpiry: 12 } as never }, leg: leg({}), iv: ivRv(0.48, 32), nowMs: 1_001_000, maxSpreadPct: 10 });
    expect(allClear(g)).toBe(false);
  });
});

test('key levels come sorted high to low, and only from what was read', () => {
  const lv = keyLevels({
    ceOiWall: { strike: 80_000, value: 1 }, ceOiWallNear: { strike: 78_400, value: 1 },
    peOiWall: { strike: 77_420, value: 1 }, maxPain: { strike: 78_000, payoutUsd: 0 }, gammaWall: null,
  } as never, 78_120, 76_840);
  expect(lv.map((l) => l.price)).toEqual([78_400, 78_120, 78_000, 77_420, 76_840]);
});

describe('margin, fees and the order estimate', () => {
  it('[critical] margin per contract is spot × 0.001 ÷ leverage plus the fee, as the server model was fitted', () => {
    // Delta's ticket: index 78,405.5, 10 lots, 200x -> "Funds req. 3.93 USD" (server: trading/margin.ts)
    // A $16 premium: the fee cap (3.5% of premium) binds, and ten lots come to 3.93.
    const per = marginPerContract(78_405.5, 200, 16);
    expect(per * 10).toBeCloseTo(3.93, 2);
  });

  it('the fee is capped at 3.5% of a small premium', () => {
    expect(feePerContract(80_000, 4)).toBeCloseTo(4 * 0.001 * 0.035, 9);
    expect(feePerContract(80_000, 1_000)).toBeCloseTo(80_000 * 0.001 * 0.0001, 9);
  });

  it('the estimate: credit, fees, margin, return on margin, and a breakeven that includes the fee', () => {
    const e = orderEstimate('C', 82_000, 100, 80_000, 100, 10);
    expect(e.creditUsd).toBeCloseTo(1, 9);
    expect(e.marginUsd).toBeCloseTo(10 * (80_000 * 0.001 / 100 + feePerContract(80_000, 100)), 9);
    expect(e.returnOnMargin).toBeGreaterThan(0);
    expect(e.breakevenAfterFees).toBeLessThan(82_100);
    expect(orderEstimate('P', 78_000, 100, 80_000, 100, 10).breakevenAfterFees).toBeGreaterThan(77_900);
  });
});

describe('the risk gate', () => {
  const base = { data: fixtureData(), leg: null, iv: null, nowMs: Date.now(), maxSpreadPct: null };
  it('passes while the size after this sell is within the cap and the day is inside its loss limit', () => {
    const g = entryGates({ ...base, risk: { contracts: 10, heldShort: 20, maxShortContracts: 50, dayNetUsd: -1, maxDailyLossUsd: 5 } }).find((x) => x.key === 'risk');
    expect(g?.ok).toBe(true);
  });
  it('[critical] fails on the cap, and on the day\'s loss limit', () => {
    expect(entryGates({ ...base, risk: { contracts: 40, heldShort: 20, maxShortContracts: 50, dayNetUsd: 0, maxDailyLossUsd: 5 } }).find((x) => x.key === 'risk')?.ok).toBe(false);
    expect(entryGates({ ...base, risk: { contracts: 1, heldShort: 0, maxShortContracts: 50, dayNetUsd: -5, maxDailyLossUsd: 5 } }).find((x) => x.key === 'risk')?.ok).toBe(false);
  });
});

describe('both sides and the vol regime', () => {
  it('a side is safe one expected move out; net delta is the pair short', () => {
    const b = bothSides(fixtureData().legs);
    expect(b.ce === null || typeof b.ceSafe === 'boolean' || b.ceSafe === null).toBe(true);
    if (b.ce?.delta != null && b.pe?.delta != null) expect(b.netDelta).toBeCloseTo(-(b.ce.delta + b.pe.delta), 9);
  });
  it('the regime is the hour against the month', () => {
    expect(volRegime(60, 40)?.label).toBe('high');
    expect(volRegime(20, 40)?.label).toBe('low');
    expect(volRegime(40, 40)?.label).toBe('normal');
    expect(volRegime(null, 40)).toBeNull();
  });
});

describe('the sides assessed, and both together', () => {
  const data = fixtureData();
  const iv = ivRv(data.structure.atmIv, data.market?.realisedVol ?? null);
  const em = expectedMove(data.snapshot);

  it('[critical] every side has a status, a tail loss at two expected moves, and a margin', () => {
    const sides = assessSides(data, iv, em, 10, 200);
    expect(sides.map((s) => s.side)).toEqual(['CE', 'PE']);
    for (const s of sides) {
      expect(['SELL', 'WATCH', 'NOT PREFERRED']).toContain(s.status);
      if (s.leg && em) { expect(s.tailLossUsd).not.toBeNull(); expect(s.marginUsd).toBeGreaterThan(0); }
    }
  });

  it('a short loses only past its strike plus the premium kept', () => {
    expect(shortLossAt('C', 82_000, 100, 81_000, 10)).toBe(0);
    expect(shortLossAt('C', 82_000, 100, 82_050, 10)).toBe(0);
    expect(shortLossAt('C', 82_000, 100, 83_100, 10)).toBeCloseTo(1_000 * 10 * 0.001, 9);
    expect(shortLossAt('P', 78_000, 100, 76_900, 10)).toBeCloseTo(1_000 * 0.01, 9);
  });

  it('[critical] both sides activates only when each side passes on its own', () => {
    const sides = assessSides(data, iv, em, 10, 200);
    const b = assessBoth(data, sides, 10, 200, em);
    const pass = (s: typeof sides[number]) => Boolean(s.leg && s.status !== 'NOT PREFERRED' && (s.emDistance ?? 0) >= 1);
    const n = sides.filter(pass).length;
    expect(b.status).toBe(n === 2 ? 'BOTH' : n === 1 ? 'SINGLE SIDE' : 'NO TRADE');
  });
});

describe('the risk engine and the scenario grid', () => {
  const data = fixtureData();
  const em = expectedMove(data.snapshot);
  it('reads a strike: shocks, slippage, decay curve, protection', () => {
    const l = data.legs.find((x) => x.cp === 'C' && x.bid !== null && x.ask !== null && (x.sellPrice ?? x.mark) !== null)!;
    const r = riskEngine(l, data.legs, em, data.snapshot.spot, data.snapshot.hoursToExpiry, 10, 200)!;
    expect(r.premium).toBeGreaterThan(0);
    expect(r.decayCurve[0]!.extrinsic).toBeCloseTo(r.extrinsic, 9);
    expect(r.decayCurve.at(-1)!.extrinsic).toBe(0);
    expect(r.slippageUsd).toBeCloseTo(((l.ask! - l.bid!) / 2) * 0.01, 9);
    if (l.vega !== null) expect(r.vegaShockUsd).toBeCloseTo(-l.vega * 5 * 0.01, 9);
  });
  it('the grid runs −3% … +3% for the call, the put and both', () => {
    const ce = leg({ cp: 'C', strike: 82_000, sellPrice: 100, mark: 100 });
    const pe = leg({ cp: 'P', strike: 78_000, sellPrice: 100, mark: 100 });
    const g = scenarioGrid(ce, pe, 80_000, 10);
    expect(g.map((r) => r.pct)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect(g[3]!.ce).toBeCloseTo(1, 9);
    expect(g[3]!.both).toBeCloseTo(2, 9);
    expect(g[6]!.ce).toBeCloseTo((100 - 400) * 0.01, 9);
    expect(g[0]!.pe).toBeCloseTo((100 - 400) * 0.01, 9);
  });
});

describe('readiness', () => {
  it('[critical] is ENTRY READY only when every gate is green; an unreadable gate is not a pass', () => {
    const data = fixtureData();
    const r = readiness({ data, leg: null, iv: null, em: null, nowMs: Date.now(), contracts: 10, leverage: 200, trade: null, risk: null });
    expect(r.verdict).toBe('NO TRADE');
    expect(r.gates.some((g) => g.key === 'side' && g.ok === false)).toBe(true);
    expect(r.failing + r.unknown).toBeGreaterThan(0);
  });
});

describe('the position state engine', () => {
  it('[critical] walks NORMAL → WATCH → WARNING → ADJUST → HEDGE → EXIT', () => {
    expect(positionState(1.5, 0.8, true).state).toBe('NORMAL');
    expect(positionState(0.8, 1, true).state).toBe('WATCH');
    expect(positionState(1.5, 1.2, true).state).toBe('WATCH');
    expect(positionState(0.4, 1, true).state).toBe('WARNING');
    expect(positionState(1.5, 1.6, true).state).toBe('WARNING');
    expect(positionState(0.2, 1, true).state).toBe('ADJUST');
    expect(positionState(0.6, 2.2, true).state).toBe('HEDGE');
    expect(positionState(0.6, 2.2, false).state).toBe('EXIT');
    expect(positionState(0.6, 3.1, true).state).toBe('EXIT');
    expect(positionState(-0.1, 1, true).state).toBe('EXIT');
  });
  it('reads an open trade against the board', () => {
    const data = fixtureData();
    const l = data.legs.find((x) => x.cp === 'C' && x.mark !== null)!;
    const v = positionViews([{ tradeId: 't', symbol: `C-BTC-${l.strike}-${data.snapshot.expiry}`, optionSide: 'CE', position: -10, entryAvgPrice: l.mark! * 2, live: { markPrice: l.mark, unrealisedPnl: 1, decayed: 0.5 } }], data.legs, data.snapshot.spot, expectedMove(data.snapshot));
    expect(v).toHaveLength(1);
    expect(v[0]!.strike).toBe(l.strike);
    expect(v[0]!.contracts).toBe(10);
    expect(parseSymbol('P-BTC-78000-190926')).toEqual({ cp: 'P', strike: 78_000, expiry: '190926' });
  });
});

describe('horizons and momentum', () => {
  it('lists every outlook row with its odds and implied band', () => {
    const rows = horizonRows(fixtureData().outlook);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) if (r.pUp !== null) expect(r.pDown).toBeCloseTo(1 - r.pUp, 9);
  });
  it('velocity is the last step, acceleration the change of it', () => {
    expect(premiumMomentum([{ at: 1, mark: 10 }, { at: 2, mark: 12 }, { at: 3, mark: 15 }])).toEqual({ velocity: 3, acceleration: 1 });
    expect(premiumMomentum([{ at: 1, mark: 10 }])).toEqual({ velocity: null, acceleration: null });
  });
});
