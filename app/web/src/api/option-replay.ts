import { json } from '@/api/client';
import { withAccount } from '@/lib/account-scope';
import type { OptionReplay, ReplayRules } from '@/types/option-replay';

/** What the option history asks: expiry days, the hours entered (null: all), timeframes (empty: all) and the rules. */
export type OptionReplayQuery = {
  from: string; to: string;
  hours: { from: string; to: string } | null;
  tfs: readonly string[];
  rules: ReplayRules;
  /** Every trade as one contract, so a day of big lots does not outweigh the rest; false, at the size traded. */
  oneContract: boolean;
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
  return withAccount(`/api/report/option-replay?${p.toString()}`);
}

/** Read-only: the trades and the replay, for the account shown (all of them with none). */
export const getOptionReplay = (q: OptionReplayQuery) => json<OptionReplay>(optionReplayUrl(q));
