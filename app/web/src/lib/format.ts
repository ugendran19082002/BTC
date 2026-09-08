/**
 * How numbers are written on this desk.
 *
 * One module, because a price that reads 100.5 in one card and 100.50 in the
 * next looks like two different prices. Every formatter here answers "what
 * does a person do with this number" rather than "how many decimals does it
 * happen to have".
 */

/** A price the exchange quotes. Always two places, so a column lines up. */
export const price = (n: number | null | undefined, dash = '—') =>
  n === null || n === undefined || !Number.isFinite(n) ? dash : n.toFixed(2);

/** Dollars, for money you keep or lose. */
export const usd = (n: number | null | undefined, dash = '—') =>
  n === null || n === undefined || !Number.isFinite(n)
    ? dash
    : `$${Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2)}`;

/** Signed dollars, where the sign is the point. */
export const signedUsd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`;

export const inr = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`;

export const pct = (fraction: number | null | undefined, places = 1) =>
  fraction === null || fraction === undefined || !Number.isFinite(fraction)
    ? '—'
    : `${(fraction * 100).toFixed(places)}%`;

export const strike = (n: number) => n.toLocaleString('en-US');

/** Contracts. Whole numbers, grouped once they get long. */
export const size = (n: number) => Math.abs(n).toLocaleString('en-US');

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
});
const IST_FULL = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/** 14:32 — the desk runs on IST and never says which, because it never varies. */
export const clock = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '—' : IST.format(new Date(ms));

export const stamp = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '—' : IST_FULL.format(new Date(ms));

/** "4h 12m left", or "settled". */
export function countdown(untilMs: number, now = Date.now()): string {
  const left = untilMs - now;
  if (left <= 0) return 'settled';
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  if (h === 0) {
    const s = Math.floor((left % 60_000) / 1000);
    return m === 0 ? `${s}s left` : `${m}m ${s}s left`;
  }
  return `${h}h ${m}m left`;
}

/** "just now", "8s ago", "3m ago" — for a feed that is meant to be moving. */
export function ago(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 2_000) return 'just now';
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

/** The direction a number should be coloured, or none. */
export const tone = (n: number | null | undefined): 'up' | 'down' | 'flat' =>
  n === null || n === undefined || n === 0 ? 'flat' : n > 0 ? 'up' : 'down';

/** C-BTC-80000-080926 → "80,000 CE". What a trader would say out loud. */
export function contractLabel(symbol: string): string {
  const parts = symbol.split('-');
  const k = Number(parts[2]);
  const side = symbol.startsWith('P') ? 'PE' : 'CE';
  return Number.isFinite(k) ? `${strike(k)} ${side}` : symbol;
}
