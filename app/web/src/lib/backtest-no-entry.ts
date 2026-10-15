import type { BacktestParams } from '@/types/signal-backtest';
import { noEntryProblems } from '@/lib/strategy-no-entry';

/**
 * The backtest's no-entry windows (owner, 15 Oct 2026: "no-entry window in the backtest's settings, as the strategy
 * form has"): the form's own rules, held to the backtest's hours rather than a strategy's.
 */

/** The hours the windows are held to: the desk's 9:30 PM to 3:59 PM, the whole expiry day, or the hours chosen. */
export function backtestHours(p: Pick<BacktestParams, 'window' | 'hoursFrom' | 'hoursTo'>): { entryTime: string; exitTime: string } {
  if (p.window === 'desk') return { entryTime: '21:30', exitTime: '15:59' };
  if (p.window === 'custom' && p.hoursFrom && p.hoursTo) return { entryTime: p.hoursFrom, exitTime: p.hoursTo };
  return { entryTime: '17:30', exitTime: '17:25' };
}

/** What is wrong with the windows for these hours, in the form's words (an empty list: nothing). */
export function backtestNoEntryProblems(p: BacktestParams): string[] {
  const h = backtestHours(p);
  return noEntryProblems(p.noEntry, h.entryTime, h.exitTime).map((x) => x.replace("this strategy's", 'the hours\'').replace('Switch the strategy off instead.', 'Take the window off instead.'));
}

/** The windows as asked of the server -- `00:30-01:30,03:00-04:00` -- or null: off, none, or not right for the hours. */
export function noEntryQuery(p: BacktestParams): string | null {
  if (!p.noEntry?.on || !p.noEntry.windows.length || backtestNoEntryProblems(p).length) return null;
  return p.noEntry.windows.map((w) => `${w.from}-${w.to}`).join(',');
}
