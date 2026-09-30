import { cn } from '@/lib/utils';
import type { EntryMode, EntryTf, MethodRead } from '@/types/entry';
import { EntryChart, useEntryCandles } from './EntryChart';
import { SignalChip } from './parts';

/**
 * The twelve methods as twelve small charts, one mode at a time: with the
 * timeframe chain (5m, where its entry is read) or without it (on the timeframe
 * chosen for that). Each draws its own TRADE's levels. Only built while shown
 * -- twelve charts are not free on a phone.
 */
export function EntryGrid({ mode, onMode, reads, singleTf, setupsOn }: {
  mode: EntryMode;
  onMode: (m: EntryMode) => void;
  reads: readonly MethodRead[];
  singleTf: EntryTf;
  setupsOn: boolean;
}) {
  const bars = useEntryCandles(mode === 'mtf' ? '5m' : singleTf, 120);
  return (
    <div>
      <div role="group" aria-label="grid mode" className="mb-2 inline-flex overflow-hidden rounded-md border border-border text-[12px]">
        {(['single', 'mtf'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => onMode(m)}
                  className={cn('px-2.5 py-1', mode === m ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
            {m === 'mtf' ? 'With timeframe (12)' : `Without timeframe · ${singleTf} (12)`}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {reads.map((r) => (
          <figure key={`${r.mode}:${r.id}`} className="m-0 rounded-lg border border-border p-2" aria-label={`${r.name} chart`}>
            <figcaption className="mb-1 flex items-center justify-between gap-2 text-[12px]">
              <span><span className="text-muted-foreground">{r.n}</span> {r.name}</span>
              <SignalChip read={r} />
            </figcaption>
            <EntryChart bars={bars} plan={setupsOn ? r.plan : null} dir={r.dir} height={170} label={`${r.name} price chart`} />
            <p className="m-0 mt-1 line-clamp-2 text-[11px] text-muted-foreground">{r.reason}</p>
          </figure>
        ))}
      </div>
    </div>
  );
}
