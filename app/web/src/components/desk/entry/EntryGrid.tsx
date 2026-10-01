import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { EntryMode, EntryTf, MethodRead } from '@/types/entry';
import { PriceChart } from '@/components/desk/PriceChart';
import type { ChartFeed } from './feed';
import { SignalChip, overlayOf, viewReads } from './parts';

const GRID_MAX = 24;

/**
 * The twelve methods as twelve small charts, one mode at a time: with the
 * timeframe chain (5m, where its entry is read) or without it (on the timeframe
 * chosen for that). Each is the desk's price chart, small -- no readout or
 * toolbar -- and draws its own TRADE's levels. Only built while shown --
 * twelve charts are not free on a phone.
 */
export function EntryGrid({ mode, onMode, reads, singleTf, setupsOn, chart }: {
  mode: EntryMode;
  onMode: (m: EntryMode) => void;
  reads: readonly MethodRead[];
  singleTf: EntryTf;
  setupsOn: boolean;
  chart: (tf: EntryTf) => ChartFeed;
}) {
  const tf = mode === 'mtf' ? '5m' : singleTf;
  // Candles only: the order-flow layers are for the panels' larger charts.
  const { bars, loading } = chart(tf);
  const drawn = useMemo(() => new Map(reads.map((r) => [r.id, overlayOf(r, setupsOn)])), [reads, setupsOn]);
  // Signals first, at most GRID_MAX charts: each is a whole price chart.
  const shown = useMemo(() => viewReads(reads, 'all').slice(0, GRID_MAX), [reads]);
  return (
    <div>
      <div role="group" aria-label="grid mode" className="mb-2 inline-flex overflow-hidden rounded-md border border-border text-[12px]">
        {(['single', 'mtf'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => onMode(m)}
                  className={cn('px-2.5 py-1', mode === m ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
            {m === 'mtf' ? `With timeframe (${reads.length})` : `Without timeframe · ${singleTf} (${reads.length})`}
          </button>
        ))}
      </div>
      {mode === 'single' && !reads.length ? (
        <p role="note" className="m-0 text-[12px] text-muted-foreground">{singleTf} is chart-only: no reads without the chain. Pick 3m or higher above the panels.</p>
      ) : null}
      {reads.length > shown.length ? (
        <p className="m-0 mb-2 text-[11.5px] text-muted-foreground">
          The {shown.length} with a signal first, of {reads.length} methods -- {reads.length} charts at once is too many for a phone. Choose one in the panels to see any other.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((r) => (
          <figure key={`${r.mode}:${r.id}`} className="m-0 rounded-lg border border-border p-2" aria-label={`${r.name} chart`}>
            <figcaption className="mb-1 flex items-center justify-between gap-2 text-[12px]">
              <span><span className="text-muted-foreground">{r.code ?? r.n}</span> {r.name}</span>
              <SignalChip read={r} />
            </figcaption>
            <PriceChart bars={bars} loading={loading} tf={tf} entry={drawn.get(r.id) ?? null} size="compact" label={`${r.name} price chart`} />
            <p className="m-0 mt-1 line-clamp-2 text-[11px] text-muted-foreground">{r.reason}</p>
          </figure>
        ))}
      </div>
    </div>
  );
}
