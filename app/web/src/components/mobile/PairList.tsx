import { useState } from 'react';
import { pct } from '@/lib/format';
import type { PairStat } from '@/lib/method-pairs';
import { cn } from '@/lib/utils';
import { Empty, Panel, Pill } from '@/components/mobile/parts';

/**
 * One list of method + timeframe pairs on the phone (owner, 6 Oct 2026): the best, or the worst -- of the closed
 * trades on P&L, or of the signal history under More. A row says which method on which timeframe, what it made
 * (said by the caller: rupees after charges, or perp points), and how: trades, the win rate and the profit factor,
 * with a bar between the won and the lost for their shares. Five to begin with, the rest one tap away.
 */

const FIRST = 5;

export function PairList<T extends PairStat>({ title, tone, pairs, empty, amount, note, ends }: {
  title: string;
  /** Which end of the list this is: it words the count beside the title. */
  tone: 'up' | 'down';
  pairs: readonly T[];
  /** What to say when no pair belongs here. */
  empty: string;
  /** What the pair made, as it should read at the right of its row: "+₹94.87", "+1,240 pts". */
  amount: (p: T) => string;
  /** One more thing to say after the profit factor: "+8.4R". */
  note?: (p: T) => string | null;
  /** What the winners made and the losers gave back, under the two ends of the bar: "+12,480 pts", "−640 pts". */
  ends?: (p: T) => { won: string; lost: string };
}) {
  const [all, setAll] = useState(false);
  const shown = all ? pairs : pairs.slice(0, FIRST);
  return (
    <Panel
      title={title}
      right={pairs.length > 0 ? <span className="text-[11.5px] text-muted-foreground">{pairs.length} {tone === 'up' ? 'in profit' : 'in loss'}</span> : undefined}
    >
      {pairs.length === 0 ? <Empty>{empty}</Empty> : (
        <ol className="m-0 list-none divide-y divide-[var(--line-soft)] p-0" aria-label={title}>
          {shown.map((g, i) => <PairRow key={g.key} rank={i + 1} pair={g} amount={amount(g)} note={note?.(g) ?? null} ends={ends?.(g) ?? null} />)}
        </ol>
      )}
      {pairs.length > FIRST && (
        <button
          type="button" onClick={() => setAll((v) => !v)} aria-expanded={all}
          className="mt-1 min-h-[40px] w-full rounded-md border-0 bg-muted font-[inherit] text-[13px] font-medium text-foreground"
        >
          {all ? `Show the first ${FIRST}` : `Show all ${pairs.length}`}
        </button>
      )}
    </Panel>
  );
}

function PairRow({ rank, pair: g, amount, note, ends }: {
  rank: number; pair: PairStat; amount: string; note: string | null; ends: { won: string; lost: string } | null;
}) {
  const pf = g.profitFactor !== null ? `PF ${g.profitFactor.toFixed(2)}` : g.wins > 0 ? 'no loss' : null;
  const won = g.trades > 0 ? g.wins / g.trades : 0;
  const lost = g.trades > 0 ? g.losses / g.trades : 0;
  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span aria-hidden="true" className="w-4 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">{rank}</span>
          <span className="min-w-0 break-words text-[14px] font-medium leading-snug">{g.name}</span>
        </span>
        <span className={cn('shrink-0 whitespace-nowrap text-[14px] font-semibold tabular-nums', g.net > 0 && 'text-[var(--up)]', g.net < 0 && 'text-[var(--down)]')}>{amount}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-6 text-[12px] text-muted-foreground">
        <Pill tone="accent">{g.tf}</Pill>
        <span className="whitespace-nowrap tabular-nums">
          {g.trades} trade{g.trades === 1 ? '' : 's'} · {pct(g.winRate, 0)} won{pf ? ` · ${pf}` : ''}{note ? ` · ${note}` : ''}
        </span>
      </div>
      {/* Won at one end, lost at the other, the bar between them their shares: what is neither (a trade that made exactly nothing) stays grey. */}
      <div className="mt-1.5 flex items-center gap-2 pl-6 text-[12px] tabular-nums">
        <span className="shrink-0 whitespace-nowrap text-[var(--up)]">{g.wins} won</span>
        <span
          role="img" aria-label={`${g.wins} won, ${g.losses} lost of ${g.trades}`}
          className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--panel-3)]"
        >
          <span className="h-full bg-[var(--up)]" style={{ width: `${won * 100}%` }} />
          <span className="ml-auto h-full bg-[var(--down)]" style={{ width: `${lost * 100}%` }} />
        </span>
        <span className="shrink-0 whitespace-nowrap text-[var(--down)]">{g.losses} lost</span>
      </div>
      {ends && (
        <div className="mt-0.5 flex items-baseline justify-between gap-2 pl-6 text-[12px] font-medium tabular-nums">
          <span className="whitespace-nowrap text-[var(--up)]" aria-label={`won ${ends.won}`}>{ends.won}</span>
          <span className="whitespace-nowrap text-[var(--down)]" aria-label={`lost ${ends.lost}`}>{ends.lost}</span>
        </div>
      )}
    </li>
  );
}
