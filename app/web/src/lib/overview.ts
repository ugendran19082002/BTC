import type { Leg, MarketRead, Outlook } from '@/types/desk';

// ------------------------------------------------------------------ volatility

export type IvRv = { ivPct: number; rvPct: number; spreadPts: number; ratio: number; label: 'rich' | 'fair' | 'cheap' };

/**
 * Implied against realised volatility, both annualised percent.
 *
 * `ratio` is what a seller is paid for against what BTC has been delivering:
 * above 1.15 the premium is rich, under 0.9 it is cheap. Thresholds, not a
 * model -- the label says which side of fair, the numbers say by how much.
 */
export function ivRv(atmIv: number | null, realisedVolPct: number | null): IvRv | null {
  if (atmIv === null || realisedVolPct === null || !(realisedVolPct > 0) || !(atmIv > 0)) return null;
  const ivPct = atmIv * 100;
  const ratio = ivPct / realisedVolPct;
  return {
    ivPct, rvPct: realisedVolPct, spreadPts: ivPct - realisedVolPct, ratio,
    label: ratio >= 1.15 ? 'rich' : ratio <= 0.9 ? 'cheap' : 'fair',
  };
}

/**
 * Is BTC moving more or less than it usually does: the last hour's realised
 * volatility against the 21-day figure. High above 1.3×, low under 0.7×.
 */
export function volRegime(rvShortPct: number | null, rvLongPct: number | null): { label: 'high' | 'normal' | 'low'; ratio: number } | null {
  if (rvShortPct === null || rvLongPct === null || !(rvLongPct > 0)) return null;
  const ratio = rvShortPct / rvLongPct;
  return { ratio, label: ratio >= 1.3 ? 'high' : ratio <= 0.7 ? 'low' : 'normal' };
}

/** The desk's highest-scoring out-of-the-money strike on one side, or null. */
export function bestLeg(legs: readonly Leg[], cp: 'C' | 'P'): Leg | null {
  let best: Leg | null = null;
  for (const l of legs) {
    if (l.cp !== cp || l.moneyness !== 'OTM' || l.score === null) continue;
    if (!best || l.score > best.score!) best = l;
  }
  return best;
}

// ------------------------------------------------------- early warning

export type Trigger = {
  name: string;
  /** The reading, the threshold, and the formula, in words a trader reads. */
  value: string;
  threshold: string;
  formula: string;
  /** null: could not be read. */
  fired: boolean | null;
  /** The reading as a share of its threshold: 1 is the threshold itself. Null where it could not be read. */
  level: number | null;
  /** NORMAL under 70% of the threshold, WATCH from there, TRIGGERED at or past it. A warning level, not a trade signal. */
  state: 'NORMAL' | 'WATCH' | 'TRIGGERED' | null;
  /**
   * How far this reading has come towards its own trigger, out of 100.
   *
   * A lamp says fired or not fired, which is the answer to the wrong
   * question: the useful one is *how close*, and three readings at 80 is a
   * tape about to do something while three at 20 is a quiet afternoon --
   * both of them show as nine grey lamps. Capped at 100, because a reading
   * three times its threshold is not three times the warning, and the raw
   * figure is on the row anyway.
   */
  score: number | null;
  weight: number;
};

/** The three lamps from a reading's share of its threshold. */
export function triggerState(level: number | null): Trigger['state'] {
  if (level === null || !Number.isFinite(level)) return null;
  return level >= 1 ? 'TRIGGERED' : level >= 0.7 ? 'WATCH' : 'NORMAL';
}

export type EarlyWarning = {
  triggers: Trigger[];
  /** Weighted share of triggers fired, 0–1, over the triggers that could be read. */
  score: number | null;
  /**
   * The weighted mean of how far every readable trigger has come, 0-100.
   *
   * The band is still decided by what has actually fired -- a warning that
   * goes off because several things are at eighty would be a warning that goes
   * off constantly. This is the number beside it: the pressure, which moves
   * long before the band does, and which is what somebody watching the screen
   * is actually watching.
   */
  pressure: number | null;
  band: 'calm' | 'watch' | 'high' | 'sudden';
  /** Which way the pressure points, from flow and OI: +1 up, −1 down, 0 unclear. */
  lean: -1 | 0 | 1;
  action: string;
};

