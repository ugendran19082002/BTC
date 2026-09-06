import * as React from 'react';
import { cn } from '../../lib/utils';

type Tone = 'plain' | 'up' | 'down' | 'warn' | 'dim';

const TONE: Record<Tone, string> = {
  plain: '',
  up: 'text-[var(--up)]',
  down: 'text-[var(--down)]',
  warn: 'text-[var(--warn)]',
  dim: 'text-[var(--dim)]',
};

/**
 * One label-and-number row. Everything on this desk is one of these, so they
 * share a component rather than a copied div — it keeps the columns aligned and
 * the type sizes honest across every card.
 */
export function Stat({
  label,
  value,
  tone = 'plain',
  hint,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={hint}>
      <span className="min-w-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className={cn('flex-none font-mono text-[12.5px]', TONE[tone])}>{value}</span>
    </div>
  );
}

/** A visual break between groups of stats inside one card. */
export function StatDivider() {
  return <div className="my-2 border-t border-border" />;
}
