import { json } from '@/api/client';
import { withAccount } from '@/lib/account-scope';
import type { OptionReplay, ReplayList, ReplayRules, ReplaySource } from '@/types/option-replay';

/** What the option history asks: expiry days, the hours entered (null: all), timeframes (empty: all) and the rules. */
export type OptionReplayQuery = {
  from: string; to: string;
  hours: { from: string; to: string } | null;
  tfs: readonly string[];
  rules: ReplayRules;
  /** Every trade as one contract, so a day of big lots does not outweigh the rest; false, at the size traded. */
  oneContract: boolean;
  /** The desk's real orders, or every signal of the signal history. */
  source: ReplaySource;
  /** The page of trades to hold. */
  list: ReplayList;
};

/** The query string, in a fixed order -- so the same question is the same URL, and the screen's poll can tell. */
export function optionReplayUrl(q: OptionReplayQuery): string {
  const p = new URLSearchParams({ from: q.from, to: q.to });
  if (q.hours) { p.set('fromTime', q.hours.from); p.set('toTime', q.hours.to); }
  if (q.tfs.length) p.set('tf', q.tfs.join(','));
  p.set('skipPerpSl', q.rules.skipPerpSl ? '1' : '0');
  p.set('skipPerpTgt', q.rules.skipPerpTgt ? '1' : '0');
  // Per cents on the wire, as the form shows them: 250 and 90, not 2.5 and 0.9.
  p.set('sl', String(Math.round(q.rules.stopPct * 10_000) / 100));
  p.set('tgt', String(Math.round(q.rules.targetPct * 10_000) / 100));
  if (q.oneContract) p.set('size', 'one');
  if (q.source === 'signals') p.set('source', 'signals');
  if (q.list.day) p.set('day', q.list.day);
  if (q.list.show !== 'all') p.set('show', q.list.show);
  if (q.list.offset > 0) p.set('offset', String(q.list.offset));
  p.set('limit', String(q.list.limit));
  return withAccount(`/api/report/option-replay?${p.toString()}`);
}

/** Every trade the list's filter holds, as a spreadsheet the server writes: a link, so the browser saves it with its own name. */
export const optionReplayCsvUrl = (q: OptionReplayQuery) => optionReplayUrl(q).replace('/api/report/option-replay?', '/api/report/option-replay.csv?');

/** Read-only: the trades and the replay, for the account shown (all of them with none). */
export const getOptionReplay = (q: OptionReplayQuery) => json<OptionReplay>(optionReplayUrl(q));
