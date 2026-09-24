import { describe, expect, test } from 'vitest';
import type { ChainResponse, Leg, Outlook } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import {
  sideGates, bestLeg, consensus, expectedMove, feePerContract, freshness, gammaRisk,
  ivRv, keyLevels, marginPerContract, modelView, odds, orderEstimate, premiumAnalysis, skew, volRegime,
  ageText, contractValidity, dataFreshness, expiryDirection, mtfConsensus, optionBias, sellerImpact, sellerState, skewRichness, fundingRead, windowMinutes, triggerState, assessSides, horizonRows, namedLevels, earlyWarning, boardRead, movementVerdict, parseSymbol, positionState, positionViews, premiumMomentum, shortLossAt,
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
});

describe('skew', () => {
});

describe('expected move and premium', () => {
  const snap = { spot: 77_967.5, atmIv: 0.482, hoursToExpiry: 12, expectedMove: null };
});

describe('odds', () => {
});

describe('the decision', () => {
});

const outlook = (over: Partial<Outlook>): Outlook => ({
  rows: [], consensus: null, bullish: 0, bearish: 0, flat: 0, scored: 0, agreement: '',
  directionEdgePts: null, sampleWindows: 105_120, ...over,
});

describe('model view and consensus', () => {
});

describe('freshness', () => {
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

describe('the vol regime', () => {
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
});

describe('the finder drives the cards', () => {
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

describe('the finder\'s best', () => {

});

describe('skew richness', () => {
  it('a strong positive skew makes PE rich, a strong negative CE; near zero is normal', () => {
    expect(skewRichness(7.5, 0.72)).toMatchObject({ ce: 'LOW', pe: 'HIGH' });
    expect(skewRichness(-3, null)).toMatchObject({ ce: 'HIGH', pe: 'LOW' });
    expect(skewRichness(-1, 0.52)).toMatchObject({ ce: 'NORMAL', pe: 'NORMAL' });
    expect(skewRichness(null, null)).toBeNull();
  });
});

describe('expiry direction', () => {
  const data = fixtureData();
  const base = () => ({ spot: data.snapshot.spot, atmIv: data.snapshot.atmIv, hoursToExpiry: data.snapshot.hoursToExpiry, outlook: data.outlook, mtf: mtfConsensus(data.market, data.outlook), movement: null, market: data.market, structure: data.structure, iv: null, fundingRate: null });
  it('[critical] the three odds add to one, the centre is spot plus the tilt, the tilt never exceeds 0.35 EM', () => {
    const d = expiryDirection(base())!;
    expect(d.pUp + d.pDown + d.pRange).toBeCloseTo(1, 6);
    expect(d.expectedExpiry).toBeCloseTo(d.spot + d.tiltUsd, 6);
    expect(Math.abs(d.tiltUsd)).toBeLessThanOrEqual(0.35 * d.em + 1e-9);
    expect(d.range80.high - d.range80.low).toBeCloseTo(2 * 1.2816 * d.em, 3);
    expect(d.distance.map((x) => x.label)).toEqual(['> +1 EM', '> +0.5 EM', '< −0.5 EM', '< −1 EM']);
    expect(d.measured).not.toBeNull();
    expect(d.why.reduce((a, w) => a + w.weight, 0)).toBeCloseTo(1, 6);
  });
  it('a bullish state tilts the odds up, a bearish one down; without an IV there is no answer', () => {
    const up = expiryDirection({ ...base(), market: { ...data.market!, regime: 'trending up', timeframes: data.market!.timeframes.map((t) => ({ ...t, trend: 1, structure: 1 })) }, movement: [{ minutes: 60, type: 'LONG_BUILDUP', direction: 'UP', strength: 'STRONG', flow: 'CONFIRMS' }] })!;
    const down = expiryDirection({ ...base(), market: { ...data.market!, regime: 'trending down', timeframes: data.market!.timeframes.map((t) => ({ ...t, trend: -1, structure: -1 })) }, movement: [{ minutes: 60, type: 'SHORT_BUILDUP', direction: 'DOWN', strength: 'STRONG', flow: 'CONFIRMS' }] })!;
    expect(up.pUp).toBeGreaterThan(down.pUp);
    expect(up.tiltUsd).toBeGreaterThan(0); expect(down.tiltUsd).toBeLessThan(0);
    expect(expiryDirection({ ...base(), atmIv: null })).toBeNull();
  });
});

describe("sideGates liquidity", () => {
  // The desk's limit arrives as a fraction (0.15 = 15 % of the premium), the number the ticket's precheck uses.
  const leg = { ...fixtureData().legs.find((l) => l.cp === 'C' && l.bid && l.ask)! };
  const base = { side: 'CE' as const, iv: null, regime: null, direction: { confirmed: true, readable: 1, summary: '' }, outlook: fixtureData().outlook, tailLossUsd: null, maxDailyLossUsd: null, marginUsd: null, balanceUsd: null };
  test('passes a 10 % spread against a 15 % limit and fails it against 5 %', () => {
    const wide = { ...leg, bid: 100, ask: 110, mark: 105 };
    const pass = sideGates({ ...base, leg: wide, maxSpreadPct: 0.15 }).find((g) => g.name === 'Liquidity')!;
    expect(pass.ok).toBe(true);
    expect(pass.text).toBe('spread 9.5% of premium (limit 15%)');
    expect(sideGates({ ...base, leg: wide, maxSpreadPct: 0.05 }).find((g) => g.name === 'Liquidity')!.ok).toBe(false);
  });
});

describe('funding, read as who pays', () => {
  it('[critical] the four readings from the reference: 0.0095%, 0.001%, 0, −0.0095%', () => {
    expect(fundingRead(0.0095)).toEqual({ decimal: 0.000095, per10k: 0.95, who: 'longs', label: 'Longs pay · bullish', tone: 'up' });
    expect(fundingRead(0.001)).toMatchObject({ per10k: 0.1, who: 'longs', label: 'Longs pay · mild bullish', tone: 'up' });
    expect(fundingRead(0)).toMatchObject({ per10k: 0, who: 'none', label: 'Neutral · no payment', tone: 'muted' });
    expect(fundingRead(-0.0095)).toMatchObject({ per10k: 0.95, who: 'shorts', label: 'Shorts pay · bearish', tone: 'down' });
  });
  it('the usual 0.01% is $1.00 on $10,000 every 8 hours', () => {
    expect(fundingRead(0.01)?.per10k).toBe(1);
  });
  it('no reading is no card', () => {
    expect(fundingRead(null)).toBeNull();
    expect(fundingRead(Number.NaN)).toBeNull();
  });
});
