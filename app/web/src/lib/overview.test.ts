import { describe, expect, test } from 'vitest';
import type { ChainResponse, Leg, Outlook } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import { bestLeg, earlyWarning, fundingRead, ivRv, triggerState, volRegime, windowMinutes } from './overview';

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

describe('the best leg', () => {
  test('the best leg is out of the money and the highest scored', () => {
    const b = bestLeg([
      leg({ strike: 78_000, score: 0.6 }), leg({ strike: 78_500, score: 0.8 }),
      leg({ strike: 77_500, moneyness: 'ITM', score: 0.9 }), leg({ cp: 'P', score: 0.99 }),
    ], 'C');
    expect(b?.strike).toBe(78_500);
  });
});

const outlook = (over: Partial<Outlook>): Outlook => ({
  rows: [], consensus: null, bullish: 0, bearish: 0, flat: 0, scored: 0, agreement: '',
  directionEdgePts: null, sampleWindows: 105_120, ...over,
});

test('key levels come sorted high to low, and only from what was read', () => {
  const lv = keyLevels({
    ceOiWall: { strike: 80_000, value: 1 }, ceOiWallNear: { strike: 78_400, value: 1 },
    peOiWall: { strike: 77_420, value: 1 }, maxPain: { strike: 78_000, payoutUsd: 0 }, gammaWall: null,
  } as never, 78_120, 76_840);
  expect(lv.map((l) => l.price)).toEqual([78_400, 78_120, 78_000, 77_420, 76_840]);
});

describe('the vol regime', () => {
  it('the regime is the hour against the month', () => {
    expect(volRegime(60, 40)?.label).toBe('high');
    expect(volRegime(20, 40)?.label).toBe('low');
    expect(volRegime(40, 40)?.label).toBe('normal');
    expect(volRegime(null, 40)).toBeNull();
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
