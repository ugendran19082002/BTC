import type { BacktestParams } from '@/types/signal-backtest';
import type { StrikeBlock } from '@/types/strategy';
import { strikeBlockProblems } from '@/lib/strategy-blocks';
import { backtestHours } from '@/lib/backtest-no-entry';

/**
 * The backtest's strike rule by time of day (owner, 18 Oct 2026: "the strategy form's strike blocks, in the backtest
 * and the portfolio"): the form's own blocks and rules, held to the backtest's hours. The settings' own strike rule is
 * block 1; these are the blocks after it.
 */

/** What is wrong with the blocks for these hours, in the form's words (an empty list: nothing). */
export function backtestBlockProblems(p: Pick<BacktestParams, 'strikeBlocks' | 'window' | 'hoursFrom' | 'hoursTo'>): string[] {
  const h = backtestHours(p);
  return strikeBlockProblems(p.strikeBlocks, h.entryTime, h.exitTime).map((x) => x.message);
}

/** The blocks as asked of the server -- JSON -- or null: none, or not right for the hours (the editor says why). */
export function strikeBlocksQuery(p: Pick<BacktestParams, 'strikeBlocks' | 'window' | 'hoursFrom' | 'hoursTo'>): string | null {
  if (!p.strikeBlocks?.length || backtestBlockProblems(p).length) return null;
  return JSON.stringify(p.strikeBlocks);
}

/** The blocks in a few words: "4 strike blocks (from 1:30 AM)". */
export function strikeBlocksWords(blocks: readonly StrikeBlock[] | undefined): string | null {
  return blocks?.length ? `${blocks.length + 1} strike blocks` : null;
}
