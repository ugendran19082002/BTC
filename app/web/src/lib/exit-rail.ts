/**
 * Where the price stands between a trade's target and its stop, as places along one line (owner's reference,
 * 6 Oct 2026): the target at the left, the stop at the right, the entry between them in proportion, and the price
 * now moving from one toward the other. Left is where the trade wants to go, right is where it must not -- for a
 * short and a long alike, so the picture reads the same whichever way the numbers run.
 *
 * Pure: prices in, percentages of the line out. A missing level is left out and the rest still draws.
 */

export type RailInput = {
  entry: number | null;
  target: number | null;
  stop: number | null;
  current: number | null;
};

export type Rail = {
  /** Places along the line, 0-100. Null where there is no such level. */
  targetAt: number | null;
  entryAt: number | null;
  stopAt: number | null;
  currentAt: number | null;
  /** Which way the price has gone from the entry, for the colour of the fill; null with no entry or no price. */
  side: 'target' | 'stop' | null;
  /** The price has reached or passed a level. */
  hit: 'target' | 'stop' | null;
  /** Points still between the price and each level (never below zero), and that as a share of the price. */
  toTarget: { points: number; pct: number | null } | null;
  toStop: { points: number; pct: number | null } | null;
};

/** The ends of the line, with room at each for a label; and how near an end the entry may be drawn. */
const LEFT = 8, RIGHT = 92, ENTRY_MIN = 28, ENTRY_MAX = 72, EDGE_MIN = 2, EDGE_MAX = 98;

const ok = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function railOf(i: RailInput): Rail | null {
  const hasT = ok(i.target), hasS = ok(i.stop), hasE = ok(i.entry);
  if (!hasT && !hasS) return null;

  // The anchors. With both levels the entry sits between them in proportion, kept clear of the labels at each end;
  // with one level the entry takes the other end.
  const targetAt = hasT ? LEFT : null;
  const stopAt = hasS ? RIGHT : null;
  let entryAt: number | null = null;
  if (hasE) {
    if (hasT && hasS) {
      const a = Math.abs(i.entry! - i.target!), b = Math.abs(i.stop! - i.entry!);
      entryAt = a + b > 0 ? clamp(lerp(LEFT, RIGHT, a / (a + b)), ENTRY_MIN, ENTRY_MAX) : 50;
    } else entryAt = hasT ? RIGHT : LEFT;
  }

  let currentAt: number | null = null;
  let side: Rail['side'] = null;
  let hit: Rail['hit'] = null;
  if (ok(i.current)) {
    const c = i.current;
    if (hasE) {
      // How far from the entry toward each level: 1 is the level itself.
      const toS = hasS && i.stop !== i.entry ? (c - i.entry!) / (i.stop! - i.entry!) : null;
      const toT = hasT && i.target !== i.entry ? (c - i.entry!) / (i.target! - i.entry!) : null;
      if (toS !== null && toS > 0) {
        side = 'stop';
        currentAt = lerp(entryAt!, RIGHT, toS);
        if (toS >= 1) hit = 'stop';
      } else if (toT !== null && toT > 0) {
        side = 'target';
        currentAt = lerp(entryAt!, LEFT, toT);
        if (toT >= 1) hit = 'target';
      } else {
        // Exactly at the entry, or moving toward a level this trade does not have.
        currentAt = toS !== null ? lerp(entryAt!, LEFT, -toS) : toT !== null ? lerp(entryAt!, RIGHT, -toT) : entryAt;
        side = c === i.entry ? null : toS !== null ? 'target' : 'stop';
      }
    } else if (hasT && hasS && i.stop !== i.target) {
      const t = (c - i.target!) / (i.stop! - i.target!);
      currentAt = lerp(LEFT, RIGHT, t);
      if (t <= 0) hit = 'target'; else if (t >= 1) hit = 'stop';
    }
    if (currentAt !== null) currentAt = clamp(currentAt, EDGE_MIN, EDGE_MAX);
  }

  const gap = (level: number | null) => {
    if (!ok(level) || !ok(i.current)) return null;
    const points = Math.abs(level - i.current);
    return { points, pct: i.current > 0 ? points / i.current : null };
  };
  return {
    targetAt, entryAt, stopAt, currentAt, side, hit,
    toTarget: hit === 'target' ? { points: 0, pct: 0 } : gap(i.target),
    toStop: hit === 'stop' ? { points: 0, pct: 0 } : gap(i.stop),
  };
}
