import { useRef, type ReactNode } from 'react';
import { StrikeBlocksEditor } from '@/components/strategy/StrikeBlocksEditor';
import type { SetField } from '@/components/strategy/form-parts';
import type { StrategyConfig, StrikeBlock } from '@/types/strategy';

/**
 * The strategy form's "Different strike rule by time of day", for the backtest and a run together (18 Oct 2026): the
 * form's own editor, over the hours given, with block 1 the rule set elsewhere -- the backtest's strike above, or each
 * saved backtest's own in a run. Only the blocks after it are edited here.
 *
 * The editor sets a strategy's fields one at a time; "Apply to all blocks" sets several at once (the rule, its
 * number, the blocks). They are gathered and handed on as one change, so none is lost to another.
 */
export function BacktestStrikeBlocks({ hours, rule, blocks, onChange, firstWords, holdsFirst = true }: {
  hours: { entryTime: string; exitTime: string };
  /** Block 1's rule, where it is known: the backtest's own strike. Null in a run, where each member has its own. */
  rule: { rule: 'delta' | 'premium'; value: number } | null;
  blocks: StrikeBlock[] | undefined;
  onChange: (next: { strikeBlocks: StrikeBlock[]; rule?: { rule: 'delta' | 'premium'; value: number } }) => void;
  /** Block 1, in words. */
  firstWords: ReactNode;
  /** Whether "Apply to all blocks" may write block 1 (the backtest's own rule holds a delta or an "at most" premium). */
  holdsFirst?: boolean;
}) {
  const c = {
    ...hours,
    strikeRule: rule?.rule ?? 'delta', strikeStep: 0,
    premium: { mode: 'atMost', usd: rule?.rule === 'premium' ? rule.value : 50, fallbackUsd: null },
    delta: { max: rule?.rule === 'delta' ? rule.value : 0.1 }, distance: null,
    strikeBlocks: blocks ?? [],
  } as unknown as StrategyConfig;
  const pending = useRef<Partial<StrategyConfig> | null>(null);
  const set = ((k: keyof StrategyConfig, v: unknown) => {
    if (!pending.current) {
      pending.current = {};
      queueMicrotask(() => {
        const p = pending.current ?? {};
        pending.current = null;
        const strikeBlocks = (p.strikeBlocks ?? blocks ?? []) as StrikeBlock[];
        // Block 1 written by "Apply to all blocks": a delta, or a premium "at most" -- what the backtest's rule holds.
        const first = p.strikeRule === 'delta' && p.delta ? { rule: 'delta' as const, value: p.delta.max }
          : p.strikeRule === 'premium' && p.premium?.mode === 'atMost' ? { rule: 'premium' as const, value: p.premium.usd }
            : undefined;
        onChange({ strikeBlocks, ...(first && rule ? { rule: first } : {}) });
      });
    }
    (pending.current as Record<string, unknown>)[k] = v;
  }) as SetField;
  return (
    <StrikeBlocksEditor c={c} set={set} err={() => null}
      first={{
        words: firstWords,
        copyable: rule !== null,
        holds: (r) => holdsFirst && rule !== null && (r.strikeRule === 'delta' || (r.strikeRule === 'premium' && r.premium.mode === 'atMost' && r.premium.fallbackUsd == null && r.premium.minOtm == null)),
      }} />
  );
}
