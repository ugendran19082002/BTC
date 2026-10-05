import { cn } from '@/lib/utils';
import { FoldButton, useFold } from '@/components/ui/fold';
import type { MethodRead } from '@/types/entry';
import { usePersisted } from '@/hooks/usePersisted';
import { GROUP_NAME, GateChip, METHOD_VIEWS, NumberBadge, SignalChip, ViewChips, viewReads, type MethodView } from './parts';

/**
 * Every entry method by number -- the twelve first, then the rest (74 since
 * 1 Oct 2026) -- the one place their names are written, so the two panels
 * below can show the number alone. Each row carries the method's signal on
 * both sides and its hard gates both ways ("✓ 7/7", or the gate that refuses
 * it). Signals first; a view keeps a long list usable -- All, only those with
 * a signal, or one group -- and the body scrolls under a fixed header.
 * Choosing a row chooses that method in both panels.
 */
export function MethodLegend({ single, mtf, chosenId, onChoose, embedded = false }: {
  single: readonly MethodRead[];
  mtf: readonly MethodRead[];
  /** The method chosen in the panels, when both sides are on the same one. */
  chosenId: string | null;
  onChoose: (id: string) => void;
  /** Inside the entry setups card: no card of its own, a rule above it instead. */
  embedded?: boolean;
}) {
  const [open, setOpen] = useFold('entry-methods');
  const [view, setView] = usePersisted<MethodView>('entry:legend-view', 'all');
  const all = (mtf.length ? mtf : single).map((m) => ({
    m, n: m.n, group: m.group,
    without: single.find((x) => x.id === m.id) ?? null,
    with: mtf.find((x) => x.id === m.id) ?? null,
  }));
  if (!all.length) return null;
  // A row's signal is its better side's: a TRADE either way puts it first.
  const best = (r: (typeof all)[number]) => (r.without?.state === 'TRADE' || r.with?.state === 'TRADE' ? 'TRADE'
    : r.without?.state === 'WAIT' || r.with?.state === 'WAIT' ? 'WAIT' : 'NO_TRADE') as MethodRead['state'];
  const rows = viewReads(all.map((r) => ({ ...r, state: best(r) })), view);
  const counts = Object.fromEntries(METHOD_VIEWS.map((v) => [v, viewReads(all.map((r) => ({ ...r, state: best(r) })), v).length]));
  return (
    <section aria-label="entry methods" data-folded={!open}
             className={cn('fold-host', embedded ? 'mt-3 border-0 border-t border-solid border-border pt-2.5' : 'h-full rounded-xl border border-border bg-[var(--panel)] p-2.5')}>
      <div className="fold-head mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 flex items-center gap-1 text-[13px] font-bold"><FoldButton open={open} onToggle={() => setOpen(!open)} label="entry methods" className="-ml-1" />Entry methods <span className="font-normal text-muted-foreground">· {all.length}<span className="hidden sm:inline">, the numbers used on both sides below</span></span></h3>
        <ViewChips value={view} onChange={setView} label="methods view" counts={counts} />
      </div>
      <div className="max-h-[60vh] overflow-auto rounded border border-border/60 sm:max-h-[560px]">
        <table className="w-full border-collapse text-[12px]" aria-label="entry methods by number">
          <thead className="sticky top-0 z-10 bg-[var(--panel)] text-left text-[11px] text-muted-foreground">
            <tr>
              <th className="py-1 pl-1.5 pr-2">#</th>
              <th className="pr-2">Method</th>
              <th className="hidden pr-2 md:table-cell">Group</th>
              <th className="hidden pr-2 sm:table-cell">Looks for</th>
              <th className="px-1 text-center">Without<span className="hidden sm:inline"> TF</span></th>
              <th className="px-1 text-center">With<span className="hidden sm:inline"> TF</span></th>
              <th className="hidden px-1 text-center sm:table-cell" title="Hard gates without the timeframe chain: any one refusing is NO TRADE">Gates · without</th>
              <th className="hidden px-1 text-center sm:table-cell" title="Hard gates with the timeframe chain">Gates · with</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, without, with: withTf }) => (
              <tr key={m.id} aria-selected={chosenId === m.id}
                  className={cn('border-t border-border', chosenId === m.id && 'bg-[var(--accent-soft)] shadow-[inset_3px_0_0_var(--accent)]')}>
                <td className="py-1 pl-1.5 pr-2"><NumberBadge read={m} /></td>
                <td className="pr-2">
                  <button type="button" onClick={() => onChoose(m.id)} className="min-h-[28px] text-left font-medium hover:underline">{m.name}</button>
                  {/* On a phone the "looks for" column folds in under the name. */}
                  <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground sm:hidden">{m.summary}</span>
                </td>
                <td className="hidden pr-2 text-muted-foreground md:table-cell">{GROUP_NAME[m.group]}</td>
                <td className="hidden pr-2 text-muted-foreground sm:table-cell">{m.summary}</td>
                <td className="px-1 text-center">
                  {without ? <SignalChip read={without} /> : '–'}
                  {/* On a phone the gates fold in under the signal. */}
                  <span className="mt-0.5 block sm:hidden"><GateChip read={without} /></span>
                </td>
                <td className="px-1 text-center">
                  {withTf ? <SignalChip read={withTf} /> : '–'}
                  <span className="mt-0.5 block sm:hidden"><GateChip read={withTf} /></span>
                </td>
                <td className="hidden px-1 text-center sm:table-cell" aria-label={`${m.name} gates without timeframe`}><GateChip read={without} /></td>
                <td className="hidden px-1 text-center sm:table-cell" aria-label={`${m.name} gates with timeframe`}><GateChip read={withTf} /></td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={8} className="py-3 text-center text-muted-foreground">No method in this view has a signal right now.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
