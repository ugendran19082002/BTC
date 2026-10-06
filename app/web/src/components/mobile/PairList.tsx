import { useState } from 'react';
import { pct } from '@/lib/format';
import type { Pair } from '@/lib/method-pairs';
import { Empty, Panel, Pill, Rupees } from '@/components/mobile/parts';

/**
 * One list of method + timeframe pairs on the phone's P&L screen (owner, 6 Oct 2026): the best, or the worst.
 * A row says which method on which timeframe, what it made after charges, and how: trades, won and lost, the win
 * rate and the profit factor, with a bar between the won and the lost for their shares. Five to begin with, the rest one tap away.
 */

const FIRST = 5;

export function PairList({ title, tone, pairs, empty }: {
  title: string;
  /** Which end of the list this is: it colours the count beside the title. */
  tone: 'up' | 'down';
  pairs: readonly Pair[];
  /** What to say when no pair belongs here. */
  empty: string;
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
          {shown.map((g, i) => <PairRow key={g.key} rank={i + 1} pair={g} />)}
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

function PairRow({ rank, pair: g }: { rank: number; pair: Pair }) {
  const pf = g.profitFactor !== null ? `PF ${g.profitFactor.toFixed(2)}` : g.wins > 0 ? 'no loss' : null;
  const won = g.trades > 0 ? g.wins / g.trades : 0;
  const lost = g.trades > 0 ? g.losses / g.trades : 0;
  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span aria-hidden="true" className="w-4 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">{rank}</span>
          <span className="min-w-0 break-words text-[14px] font-medium leading-snug">{g.name ?? g.key}</span>
        </span>
        <span className="shrink-0"><Rupees usd={g.netUsd} signed size="sm" /></span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-6 text-[12px] text-muted-foreground">
        <Pill tone="accent">{g.tf}</Pill>
        <span className="whitespace-nowrap tabular-nums">
          {g.trades} trade{g.trades === 1 ? '' : 's'} · {pct(g.winRate, 0)} won{pf ? ` · ${pf}` : ''}
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
    </li>
  );
}