/**
 * Before a big move: the readings that tend to run ahead of one, each with its
 * threshold and formula. Thresholds are the desk's, chosen to be loud only
 * when several fire together -- one burst of volume is a print; a burst with
 * one-sided aggressors, OI speeding up and the wings' premium jumping is a
 * move starting. The 28 Aug 2025 session is the reference: the 114,000 call
 * went 5.6 → 101.9 inside one hour, five hours after entry.
 */
export function earlyWarning(input: {
  flow: { aggressorBuyPct: number | null; cvd: { at: number; cvd: number }[]; minutesCovered: number; totalVolume?: number } | null;
  book: { imbalance: number | null } | null;
  oi: { ceChange1h: number | null; peChange1h: number | null; ceAcceleration: number | null; peAcceleration: number | null } | null;
  funding: number | null;
  market: MarketRead | null;
  outlook: Outlook;
  /** The selected strike's premium and ATM IV change over 15 minutes, points and percent. */
  markChange15mPct: number | null;
  atmIvChange15mPts: number | null;
}): EarlyWarning {
  const { flow, book, oi, funding, market, outlook } = input;
  const burst = market?.volume.find((v) => v.tf === '5m')?.spike ?? null;
  const move15 = market?.moves.find((m) => m.label === 'last 15m')?.changePct ?? null;
  const em15 = outlook.rows.find((r) => r.minutes === 15);
  const em15Pct = em15?.impliedUsd != null && em15.spot > 0 ? (em15.impliedUsd / em15.spot) * 100 : null;
  const tail = flow ? flow.cvd.slice(-15) : [];
  const slope = tail.length >= 6 ? (tail[tail.length - 1]!.cvd - tail[0]!.cvd) / (tail.length - 1) : null;
  // The slope means nothing in raw contracts: a busy tape has a big CVD either way. Against the tape's own pace.
  const perMin = flow && flow.totalVolume !== undefined && flow.minutesCovered > 0 ? flow.totalVolume / flow.minutesCovered : null;
  const slopeShare = slope !== null && perMin !== null && perMin > 0 ? slope / perMin : null;
  // A 15-minute implied move is small; under a quarter percent nothing is "expanding".
  const rangeAt = em15Pct === null ? null : Math.max(0.25, 0.6 * em15Pct);
  const accel = oi ? Math.max(Math.abs(oi.ceAcceleration ?? 0), Math.abs(oi.peAcceleration ?? 0)) : null;
  const change = oi ? Math.max(Math.abs(oi.ceChange1h ?? 0), Math.abs(oi.peChange1h ?? 0)) : null;
  const raw: Omit<Trigger, 'state' | 'score'>[] = [
    { name: 'Volume burst', value: burst === null ? '—' : `${burst.toFixed(1)}× median`, threshold: '≥ 2.0×', formula: 'last 5m bar volume ÷ median of the 20 before it',
      fired: burst === null ? null : burst >= 2, level: burst === null ? null : burst / 2, weight: 2 },
    { name: 'One-sided aggressors', value: flow?.aggressorBuyPct == null ? '—' : `${(flow.aggressorBuyPct * 100).toFixed(0)}% buys`, threshold: '≥ 65% or ≤ 35%', formula: 'buy volume ÷ (buy + sell), aggressor side, last hour',
      fired: flow?.aggressorBuyPct == null ? null : flow.aggressorBuyPct >= 0.65 || flow.aggressorBuyPct <= 0.35, level: flow?.aggressorBuyPct == null ? null : Math.abs(flow.aggressorBuyPct - 0.5) / 0.15, weight: 2 },
    { name: 'CVD slope', value: slope === null ? '—' : `${slope >= 0 ? '+' : ''}${slope.toFixed(0)} ct/min${slopeShare === null ? '' : ` (${(slopeShare * 100).toFixed(0)}% of pace)`}`, threshold: '|slope| ≥ 40% of the tape\'s pace', formula: '(CVD now − CVD 15m ago) ÷ 15, against volume per minute over the hour; needs six minutes of prints',
      fired: slopeShare === null ? null : Math.abs(slopeShare) >= 0.4, level: slopeShare === null ? null : Math.abs(slopeShare) / 0.4, weight: 1 },
    { name: 'OI accelerating', value: accel === null ? '—' : `${accel.toFixed(0)} ct of ${change?.toFixed(0) ?? '—'}`, threshold: '≥ half the hour\'s change', formula: 'OI change over the hour − the same reading an hour earlier',
      fired: accel === null || change === null || change === 0 ? null : accel >= 0.5 * change && change >= 200, level: accel === null || change === null || change === 0 ? null : Math.min(accel / (0.5 * change), change / 200), weight: 1 },
    { name: 'IV jumping', value: input.atmIvChange15mPts === null ? '—' : `${input.atmIvChange15mPts >= 0 ? '+' : ''}${input.atmIvChange15mPts.toFixed(1)} pts / 15m`, threshold: '≥ +2 pts', formula: 'ATM IV now − ATM IV 15m ago',
      fired: input.atmIvChange15mPts === null ? null : input.atmIvChange15mPts >= 2, level: input.atmIvChange15mPts === null ? null : Math.max(0, input.atmIvChange15mPts) / 2, weight: 2 },
    { name: 'Range expanding', value: move15 === null ? '—' : `${move15 >= 0 ? '+' : ''}${move15.toFixed(2)}% / 15m`, threshold: rangeAt === null ? '≥ 0.6 × EM(15m), at least 0.25%' : `≥ ${rangeAt.toFixed(2)}%`, formula: '|BTC move over 15m| ≥ 0.6 × (spot × IV × √(15m / 1y)), and never under 0.25%',
      fired: move15 === null || rangeAt === null ? null : Math.abs(move15) >= rangeAt, level: move15 === null || rangeAt === null ? null : Math.abs(move15) / rangeAt, weight: 2 },
    { name: 'Book leaning', value: book?.imbalance == null ? '—' : `${(book.imbalance * 100).toFixed(0)}%`, threshold: '|imbalance| ≥ 30%', formula: '(bid depth − ask depth) ÷ (bid + ask), 20 levels',
      fired: book?.imbalance == null ? null : Math.abs(book.imbalance) >= 0.3, level: book?.imbalance == null ? null : Math.abs(book.imbalance) / 0.3, weight: 1 },
    { name: 'Wing premium jumping', value: input.markChange15mPct === null ? '—' : `${input.markChange15mPct >= 0 ? '+' : ''}${input.markChange15mPct.toFixed(0)}% / 15m`, threshold: '≥ +30%', formula: 'selected strike mark now ÷ mark 15m ago − 1',
      fired: input.markChange15mPct === null ? null : input.markChange15mPct >= 30, level: input.markChange15mPct === null ? null : Math.max(0, input.markChange15mPct) / 30, weight: 2 },
    { name: 'Funding stretched', value: funding === null ? '—' : `${funding.toFixed(4)}%`, threshold: '|rate| ≥ 0.05%', formula: 'the perp\'s funding rate, as Delta publishes it',
      fired: funding === null ? null : Math.abs(funding) >= 0.05, level: funding === null ? null : Math.abs(funding) / 0.05, weight: 1 },
  ];
  const t: Trigger[] = raw.map((x) => ({
    ...x,
    state: triggerState(x.level),
    score: x.level === null || !Number.isFinite(x.level) ? null : Math.round(Math.max(0, Math.min(1, x.level)) * 100),
  }));
  const readable = t.filter((x) => x.fired !== null);
  const wsum = readable.reduce((a, x) => a + x.weight, 0);
  const score = wsum === 0 ? null : readable.reduce((a, x) => a + (x.fired ? x.weight : 0), 0) / wsum;
  const scored = readable.filter((x) => x.score !== null);
  const pressureSum = scored.reduce((a, x) => a + x.weight, 0);
  const pressure = pressureSum === 0 ? null
    : Math.round(scored.reduce((a, x) => a + x.score! * x.weight, 0) / pressureSum);
  const band: EarlyWarning['band'] = score === null ? 'calm' : score >= 0.6 ? 'sudden' : score >= 0.4 ? 'high' : score >= 0.2 ? 'watch' : 'calm';
  // Which way: aggressors lifting offers lean up; puts being written faster than calls lean up (the crowd sells the dip).
  const flowLean = flow?.aggressorBuyPct == null ? 0 : flow.aggressorBuyPct > 0.55 ? 1 : flow.aggressorBuyPct < 0.45 ? -1 : 0;
  const oiLean = oi && oi.peChange1h !== null && oi.ceChange1h !== null ? Math.sign(oi.peChange1h - oi.ceChange1h) : 0;
  const lean: -1 | 0 | 1 = Math.sign(flowLean + oiLean) as -1 | 0 | 1;
  const action = band === 'sudden' ? 'Move starting: no new naked sells; hedge or close the threatened side now.'
    : band === 'high' ? 'Pressure building: only sell beyond the wall, half size, with the wing bought.'
      : band === 'watch' ? 'Something stirring: tighten stops, keep size to the risk mode.'
        : 'Calm tape: the normal rules apply.';
  return { triggers: t, score, pressure, band, lean, action };
}

