import { useEffect, useId, useState } from 'react';
import { ArrowUpDown, Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * How a list is sorted, on the phone (owner, 22 Nov 2026: "the dropdown looks bad -- best design, mobile friendly"): a
 * face that says the order in force, opening a sheet from the bottom -- the choices in groups, each a thumb's height with
 * a line under it saying what it does, a tick on the one in force. A tap sorts and closes; the backdrop, Esc or ✕ close.
 * In place of the phone's own select, which a desktop browser draws as a bare list.
 */
export type SortChoice<K extends string> = { key: K; label: string; hint?: string; group?: string };

export function SortSheet<K extends string>({ value, choices, onChange, name = 'Sort by', className }: {
  value: K;
  choices: readonly SortChoice<K>[];
  onChange: (k: K) => void;
  /** What the face and the sheet are called, for a screen reader: "Sort positions by". */
  name?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const current = choices.find((c) => c.key === value) ?? choices[0]!;
  useEffect(() => {
    if (!open) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = before; window.removeEventListener('keydown', esc); };
  }, [open]);
  // The choices in their groups, in the order given.
  const groups: { name: string; items: SortChoice<K>[] }[] = [];
  for (const c of choices) {
    const g = c.group ?? '';
    const at = groups.find((x) => x.name === g);
    if (at) at.items.push(c); else groups.push({ name: g, items: [c] });
  }
  return (
    <>
      <button
        type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`${name}: ${current.label}`}
        className={cn('relative flex h-11 min-w-0 shrink items-center gap-2 rounded-lg border border-solid border-border bg-muted pl-2.5 pr-8 text-left font-[inherit]', className)}
      >
        <ArrowUpDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="text-[11px] text-muted-foreground">Sort by</span>
          <span className="truncate text-[13.5px] font-semibold text-foreground">{current.label}</span>
        </span>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center" role="presentation">
          <button type="button" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} className="absolute inset-0 border-0 bg-black/60 p-0" />
          <div role="dialog" aria-modal="true" aria-labelledby={titleId}
            className="relative max-h-[80vh] w-full max-w-[560px] overflow-y-auto rounded-t-2xl border-t border-solid border-x-0 border-b-0 border-border bg-background px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-2">
            <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--line)]" />
            <div className="flex items-center justify-between">
              <h2 id={titleId} className="m-0 text-[17px] font-semibold">{name}</h2>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="-mr-2 grid h-11 w-11 place-items-center rounded-md border-0 bg-transparent text-muted-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div role="radiogroup" aria-labelledby={titleId} className="mt-1 grid gap-3">
              {groups.map((g) => (
                <div key={g.name || 'all'} className="grid gap-1">
                  {g.name && <p className="m-0 px-1 text-[11.5px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">{g.name}</p>}
                  <div className="overflow-hidden rounded-xl border border-solid border-[var(--line-soft)]">
                    {g.items.map((c, i) => {
                      const on = c.key === current.key;
                      return (
                        <button
                          key={c.key} type="button" role="radio" aria-checked={on}
                          onClick={() => { onChange(c.key); setOpen(false); }}
                          className={cn('flex min-h-[52px] w-full items-center gap-3 border-0 px-3 py-2 text-left font-[inherit]',
                            i > 0 && 'border-t border-solid border-x-0 border-b-0 border-[var(--line-soft)]',
                            on ? 'bg-[var(--chosen-soft)]' : 'bg-transparent active:bg-muted')}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className={cn('text-[14.5px] font-medium', on ? 'text-[var(--chosen-text)]' : 'text-foreground')}>{c.label}</span>
                            {c.hint && <span className="text-[12px] text-muted-foreground">{c.hint}</span>}
                          </span>
                          <span aria-hidden="true" className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full', on ? 'bg-[var(--chosen-text)] text-[var(--bg)]' : 'border border-solid border-border')}>
                            {on && <Check className="h-4 w-4" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
