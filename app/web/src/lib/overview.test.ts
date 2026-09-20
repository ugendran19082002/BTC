import { describe, expect, test } from 'vitest';
import type { ChainResponse, Leg, Outlook } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import {
  bestLeg, bothSides, breakeven, candidates, consensus, expectedMove, feePerContract, freshness, gammaRisk,
  ivRv, keyLevels, marginPerContract, modelView, odds, orderEstimate, payoffPrices, premiumAnalysis, shortPayoff, skew, volRegime,
  ageText, contractValidity, dataFreshness, optionBias, sellerImpact, sellerState, windowMinutes, premiumDecay, triggerState, DESK_FILTER, filtersChanged, assessBoth, assessSides, horizonRows, namedLevels, earlyWarning, findStrikes, boardRead, movementVerdict, parseSymbol, positionState, positionViews, premiumMomentum, riskEngine, shortLossAt,
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

describe('freshness', () => {
  test('fresh is thirty seconds', () => {
    expect(freshness(1_000, 1_000_000 + 29_000).fresh).toBe(true);
    expect(freshness(1_000, 1_000_000 + 31_000).fresh).toBe(false);
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

describe('the risk engine', () => {
  const data = fixtureData();
  const em = expectedMove(data.snapshot);
  it('reads a strike: shocks, slippage, protection', () => {
    const l = data.legs.find((x) => x.cp === 'C' && x.bid !== null && x.ask !== null && (x.sellPrice ?? x.mark) !== null)!;
    const r = riskEngine(l, data.legs, em, data.snapshot.spot, data.snapshot.hoursToExpiry, 10, 200)!;
    expect(r.premium).toBeGreaterThan(0);
    expect(r.slippageUsd).toBeCloseTo(((l.ask! - l.bid!) / 2) * 0.01, 9);
    if (l.vega !== null) expect(r.vegaShockUsd).toBeCloseTo(-l.vega * 5 * 0.01, 9);
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
    // Above, inside and below the implied band: a partition, so a reader can add them to 100%.
    for (const r of rows) if (r.measured) expect(r.pUp! + r.pRange! + r.pDown!).toBeCloseTo(1, 6);
  });
  it('velocity is the last step, acceleration the change of it', () => {
    expect(premiumMomentum([{ at: 1, mark: 10 }, { at: 2, mark: 12 }, { at: 3, mark: 15 }])).toEqual({ velocity: 3, acceleration: 1 });
    expect(premiumMomentum([{ at: 1, mark: 10 }])).toEqual({ velocity: null, acceleration: null });
  });
});

describe('named levels', () => {
  it('R1 / R2 are the two nearest above spot, S1 / S2 the two nearest below, and the previous day stays named', () => {
    const levels = [
      { label: 'Call OI wall', price: 82_000, kind: 'resistance' as const }, { label: 'Gamma wall', price: 81_000, kind: 'pivot' as const },
      { label: 'Max pain', price: 80_500, kind: 'pivot' as const }, { label: 'Put OI wall', price: 79_000, kind: 'support' as const },
      { label: '24h high', price: 83_000, kind: 'range' as const }, { label: 'Prev day low', price: 78_000, kind: 'range' as const },
    ];
    const n = namedLevels(levels, 80_600);
    expect(n.map((l) => [l.name, l.price])).toEqual([['Resistance 1', 81_000], ['Resistance 2', 82_000], ['Support 1', 80_500], ['Support 2', 79_000], ['Prev day low', 78_000]]);
    expect(n[0]!.source).toBe('Gamma wall');
    const dup = namedLevels([{ label: 'Max pain', price: 81_200, kind: 'pivot' }, { label: 'Gamma wall', price: 81_200, kind: 'pivot' }, { label: 'Put OI wall', price: 81_000, kind: 'support' }], 81_300);
    expect(dup.map((l) => [l.name, l.price])).toEqual([['Support 1', 81_200], ['Support 2', 81_000]]);
    expect(dup[0]!.source).toBe('Max pain + Gamma wall');
  });
});

describe('early warning', () => {
  const quiet = { flow: { aggressorBuyPct: 0.5, cvd: [], minutesCovered: 60 }, book: { imbalance: 0 }, oi: { ceChange1h: 100, peChange1h: 100, ceAcceleration: 0, peAcceleration: 0 }, funding: 0.01, market: fixtureData().market, outlook: fixtureData().outlook, markChange15mPct: 0, atmIvChange15mPts: 0 };
  it('[critical] a calm tape fires nothing; one-sided flow with a jumping wing and IV reads as a move starting', () => {
    const calm = earlyWarning(quiet);
    expect(calm.triggers.filter((t) => t.fired === true).length).toBeLessThanOrEqual(1);
    const hot = earlyWarning({ ...quiet, flow: { aggressorBuyPct: 0.8, cvd: Array.from({ length: 16 }, (_, i) => ({ at: i, cvd: i * 40 })), minutesCovered: 60, totalVolume: 3000 }, book: { imbalance: 0.4 }, markChange15mPct: 60, atmIvChange15mPts: 3, funding: 0.08 });
    expect(hot.triggers.filter((t) => t.fired === true).length).toBeGreaterThanOrEqual(5);
    expect(['high', 'sudden']).toContain(hot.band);
    expect(hot.lean).toBe(1);
    for (const t of hot.triggers) { expect(t.formula.length).toBeGreaterThan(10); expect(t.threshold.length).toBeGreaterThan(0); }
  });
});

describe('the movement read and the finder', () => {
  const data = fixtureData();
  it('reads the board with a formula behind each line, and gives one verdict', () => {
    const b = boardRead(data, expectedMove(data.snapshot));
    expect(b.length).toBeGreaterThan(0);
    for (const r of b) expect(['up', 'down', 'range', 'unclear']).toContain(r.says);
    const v = movementVerdict(horizonRows(data.outlook), b, data.market, data.snapshot.hoursToExpiry);
    expect(['up', 'down', 'range']).toContain(v.way);
    expect(['low', 'medium', 'high']).toContain(v.confidence);
  });
  it('[critical] the finder keeps only OTM strikes that pass every filter, best score first', () => {
    const f = findStrikes(data.legs, { side: 'P', minPremium: 1, maxPot: 0.5, minEm: 0.5, top: 5 });
    expect(f.length).toBeLessThanOrEqual(5);
    for (const l of f) { expect(l.cp).toBe('P'); expect(l.moneyness).not.toBe('ITM'); expect((l.sellPrice ?? l.mark ?? 0)).toBeGreaterThanOrEqual(1); }
    for (let i = 1; i < f.length; i++) expect((f[i - 1]!.score ?? -1)).toBeGreaterThanOrEqual(f[i]!.score ?? -1);
    expect(findStrikes(data.legs, { side: 'both', minPremium: 1e9, maxPot: 1, minEm: 0, top: 5 })).toEqual([]);
  });
});

describe('the finder drives the cards', () => {
  it('[critical] with a pick, each card carries the strike the pick names; without one, the desk’s own', () => {
    const data = fixtureData();
    const own = assessSides(data, null, expectedMove(data.snapshot), 10, 200);
    const far = (cp: 'C' | 'P') => findStrikes(data.legs, { ...DESK_FILTER, side: cp, minEm: 2, top: 1 })[0] ?? null;
    const picked = assessSides(data, null, expectedMove(data.snapshot), 10, 200, far);
    for (const [i, side] of (['C', 'P'] as const).entries()) {
      expect(picked[i]!.leg?.strike).toBe(far(side)?.strike);
      if (far(side) && own[i]!.leg) expect(Math.abs(picked[i]!.leg!.strike - data.snapshot.spot)).toBeGreaterThanOrEqual(Math.abs(own[i]!.leg!.strike - data.snapshot.spot));
    }
    expect(filtersChanged(DESK_FILTER)).toBe(false);
    expect(filtersChanged({ ...DESK_FILTER, minEm: 2 })).toBe(true);
  });
});

describe('the contract and the data', () => {
  const now = Date.UTC(2026, 8, 20, 6, 0, 0);
  it('[critical] LIVE past an hour out, EXPIRING inside it, EXPIRED at settlement or on a past snapshot', () => {
    const snap = (h: number, live = true) => ({ live, expiryTs: (now + h * 3_600_000) / 1000 });
    expect(contractValidity(snap(5), now).state).toBe('LIVE');
    expect(contractValidity(snap(0.5), now).state).toBe('EXPIRING');
    expect(contractValidity(snap(0), now).state).toBe('EXPIRED');
    expect(contractValidity(snap(5, false), now)).toMatchObject({ state: 'EXPIRED', text: 'past snapshot' });
  });
  it('ages are said as people say them, and each has its own limit', () => {
    expect(ageText(4_000)).toBe('4s'); expect(ageText(190_000)).toBe('3m'); expect(ageText(7_200_000)).toBe('2h'); expect(ageText(2 * 86_400_000 + 5)).toBe('2d'); expect(ageText(null)).toBe('—');
    const ages = dataFreshness({ marketAt: now - 2_000, chainAt: now - 45_000, oiAt: now - 4 * 60_000, modelAt: null }, now);
    expect(ages.map((a) => [a.key, a.text, a.stale])).toEqual([['market', '2s', false], ['chain', '45s', true], ['oi', '4m', false], ['model', '—', true]]);
    expect(dataFreshness(null, now).every((a) => a.stale)).toBe(true);
  });
});

describe('premium decay', () => {
  it('[critical] runs from the premium now to the intrinsic at expiry on √time; half the extrinsic goes by 0.75 T, four-fifths by 0.96 T', () => {
    const { points, milestones } = premiumDecay(51, 3, 12, 4);
    expect(points.map((p) => p.label)).toEqual(['Now', '3h', '6h', '9h', 'Exp']);
    expect(points[0]!.premium).toBe(51);
    expect(points.at(-1)!.premium).toBeCloseTo(3, 9);
    expect(points[2]!.premium).toBeCloseTo(3 + 48 * Math.SQRT1_2, 9);
    expect(milestones.map((m) => m.share)).toEqual([0.5, 0.8, 0.95]);
    expect(milestones[0]!.hoursFromNow).toBeCloseTo(9, 9); expect(milestones[1]!.hoursFromNow).toBeCloseTo(12 * 0.96, 9); expect(milestones[2]!.hoursFromNow).toBeCloseTo(12 * 0.9975, 9);
    for (let i = 1; i < points.length; i++) expect(points[i]!.premium).toBeLessThanOrEqual(points[i - 1]!.premium);
  });
});

describe('the early warning lamps', () => {
  it('[critical] NORMAL under 70% of the threshold, WATCH from there, TRIGGERED at it; unreadable is neither', () => {
    expect(triggerState(0.3)).toBe('NORMAL'); expect(triggerState(0.7)).toBe('WATCH'); expect(triggerState(0.99)).toBe('WATCH');
    expect(triggerState(1)).toBe('TRIGGERED'); expect(triggerState(null)).toBeNull();
    const w = earlyWarning({ flow: { aggressorBuyPct: 0.62, totalVolume: 1000, minutesCovered: 60, cvd: [] } as never, book: { imbalance: -0.31 } as never, oi: null, funding: 0.01, market: null, outlook: fixtureData().outlook, markChange15mPct: null, atmIvChange15mPts: 0.5 });
    const by = Object.fromEntries(w.triggers.map((t) => [t.name, t.state]));
    expect(by['One-sided aggressors']).toBe('WATCH');
    expect(by['Book leaning']).toBe('TRIGGERED');
    expect(by['Funding stretched']).toBe('NORMAL');
    expect(by['Wing premium jumping']).toBeNull();
    for (const t of w.triggers) expect(t.fired).toBe(t.state === null ? null : t.state === 'TRIGGERED');
  });
});

describe('the option bias', () => {
  it('[critical] a side rising in premium, building OI and being bought is STRONG; the reverse WEAK; the pressure is on the stronger', () => {
    const data = fixtureData();
    const b = optionBias({
      legs: data.legs, atm: data.snapshot.atm,
      oi: { ceOiChange1hPct: -12.2, peOiChange1hPct: 18.4, ceAtmMarkChange1hPct: -8.4, peAtmMarkChange1hPct: 12.6 },
      flow: { ce: { pressure: 'SELL PRESSURE' }, pe: { pressure: 'BUY PRESSURE' } },
      sides: [{ side: 'CE', pTouch: 0.14 }, { side: 'PE', pTouch: 0.09 }],
    });
    expect(b.ce).toMatchObject({ strength: 'WEAK', flow: 'SELL', pTouch: 0.14, score: -3 });
    expect(b.pe).toMatchObject({ strength: 'STRONG', flow: 'BUY', pTouch: 0.09, score: 3 });
    expect(b.pressureOn).toBe('PE');
    expect(optionBias({ legs: data.legs, atm: data.snapshot.atm, oi: null, flow: null, sides: [] }).pressureOn).toBeNull();
  });
});

describe('seller impact', () => {
  it('[critical] premium down, touch odds down, distance up and IV down are BETTER; the reverse WORSE; OI is not a vote', () => {
    const now = { pTouch: 0.10, emDistance: 1.8 };
    expect(sellerImpact({ markChangePct: -20, ivChangePts: -1.5, pTouchThen: 0.15, emDistanceThen: 1.6 }, now)).toBe('BETTER');
    expect(sellerImpact({ markChangePct: 117, ivChangePts: 11, pTouchThen: 0.05, emDistanceThen: 2.2 }, now)).toBe('WORSE');
    expect(sellerImpact({ markChangePct: 2, ivChangePts: 0.3, pTouchThen: 0.10, emDistanceThen: 1.8 }, now)).toBe('NEUTRAL');
    expect(sellerImpact({ markChangePct: null, ivChangePts: null, pTouchThen: null, emDistanceThen: null }, now)).toBeNull();
    const st = sellerState([{ minutes: 5, impact: 'BETTER' }, { minutes: 15, impact: 'BETTER' }, { minutes: 60, impact: 'NEUTRAL' }, { minutes: 720, impact: 'WORSE' }]);
    expect(st.state).toBe('IMPROVING');
    expect(sellerState([{ minutes: 5, impact: 'WORSE' }, { minutes: 30, impact: 'BETTER' }, { minutes: 60, impact: 'WORSE' }]).state).toBe('DETERIORATING');
    expect(sellerState([]).state).toBeNull();
  });
});

describe('windows', () => {
  it('fixed windows as written; start is since 05:30 IST today, expiry since 17:30 IST yesterday', () => {
    const at = Date.UTC(2026, 8, 20, 4, 0, 0); // 09:30 IST
    expect(windowMinutes('15m', at)).toBe(15); expect(windowMinutes('24h', at)).toBe(1440);
    expect(windowMinutes('start', at)).toBe(240);
    expect(windowMinutes('expiry', at)).toBe(16 * 60);
    // Before 05:30, since yesterday's open.
    expect(windowMinutes('start', Date.UTC(2026, 8, 19, 23, 0, 0))).toBe(23 * 60);
  });
});
