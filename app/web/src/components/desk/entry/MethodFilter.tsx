import { useMemo, useState } from 'react';
import { ListFilter, Search, X } from 'lucide-react';
import { getEntryMethods, type EntryMethodInfo } from '@/api/entry';
import { usePoll } from '@/hooks/usePoll';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

/**
 * Which methods the signal history shows (owner, 6 Oct 2026): any number of the 81, ticked in a list that can be
 * searched by number or name. None ticked is every method -- the filter is off, not empty.
 *
 * The button says what is chosen without being opened ("All methods", "#5 Order-block retest", "3 methods"), and
 * each chosen method is a chip beside it with its own ×, so one can be dropped without opening the list again.
 */
const GROUPS: { id: EntryMethodInfo['group']; label: string }[] = [
  { id: 'breakout', label: 'Breakout' }, { id: 'pullback', label: 'Pullback' }, { id: 'reversal', label: 'Reversal' }, { id: 'flow', label: 'Flow' },
];
const nameOf = (m: Pick<EntryMethodInfo, 'n' | 'name'>) => `#${m.n} ${m.name}`;
/** Chips shown before the rest fold into "+N more": a row of thirty chips is not a summary. */
const CHIPS = 4;

export function MethodFilter({ value, onChange }: { value: readonly string[]; onChange: (ids: string[]) => void }) {
  // The list changes only with a release: asked once an hour.
  const { data, error } = usePoll(getEntryMethods, 3_600_000);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<EntryMethodInfo['group'] | 'all'>('all');
  const methods = useMemo(() => [...(data?.methods ?? [])].sort((a, b) => a.n - b.n), [data]);
  const chosen = useMemo(() => new Set(value), [value]);
  const picked = methods.filter((m) => chosen.has(m.id));

  const needle = q.trim().toLowerCase().replace(/^#/, '');
  const shown = methods.filter((m) => (group === 'all' || m.group === group)
    && (needle === '' || String(m.n) === needle || m.name.toLowerCase().includes(needle) || m.id.includes(needle)));
  // In the desk's own order whatever order they were ticked in: the same choice is the same request.
  const commit = (ids: Set<string>) => onChange(methods.filter((m) => ids.has(m.id)).map((m) => m.id));
  const toggle = (id: string) => { const next = new Set(chosen); if (next.has(id)) next.delete(id); else next.add(id); commit(next); };
  const allShownOn = shown.length > 0 && shown.every((m) => chosen.has(m.id));

  const label = value.length === 0 ? 'All methods'
    : picked.length === 1 ? nameOf(picked[0]!)
      : `${value.length} methods`;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }}>
        <PopoverTrigger
          aria-label={`Methods: ${label}`}
          className={cn('m-0 inline-flex h-[28px] max-w-full appearance-none items-center gap-1.5 rounded-md border border-solid px-2.5 font-[inherit] text-[11.5px]',
            value.length ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] font-semibold text-[var(--accent)]' : 'border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground')}
        >
          <ListFilter size={13} aria-hidden className="flex-none" />
          <span className="truncate">{label}</span>
        </PopoverTrigger>
        <PopoverContent className="w-[min(21rem,calc(100vw-24px))] p-2.5 text-[12px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by number or name" aria-label="Search methods" autoFocus
              className="m-0 h-9 w-full rounded-md border border-solid border-border bg-transparent pl-7 pr-2 font-[inherit] text-[12.5px] text-foreground outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div role="group" aria-label="method group" className="mt-2 flex flex-wrap gap-1">
            {[{ id: 'all' as const, label: 'All' }, ...GROUPS].map((g) => (
              <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => setGroup(g.id)}
                      className={cn('m-0 appearance-none rounded border border-solid px-2 py-0.5 font-[inherit] text-[11px]',
                        group === g.id ? 'border-[var(--accent)] bg-primary font-semibold text-primary-foreground' : 'border-border bg-transparent text-muted-foreground hover:bg-muted')}>
                {g.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px]">
            <span className="text-muted-foreground" aria-live="polite">{value.length === 0 ? 'None ticked: every method is shown' : `${value.length} of ${methods.length} chosen`}</span>
            <span className="flex gap-2">
              <button type="button" disabled={shown.length === 0}
                      onClick={() => { const next = new Set(chosen); for (const m of shown) { if (allShownOn) next.delete(m.id); else next.add(m.id); } commit(next); }}
                      className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[11.5px] font-semibold text-[var(--accent)] underline disabled:opacity-40">
                {allShownOn ? 'Untick these' : `Tick these ${shown.length}`}
              </button>
              {value.length > 0 && (
                <button type="button" onClick={() => onChange([])}
                        className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[11.5px] font-semibold text-[var(--accent)] underline">
                  Clear
                </button>
              )}
            </span>
          </div>
          <ul aria-label="methods" className="m-0 mt-1.5 max-h-[min(50vh,20rem)] list-none overflow-y-auto rounded-md border border-solid border-border p-0">
            {shown.map((m) => (
              <li key={m.id} className={cn('border-0 border-b border-solid border-border/60 px-2 last:border-b-0', chosen.has(m.id) && 'bg-[var(--accent-soft)]')}>
                <Checkbox
                  className="w-full py-1.5"
                  checked={chosen.has(m.id)} onChange={() => toggle(m.id)} aria-label={nameOf(m)}
                  label={(
                    <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate"><span className="tabular-nums text-muted-foreground">#{m.n}</span> <span className="text-foreground">{m.name}</span></span>
                      {m.orderSide && m.orderSide !== 'BOTH' && (
                        <span className={cn('flex-none text-[10px] font-semibold', m.orderSide === 'BUY' ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{m.orderSide}</span>
                      )}
                    </span>
                  )}
                />
              </li>
            ))}
            {methods.length === 0 && <li className="px-2 py-3 text-center text-muted-foreground">{error ? 'Could not read the methods list.' : 'Reading the methods…'}</li>}
            {methods.length > 0 && shown.length === 0 && <li className="px-2 py-3 text-center text-muted-foreground">No method matches “{q}”.</li>}
          </ul>
        </PopoverContent>
      </Popover>

      {/* What is chosen, each with its own ×: one can go without opening the list. */}
      {picked.slice(0, CHIPS).map((m) => (
        <span key={m.id} className="inline-flex max-w-[12rem] items-center gap-1 rounded-md border border-solid border-[var(--accent-line)] bg-[var(--accent-soft)] py-0.5 pl-2 pr-1 text-[11px] text-foreground">
          <span className="truncate">{nameOf(m)}</span>
          <button type="button" aria-label={`Remove ${nameOf(m)}`} onClick={() => toggle(m.id)}
                  className="m-0 inline-flex h-5 w-5 flex-none appearance-none items-center justify-center rounded border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      {picked.length > CHIPS && (
        <button type="button" onClick={() => setOpen(true)}
                className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[11px] text-muted-foreground underline">
          +{picked.length - CHIPS} more
        </button>
      )}
    </div>
  );
}