// ------------------------------------------------------------ windows

export type WindowChoice = '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '24h' | 'start' | 'expiry';
export const WINDOW_CHOICES: readonly WindowChoice[] = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '24h', 'start', 'expiry'];

/**
 * A window choice as minutes: the fixed ones as written; `start` since the
 * desk opened at 05:30 IST today; `expiry` since the last settlement, 17:30
 * IST yesterday -- the contract's whole life. Never under five minutes, never
 * over a day.
 */
export function windowMinutes(choice: WindowChoice, nowMs: number): number {
  const fixed: Record<string, number> = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '24h': 1440 };
  if (choice in fixed) return fixed[choice]!;
  const IST = 5.5 * 3_600_000;
  const ist = new Date(nowMs + IST);
  const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST;
  const start = day + 5.5 * 3_600_000;
  const lastSettle = day + 17.5 * 3_600_000 - 24 * 3_600_000;
  const from = choice === 'start' ? (start <= nowMs ? start : start - 24 * 3_600_000) : (lastSettle <= nowMs ? lastSettle : lastSettle - 24 * 3_600_000);
  return Math.max(5, Math.min(1440, Math.round((nowMs - from) / 60_000)));
}
export const windowLabel = (c: WindowChoice) => (c === 'start' ? 'since 05:30' : c === 'expiry' ? 'since last expiry' : c);

