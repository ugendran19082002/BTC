import type { MarketRead } from '../market/moves.js';
import type { OiChange } from '../market/oi-history.js';
import type { OptionStructure } from './structure.js';
import { loadHorizons } from './forecast.js';

/**
 * Whether something is happening right now.
 *
 * Not a forecast. Five readings of the present tape — how far BTC has moved
 * against how far it was priced to, how busy the tape is against its own recent
 * median, whether volatility is repricing, whether open interest is moving, and
 * how one-sided the board is — combined into a 0-100 number and a direction.
 *
 * ## What it is for, and what it is not
 *
 * A short-premium desk loses on the days that move, so "is this one of those
 * days" is worth asking even when the answer cannot be acted on mechanically.
 * This answers it from what is observable, and says *why* in words, because a
 * risk number with no reasons attached is one nobody can check or argue with.
 *
 * **Nothing reads it.** Not the recommendation, not the gates, not the strategy
 * runner. None of these weights has been through the cross-period screen the
 * premium floor and the RSI gate went through, and the repo has a table of
 * things that looked excellent on one period and reversed on the next. It is
 * shown, labelled, and left to the person.
 *
 * The direction is the weakest part and is marked as such. Over 105,119
 * five-minute windows the chance BTC finishes higher never moved further than
 * 0.6 points from a coin flip at any horizon out to twelve hours — so a
 * direction read off the present tape is a statement about pressure now, not
 * about where it settles.
 */

/** What the five parts are worth. A starting point, not a result. */
export const SHOCK_WEIGHTS = {
  /** How far BTC has moved against how far it was priced to move. */
  moveShock: 0.30,
  /** How busy the tape is against its own recent median. */
  volumeSpike: 0.25,
  /** Whether volatility is being repriced. */
  ivShock: 0.20,
  /** Whether positions are being opened or closed. */
  oiChange: 0.15,
  /** How one-sided the board is. */
  imbalance: 0.10,
} as const;

export type ShockBand = 'normal' | 'watch' | 'high' | 'sudden';

export const SHOCK_AT = { watch: 30, high: 50, sudden: 70 } as const;

/**
 * How often BTC has actually moved more than `thresholdPct` over a window.
 *
 * Counted off the 101 measured percentiles of the signed return in
 * `chain.db`'s `horizons` table — 105,120 five-minute windows over a year — so
 * this is a frequency that happened, not a lognormal that was assumed. The
 * repo's own note on that table says as much: an option's expected payout is
 * worked out against what BTC did rather than against a distribution.
 *
 * The nearest measured horizon is used and reported, rather than a horizon
 * scaled to whatever was asked for. A number quietly √t-scaled from five
 * minutes to four hours is a number nobody can check against the table.
 */
export type MoveOdds = {
  /** The horizon actually read, in minutes. */
  overMinutes: number;
  thresholdPct: number;
  /** Share of windows that rose more than the threshold. */
  up: number;
  down: number;
  /**
   * Share that stayed inside it — the outcome the other two leave out.
   *
   * Without this the three figures on screen are 9%, 10% and 19%, which a
   * reader looking at three boxes takes for a breakdown and finds does not add
   * up. `up + down + inside` is the whole of it, and 81% of windows going
   * nowhere is the most important of the three for somebody selling premium.
   */
  inside: number;
  /** `up + down`, kept because it is the number a seller asks for. */
  either: number;
};

export function moveOdds(minutes: number, thresholdPct = 1): MoveOdds | null {
  const rows = loadHorizons().filter((r) => r.quantiles.length > 1);
  if (!rows.length) return null;

  const row = rows.reduce((a, b) =>
    Math.abs(b.minutes - minutes) < Math.abs(a.minutes - minutes) ? b : a);

  const n = row.quantiles.length;
  const up = row.quantiles.filter((q) => q > thresholdPct).length / n;
  const down = row.quantiles.filter((q) => q < -thresholdPct).length / n;
  return {
    overMinutes: row.minutes,
    thresholdPct,
    up,
    down,
    // Every window is exactly one of the three, so they add to one.
    inside: Math.max(0, 1 - up - down),
    // A window rose or fell, never both, so these two simply add.
    either: up + down,
  };
}

