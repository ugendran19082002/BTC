import type { PriceChange } from '@/api/desk';

/**
 * The phone's Price changes screen (owner, 7 Oct 2026): BTC's index now against each window back -- a minute out
 * to half a day -- and against the desk's own marks, the first entry of what it holds and the last 17:30
 * settlement. The desk's card shows the points and the percent and keeps the price it moved from in a hover; a
 * phone has no hover, so here each line says it outright: from what, to what, how far.
 */

export type PriceMove = {
  key: string;
  /** "30m", "4h", "Since entry", "Last settlement". */
  label: string;
  mark: PriceChange['mark'];
  /** When "from" is, epoch ms. */
  at: number;
  from: number | null;
  to: number | null;
  pts: number | null;
  pct: number | null;
  way: 'up' | 'down' | 'flat';
  /** This move against the largest on the screen, 0-1: the length of its bar. */
  share: number;
};

export const windowLabel = (r: Pick<PriceChange, 'minutes' | 'mark'>): string =>
  r.mark === 'entry' ? 'Since entry' : r.mark === 'dayStart' ? 'Last settlement'
    : r.minutes === null ? '—' : r.minutes >= 60 ? `${r.minutes / 60}h` : `${r.minutes}m`;

/** The rows as the screen draws them: the windows, then the marks; bars measured against the largest move of all. */
export function priceMoves(res: { spot: number | null; rows: readonly PriceChange[] } | null): { windows: PriceMove[]; marks: PriceMove[] } {
  const rows = res?.rows ?? [];
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.pts ?? 0)));
  const all = rows.map((r): PriceMove => ({
    key: r.mark ?? `${r.minutes}m`, label: windowLabel(r), mark: r.mark, at: r.at,
    // The price now is the one the move was measured to: then + pts, where both are known.
    from: r.then, to: r.then !== null && r.pts !== null ? r.then + r.pts : res?.spot ?? null,
    pts: r.pts, pct: r.pct,
    way: r.pts === null || Math.round(r.pts) === 0 ? 'flat' : r.pts > 0 ? 'up' : 'down',
    share: r.pts === null || max <= 0 ? 0 : Math.abs(r.pts) / max,
  }));
  return { windows: all.filter((m) => m.mark === null), marks: all.filter((m) => m.mark !== null) };
}

const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '');
/** A BTC price in whole points: "83,774". */
export const points = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));
/** A move in whole points, signed: "−1,217". */
export const signedPoints = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const r = Math.round(n);
  return `${sign(r)}${Math.abs(r).toLocaleString('en-US')}`;
};
/** A move in percent, signed, to two places: "−1.43%". */
export const signedPct = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const r = Number(n.toFixed(2));
  return `${sign(r)}${Math.abs(r).toFixed(2)}%`;
};
