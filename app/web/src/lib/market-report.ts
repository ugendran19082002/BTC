import { signedInr, usdToInr } from '@/lib/format';
import type { PairStat } from '@/lib/method-pairs';
import type { ExitKey, MarketReportResponse, Row, Tot } from '@/types/market-report';

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

/** One thing worth knowing before reading the rest: what it is, of what, and how much. */
export type Standout = { label: string; text: string; amount: string; tone: 'up' | 'down' };

/**
 * What stands out in a range, for one record (13 Oct 2026, "a report that is useful to me"): the kind of day that
 * made the most and the one that lost the most, the exit that paid and the exit that cost, the best and the worst
 * pair, and the best and the worst day. Only what there is: a range with nothing in loss has no "lost most" line.
 */
export function standoutsOf(r: MarketReportResponse, source: Source): Standout[] {
  const out: Standout[] = [];
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const add = (label: string, text: string, net: number) => out.push({ label, text, amount: netText(source, net), tone: net >= 0 ? 'up' : 'down' });
  const fams = r.families.filter((f) => f[source].n > 0);
  const famBest = [...fams].sort((a, b) => b[source].net - a[source].net)[0];
  const famWorst = [...fams].sort((a, b) => a[source].net - b[source].net)[0];
  if (famBest && famBest[source].net > 0) add('Made most on', `${famBest.name} days · ${days(famBest.days.length)}`, famBest[source].net);
  if (famWorst && famWorst[source].net < 0) add('Lost most on', `${famWorst.name} days · ${days(famWorst.days.length)}`, famWorst[source].net);
  const exits = exitLines(r.total[source]);
  const exitBest = [...exits].sort((a, b) => b.net - a.net)[0];
  const exitWorst = [...exits].sort((a, b) => a.net - b.net)[0];
  if (exitBest && exitBest.net > 0) add('Exit that paid most', `${exitBest.label} · ${exitBest.n.toLocaleString('en-US')} trades`, exitBest.net);
  if (exitWorst && exitWorst.net < 0) add('Exit that cost most', `${exitWorst.label} · ${exitWorst.n.toLocaleString('en-US')} trades`, exitWorst.net);
  const pairBest = r.ends[source].best[0], pairWorst = r.ends[source].worst[0];
  if (pairBest) add('Best pair', `${pairBest.name} · ${pairBest.tf}`, pairBest.net);
  if (pairWorst) add('Worst pair', `${pairWorst.name} · ${pairWorst.tf}`, pairWorst.net);
  const traded = r.days.filter((d) => d[source].n > 0);
  const kind = (key: string | null) => r.catalogue.find((p) => p.key === key)?.name ?? 'not named';
  const dayBest = [...traded].sort((a, b) => b[source].net - a[source].net)[0];
  const dayWorst = [...traded].sort((a, b) => a[source].net - b[source].net)[0];
  if (dayBest && dayBest[source].net > 0) add('Best day', `${dayLabel(dayBest.day)} · ${kind(dayBest.pattern)}`, dayBest[source].net);
  if (dayWorst && dayWorst[source].net < 0) add('Worst day', `${dayLabel(dayWorst.day)} · ${kind(dayWorst.pattern)}`, dayWorst[source].net);
  return out;
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