// ------------------------------------------------------------------ funding

export type FundingRead = {
  /** The rate as a decimal: 0.0095% is 0.000095. */
  decimal: number;
  /** What a $10,000 position pays (or receives) at one settlement, in USD. */
  per10k: number;
  who: 'longs' | 'shorts' | 'none';
  /** "Longs pay · bullish", "Shorts pay · mild bearish", "Neutral · no payment". */
  label: string;
  tone: 'up' | 'down' | 'muted';
};

/**
 * The perpetual's funding, read the way a person asks about it: who pays, how
 * much on a round $10,000, and which way the crowd leans. Delta quotes the rate
 * in per cent per eight hours; 0.005% and more reads as a full bias, under it
 * as mild -- 0.0095% is bullish, 0.001% mildly so.
 */
export function fundingRead(ratePct: number | null): FundingRead | null {
  if (ratePct === null || !Number.isFinite(ratePct)) return null;
  const decimal = Math.round((ratePct / 100) * 1e10) / 1e10;   // 0.0095 / 100 is 0.0000949999… in floating point
  const per10k = Math.round(10_000 * decimal * 100) / 100;
  if (ratePct === 0) return { decimal, per10k: 0, who: 'none', label: 'Neutral · no payment', tone: 'muted' };
  const strong = Math.abs(ratePct) >= 0.005;
  return ratePct > 0
    ? { decimal, per10k, who: 'longs', label: `Longs pay · ${strong ? 'bullish' : 'mild bullish'}`, tone: 'up' }
    : { decimal, per10k: Math.abs(per10k), who: 'shorts', label: `Shorts pay · ${strong ? 'bearish' : 'mild bearish'}`, tone: 'down' };
}
