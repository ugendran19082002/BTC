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

/**
 * Dollars, for money you keep or lose.
 *
 * Three places under a dollar, because a contract is a thousandth of a BTC and
 * these sums are genuinely small: writing $0.0066 as "$0.01" rounds away two
 * thirds of it. Two places from a dollar up, none from a thousand.
 */
export function usd(n: number | null | undefined, dash = '—'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return dash;
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${Math.round(n).toLocaleString()}`;
  if (abs >= 1 || abs === 0) return `$${n.toFixed(2)}`;
  // Something real but smaller than the smallest place shown. Rounded up to
  // that place rather than down to "$0.000", which reads as exactly nothing --
  // a different claim. A "<" would be more precise and reads as clutter on a
  // line of prices, so the rounding carries it instead.
  if (abs < 0.0005) return `${n < 0 ? '-' : ''}$0.001`;
  return `$${n.toFixed(3)}`;
}

/** Signed dollars, where the sign is the point. */
export const signedUsd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`;

/**
 * Rupees. Paise below a hundred, whole rupees above it.
 *
 * Rounding ₹1.37 to "₹1" is the same mistake as writing $0.0066 as "$0.01" --
 * on an account this size the paise are most of the number.
 */
export function inr(n: number | null | undefined, dash = '—'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return dash;
  const abs = Math.abs(n);
  if (abs >= 100 || abs === 0) return `₹${Math.round(n).toLocaleString('en-IN')}`;
  if (abs < 0.005) return `${n < 0 ? '-' : ''}₹0.01`;
  return `₹${n.toFixed(2)}`;
}

/** Signed rupees, where the sign is the point. */
export const signedInr = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${inr(Math.abs(n))}`;

/**
 * The rate the desk converts at.
 *
 * A constant rather than a live rate on purpose: every figure on this desk and
 * in the 733-day record is converted at one number, and a rate that drifted
 * would make yesterday's report disagree with itself.
 */
export const USDINR = 85;

export const usdToInr = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? null : n * USDINR;

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

/**
 * How long something lasted: "42s", "3m 28s", "1h 04m".
 *
 * Different from `countdown` and `ago` on purpose -- this one is a span between
 * two known moments rather than a distance from now, and it is read next to
 * other numbers in a row, so it stays short and never says "ago".
 */
export function duration(ms: number | null | undefined, dash = '—'): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return dash;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Green for a gain, red for a loss, nothing for zero or no number yet. */
export const pnlTone = (n: number | null | undefined): 'up' | 'down' | undefined =>
  n === null || n === undefined || !Number.isFinite(n) || n === 0 ? undefined : n > 0 ? 'up' : 'down';

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
