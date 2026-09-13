import type { MarketRead } from '../market/moves.js';
import type { OiChange } from '../market/oi-history.js';
import type { OptionStructure } from './structure.js';

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

export type ShockPart = {
  name: string;
  /** 0-1, before its weight. */
  value: number;
  weight: number;
  /** The figure itself, in the units it is read in. Null when unreadable. */
  note: string | null;
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
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

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

export function suddenMove(i: {
  spot: number;
  atmIv: number | null;
  market: MarketRead | null;
  structure: OptionStructure;
  /** Per-strike open-interest changes, if the desk has any history yet. */
  oiChanges: Map<string, OiChange>;
  iv: { changePct: number; overMinutes: number } | null;
}): SuddenMove {
  const parts: ShockPart[] = [];
  const reasons: string[] = [];

  // ── 1. how far it moved, against how far it was priced to ────────────────
  const m5 = i.market?.moves.find((m) => m.hours <= 0.1) ?? null;
  const em5 = expectedMoveOver(i.spot, i.atmIv, 5 / 60);
  let moveRatio: number | null = null;
  if (m5?.rangeUsd != null && em5 !== null && em5 > 0) {
    moveRatio = m5.rangeUsd / em5;
    parts.push({
      name: 'Move against expected',
      value: clamp01((moveRatio - 0.5) / 1.0),
      weight: SHOCK_WEIGHTS.moveShock,
      note: `${moveRatio.toFixed(2)}× the 5-minute expected move`,
    });
    if (moveRatio >= 1) reasons.push(`5m range is ${moveRatio.toFixed(1)}× what it was priced for`);
  } else {
    parts.push({ name: 'Move against expected', value: 0, weight: SHOCK_WEIGHTS.moveShock, note: null });
  }

  // ── 2. how busy, against its own median ──────────────────────────────────
  const pulse = i.market?.volume.find((v) => v.tf === '5m') ?? null;
  if (pulse?.spike != null) {
    parts.push({
      name: 'Volume spike',
      value: clamp01((pulse.spike - 1) / 2),
      weight: SHOCK_WEIGHTS.volumeSpike,
      note: `${pulse.spike.toFixed(1)}× the 20-bar median`,
    });
    if (pulse.spike >= 2) reasons.push(`5m volume is ${pulse.spike.toFixed(1)}× its median`);
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
  const dirParts: number[] = [];
  if (m5?.changePct != null) dirParts.push(clamp01(Math.abs(m5.changePct) / 0.5) * Math.sign(m5.changePct));
  if (i.market) dirParts.push(i.market.agreement / 5);
  const ceV = i.structure.ceVolume;
  const peV = i.structure.peVolume;
  if (ceV + peV > 0) dirParts.push((ceV - peV) / (ceV + peV));

  const direction = dirParts.length
    ? Math.max(-1, Math.min(1, dirParts.reduce((a, v) => a + v, 0) / dirParts.length))
    : null;

  const directionLabel =
    direction === null ? 'no read'
      : direction > 0.3 ? 'upside pressure'
        : direction < -0.3 ? 'downside pressure'
          : 'no clear side';

  return { score, band, parts, reasons, direction, directionLabel };
}
