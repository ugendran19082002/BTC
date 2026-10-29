import { signedInr, usdToInr } from '@/lib/format';
import type { PairStat } from '@/lib/method-pairs';
import type { ExitKey, Row, Tot } from '@/types/market-report';

/**
 * The market report's words and sums (13 Oct 2026): an expiry day's date, a record's net in its own unit --
 * perp points for the signal history, rupees for real orders -- and the exits in the order they are read.
 */

export type Source = 'signal' | 'real';

/** The first expiry day the report offers. */
export const FIRST_DAY = '2026-10-01';

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
/** The expiry day a moment belongs to: the daily option settles at 5:30 PM IST, and that minute opens the next day. */
export const expiryDayOf = (ms: number): string => new Date(ms + IST_MS + 6.5 * 3_600_000).toISOString().slice(0, 10);
export const shiftDay = (day: string, by: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);

export type RangeKey = 'all' | '7' | '30';
/** The expiry days a range covers, ending on the day in progress. */
export function rangeOf(key: RangeKey, now: number): { from: string; to: string } {
  const to = expiryDayOf(now);
  return { from: key === 'all' ? FIRST_DAY : shiftDay(to, key === '7' ? -6 : -29), to };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Tue 13 Oct": an expiry day as a date. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
/** "9:45 PM": a moment of the day, IST. */
export function timeIst(ms: number): string {
  const d = new Date(ms + IST_MS);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * A window of each expiry day, IST `HH:MM`, both ends included (owner, 29 Oct 2026: "from time to time, 5:31 PM to
 * 5:29 PM, one contract by default, changeable"): only the trades entered in it are counted.
 */
export type TimeWindow = { from: string; to: string };
/** One contract, open to settlement: what the window is until it is changed. */
export const WHOLE_CONTRACT: TimeWindow = { from: '17:31', to: '17:29' };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** "17:31" as a minute of the expiry day: 0 is 5:30 PM IST, 1439 is 5:29 PM -- the server's own reading (`windowOf`). */
export const contractMinute = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return (h * 60 + m - (17 * 60 + 30) + 1_440) % 1_440;
};
export const isWholeContract = (w: TimeWindow): boolean => w.from === WHOLE_CONTRACT.from && w.to === WHOLE_CONTRACT.to;
/** What is wrong with a window, in the words the server uses; null when it can be asked for. */
export function windowProblem(w: TimeWindow): string | null {
  if (!HHMM.test(w.from) || !HHMM.test(w.to)) return 'Give both times.';
  if (contractMinute(w.from) > contractMinute(w.to)) return 'The end comes before the start in the contract\'s day (5:30 PM to 5:30 PM).';
  return null;
}
/** "5:31 PM": a window's end as it is said. */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
/** "7:00 AM → 11:00 AM", or "Whole contract". */
export const windowLabel = (w: TimeWindow): string => (isWholeContract(w) ? 'Whole contract' : `${clock12(w.from)} → ${clock12(w.to)}`);

const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '');
/** A whole number of points with thousands: "1,240". */
export const num = (n: number): string => Math.round(Math.abs(n)).toLocaleString('en-US');
/** Signed perp points: "+1,240 pts". */
export const ptsText = (n: number): string => `${sign(Math.round(n))}${num(n)} pts`;
/** Signed rupees from dollars: "+₹94.87". */
export const moneyText = (usd: number): string => signedInr(usdToInr(usd));
/** A record's net in its own unit. */
export const netText = (source: Source, net: number): string => (source === 'signal' ? ptsText(net) : moneyText(net));
/** Wins over closed trades, 0-1; null with none closed. */
export const winRate = (t: Pick<Tot, 'n' | 'wins'>): number | null => (t.n > 0 ? t.wins / t.n : null);
export const toneOf = (n: number): 'up' | 'down' | undefined => (n > 0 ? 'up' : n < 0 ? 'down' : undefined);

export const EXIT_ORDER: readonly ExitKey[] = ['perp-tgt', 'perp-sl', 'option-tgt', 'option-sl', 'timeout', 'window-end', 'manual'];
export const EXIT_LABEL: Record<ExitKey, string> = {
  'perp-tgt': 'Perp TGT', 'perp-sl': 'Perp SL', 'option-tgt': 'Option TGT', 'option-sl': 'Option SL',
  timeout: 'Timed out', 'window-end': 'Window end', manual: 'By hand',
};

export type ExitLine = { key: ExitKey; label: string; n: number; net: number; share: number };
/** The exits that closed anything, in the reading order: how many trades each closed, its share of them, and what they made. */
export function exitLines(tot: Tot): ExitLine[] {
  return EXIT_ORDER.flatMap((key) => {
    const x = tot.exits[key];
    return x && x.n > 0 ? [{ key, label: EXIT_LABEL[key], n: x.n, net: x.net, share: tot.n > 0 ? x.n / tot.n : 0 }] : [];
  });
}

/** A report row as the pair lists read one. */
export const pairOf = (r: Row): PairStat => ({
  key: r.key, name: r.name, tf: r.tf ?? '', trades: r.n, wins: r.wins, losses: r.losses,
  winRate: winRate(r), profitFactor: r.lost > 0 ? r.won / r.lost : null, net: r.net,
});

/** A day's half-hour closes as an SVG path in a `w` by `h` box, with where its high and its low fall. */
export function sparkOf(line: readonly number[], w: number, h: number, pad = 3): { d: string; hi: [number, number]; lo: [number, number] } | null {
  if (line.length < 2) return null;
  const min = Math.min(...line), max = Math.max(...line);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (line.length - 1)) * (w - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - 2 * pad);
  const iHi = line.indexOf(max), iLo = line.indexOf(min);
  return {
    d: line.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''),
    hi: [x(iHi), y(max)], lo: [x(iLo), y(min)],
  };
}