export type ShockPart = {
  name: string;
  /** 0-1, before its weight. */
  value: number;
  weight: number;
  /** The figure itself, in the units it is read in. Null when unreadable. */
  note: string | null;
  /**
   * The headline figure and the two numbers behind it.
   *
   * A ratio on its own says nothing: "3.2x" needs "12.4k against a 3.8k median"
   * beside it or a reader cannot tell a busy strike from a quiet coin. Null
   * wherever the reading could not be taken at all.
   */
  detail?: { headline: string; now: string; before: string } | null;
};

export type SuddenMove = {
  /** 0-100. Null when not one part could be read. */
  score: number | null;
  band: ShockBand;
  parts: ShockPart[];
  /** Only the parts that are actually raised, worst first — what to print. */
  reasons: string[];
  /**
   * −1 fully down, +1 fully up, from momentum, volume and how the two sides are
   * positioned. Null when nothing readable points either way.
   */
  direction: number | null;
  directionLabel: string;
  /**
   * What the direction is made of, each −1..+1 and named.
   *
   * One number saying "downside 68%" is a number nobody can check. These are
   * the readings behind it, and a reader who disagrees with one can see which.
   */
  directionParts: { name: string; value: number }[];
  /** The window every reading above was taken over. */
  window: number;
  /**
   * How often BTC has moved more than a percent over the next few hours,
   * counted off the measured percentiles rather than assumed.
   */
  odds: MoveOdds | null;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** 12,400 reads as 12.4k. A seven-digit count in a tile is a wall of digits. */
const compact = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
      : n.toFixed(0);

/**
 * The expected move over a window shorter than expiry.
 *
 * `spot × IV × √(hours ÷ 8760)` — the same formula the board already shows for
 * the whole contract, scaled to the window being asked about. Comparing a
 * five-minute move against a twelve-hour expected move is how a quiet tape gets
 * read as calm when it is not.
 */
export function expectedMoveOver(spot: number, atmIv: number | null, hours: number): number | null {
  if (atmIv === null || atmIv <= 0 || spot <= 0 || hours <= 0) return null;
  return spot * atmIv * Math.sqrt(hours / 8760);
}

/** The windows the screen offers, in minutes. */
export const SHOCK_WINDOWS = [5, 15, 60, 240] as const;
export type ShockWindow = (typeof SHOCK_WINDOWS)[number];

/** How each window is written, on screen and in the readings' own sentences. */
export const WINDOW_LABEL: Record<ShockWindow, string> = {
  5: '5m', 15: '15m', 60: '1h', 240: '4h',
};

export function suddenMove(i: {
  spot: number;
  atmIv: number | null;
  market: MarketRead | null;
  structure: OptionStructure;
  /** Per-strike open-interest changes, if the desk has any history yet. */
  oiChanges: Map<string, OiChange>;
  iv: { changePct: number; overMinutes: number; from: number; to: number } | null;
  /**
   * The window every reading is taken over. Five minutes says whether something
   * is happening *now*; four hours says whether the session has been unusual,
   * and they are genuinely different questions — a toggle that did not change
   * the readings would be a control that lies about what it does.
   */
  window?: ShockWindow;
}): SuddenMove {
  const win = i.window ?? 5;
  const label = WINDOW_LABEL[win];
  const parts: ShockPart[] = [];
  const reasons: string[] = [];

  // ── 1. how far it moved, against how far it was priced to ────────────────
  const wantHours = win / 60;
  const m5 = i.market?.moves.length
    ? i.market.moves.reduce((a, b) =>
        Math.abs(b.hours - wantHours) < Math.abs(a.hours - wantHours) ? b : a)
    : null;
  const em5 = expectedMoveOver(i.spot, i.atmIv, m5?.hours ?? wantHours);
  let moveRatio: number | null = null;
  if (m5?.rangeUsd != null && em5 !== null && em5 > 0) {
    moveRatio = m5.rangeUsd / em5;
    parts.push({
      name: 'Move against expected',
      value: clamp01((moveRatio - 0.5) / 1.0),
      weight: SHOCK_WEIGHTS.moveShock,
      note: `${moveRatio.toFixed(2)}× the ${label} expected move`,
      detail: {
        headline: `${moveRatio.toFixed(1)}×`,
        now: `${label} range: ${((m5.rangeUsd / i.spot) * 100).toFixed(2)}%`,
        before: `Expected (${label}): ${((em5 / i.spot) * 100).toFixed(2)}%`,
      },
    });
    if (moveRatio >= 1) reasons.push(`${label} range is ${moveRatio.toFixed(1)}× what it was priced for`);
  } else {
    parts.push({ name: 'Move against expected', value: 0, weight: SHOCK_WEIGHTS.moveShock, note: null });
  }

  // ── 2. how busy, against its own median ──────────────────────────────────
  const pulse = i.market?.volume.find((v) => v.tf === label) ?? null;
  if (pulse?.spike != null) {
    parts.push({
      name: 'Volume spike',
      value: clamp01((pulse.spike - 1) / 2),
      weight: SHOCK_WEIGHTS.volumeSpike,
      note: `${pulse.spike.toFixed(1)}× the 20-bar median`,
      detail: {
        headline: `${pulse.spike.toFixed(1)}×`,
        now: `Current: ${compact(pulse.current)}`,
        before: `20-bar median: ${compact(pulse.median)}`,
      },
    });
    if (pulse.spike >= 2) reasons.push(`${label} volume is ${pulse.spike.toFixed(1)}× its median`);
  } else {
    parts.push({ name: 'Volume spike', value: 0, weight: SHOCK_WEIGHTS.volumeSpike, note: null });
  }

  // ── 3. is volatility being repriced ──────────────────────────────────────
  if (i.iv) {
    const up = Math.max(0, i.iv.changePct);
    parts.push({
      name: 'Volatility repricing',
      value: clamp01(up / 8),
      weight: SHOCK_WEIGHTS.ivShock,
      note: `${i.iv.changePct >= 0 ? '+' : ''}${i.iv.changePct.toFixed(1)}% over ${i.iv.overMinutes}m`,
      detail: {
        headline: `${i.iv.changePct >= 0 ? '+' : ''}${i.iv.changePct.toFixed(1)}%`,
        now: `IV now: ${(i.iv.to * 100).toFixed(1)}%`,
        before: `${i.iv.overMinutes}m ago: ${(i.iv.from * 100).toFixed(1)}%`,
      },
    });
    if (i.iv.changePct >= 3) {
      reasons.push(`implied volatility is up ${i.iv.changePct.toFixed(1)}% in ${i.iv.overMinutes} minutes`);
    }
  } else {
    parts.push({ name: 'Volatility repricing', value: 0, weight: SHOCK_WEIGHTS.ivShock, note: null });
  }

  // ── 4. are positions being opened ────────────────────────────────────────
  const changes = [...i.oiChanges.values()];
  if (changes.length) {
    const opened = changes.reduce((a, c) => a + Math.abs(c.change), 0);
    const base = i.structure.ceOi + i.structure.peOi;
    const share = base > 0 ? (opened / base) * 100 : 0;
    const over = changes[0]!.overMinutes;
    parts.push({
      name: 'Open interest moving',
      value: clamp01(share / 10),
      weight: SHOCK_WEIGHTS.oiChange,
      note: `${share.toFixed(1)}% of what is open changed in ${over}m`,
      detail: {
        headline: `${share.toFixed(1)}%`,
        now: `Turned over: ${compact(opened)}`,
        before: `Open: ${compact(base)}`,
      },
    });
    if (share >= 5) reasons.push(`${share.toFixed(1)}% of open interest turned over in ${over} minutes`);
  } else {
    // Absent, not calm. Before the first bucket there is nothing to read.
    parts.push({ name: 'Open interest moving', value: 0, weight: SHOCK_WEIGHTS.oiChange, note: null });
  }

  // ── 5. how one-sided the board is ────────────────────────────────────────
  const pcr = i.structure.pcrOi;
  if (pcr !== null && pcr > 0) {
    // Distance from parity, either way: 0.5 and 2.0 are equally lopsided.
    const lopsided = Math.abs(Math.log(pcr));
    parts.push({
      name: 'One-sided positioning',
      value: clamp01(lopsided / Math.log(3)),
      weight: SHOCK_WEIGHTS.imbalance,
      note: `${pcr.toFixed(2)} puts per call`,
      detail: {
        headline: pcr.toFixed(2),
        now: `PE OI: ${compact(i.structure.peOi)}`,
        before: `CE OI: ${compact(i.structure.ceOi)}`,
      },
    });
    if (lopsided >= Math.log(2)) {
      reasons.push(`positioning is lopsided at ${pcr.toFixed(2)} puts per call`);
    }
  } else {
    parts.push({ name: 'One-sided positioning', value: 0, weight: SHOCK_WEIGHTS.imbalance, note: null });
  }

  const readable = parts.filter((p) => p.note !== null);
  const score = readable.length
    ? Math.round(
        (parts.reduce((a, p) => a + p.weight * p.value, 0)
          / parts.reduce((a, p) => a + p.weight, 0)) * 100,
      )
    : null;

  const band: ShockBand =
    score === null || score < SHOCK_AT.watch ? 'normal'
      : score < SHOCK_AT.high ? 'watch'
        : score < SHOCK_AT.sudden ? 'high'
          : 'sudden';

  /*
   * Direction, from what is pushing now rather than from where it settles.
   *
   * Momentum over five minutes, the multi-timeframe agreement the board already
   * computes, and which side of the book is busier. Deliberately not weighted
   * against the shock score: "something is happening" and "which way" are
   * different questions and blending them hides which one the number answers.
   */
  const directionParts: { name: string; value: number }[] = [];
  if (m5?.changePct != null) {
    directionParts.push({
      name: 'Price momentum',
      value: clamp01(Math.abs(m5.changePct) / 0.5) * Math.sign(m5.changePct),
    });
  }
  if (i.market) {
    directionParts.push({ name: 'Timeframes agreeing', value: i.market.agreement / 5 });
  }
  const ceV = i.structure.ceVolume;
  const peV = i.structure.peVolume;
  if (ceV + peV > 0) {
    directionParts.push({ name: 'Call against put activity', value: (ceV - peV) / (ceV + peV) });
  }
  if (i.structure.pcrOi !== null && i.structure.pcrOi > 0) {
    // Crowded downside already hedged reads mildly positive -- the same sense
    // `domain/score.ts` gives it, kept so the two never disagree on screen.
    directionParts.push({
      name: 'How the two sides are positioned',
      value: Math.max(-1, Math.min(1, (i.structure.pcrOi - 1) / 1.5)),
    });
  }

  const direction = directionParts.length
    ? Math.max(-1, Math.min(1, directionParts.reduce((a, p) => a + p.value, 0) / directionParts.length))
    : null;

  const directionLabel =
    direction === null ? 'no read'
      : direction > 0.3 ? 'upside pressure'
        : direction < -0.3 ? 'downside pressure'
          : 'no clear side';

  return {
    score, band, parts, reasons, direction, directionLabel, directionParts,
    // Four hours: long enough that a sudden move has somewhere to go, short
    // enough to still be about today's contract.
    odds: moveOdds(4 * 60, 1),
    window: win,
  };
}
