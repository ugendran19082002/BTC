import { useState } from 'react';
import { Check, ChevronDown, ListFilter } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * The phone's strategy filter (owner, 8 Oct 2026: "strategy select option, multiple select dropdown, mobile user
 * friendly -- the same filter on the signal filters"): one button that says what is chosen, opening a list to tick
 * any number of strategies in. None ticked is all of them, which is how it starts.
 *
 * The same control on P&L, where it keeps the trades the chosen strategies placed, and on Signal history pairs,
 * where it keeps the signals they take. The list stays open while it is ticked -- several are meant to be chosen --
 * and closes on Done or a tap outside. Every row is a thumb high. A choice that is no longer in the list (a
 * strategy since deleted) is not counted and not shown.
 */

export type StrategyOption = {
  key: string;
  name: string;
  /** Said under the name: "12 trades · +₹265", "on 15m · 8 methods". */
  note?: string;
  /** Colours the note's figure side: the strategy made money, or lost it. */
  tone?: 'up' | 'down';
};

/** "All strategies", the one name, or "3 of 8 strategies": what the button reads. */
export function pickedWords(options: readonly StrategyOption[], picked: readonly string[]): string {
  const chosen = options.filter((o) => picked.includes(o.key));
  if (chosen.length === 0) return 'All strategies';
  if (chosen.length === 1) return chosen[0]!.name;
  return `${chosen.length} of ${options.length} strategies`;
}

export function StrategyPicker({ options, picked, onChange }: {
  options: readonly StrategyOption[];
  /** The keys chosen; empty is every strategy. */
  picked: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  if (options.length === 0) return null;
  const chosen = options.filter((o) => picked.includes(o.key)).map((o) => o.key);
  const words = pickedWords(options, picked);
  const toggle = (key: string) => onChange(chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`Strategy filter: ${words}`}
          className={cn(
            'm-0 flex h-11 w-full appearance-none items-center gap-2 rounded-lg border border-solid bg-muted px-3 text-left font-[inherit]',
            chosen.length ? 'border-[var(--up)]' : 'border-border',
          )}
        >
          <ListFilter className={cn('h-4 w-4 shrink-0', chosen.length ? 'text-[var(--up)]' : 'text-muted-foreground')} aria-hidden />
          <span className="shrink-0 text-[12.5px] text-muted-foreground">Strategy</span>
          <span className={cn('min-w-0 flex-1 truncate text-[14px] font-semibold', chosen.length ? 'text-[var(--up)]' : 'text-foreground')}>{words}</span>
          <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="flex max-h-[min(60vh,440px)] w-[var(--radix-popover-trigger-width)] min-w-[260px] flex-col p-0">
        <ul role="listbox" aria-multiselectable="true" aria-label="Strategies" className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
          <Row on={chosen.length === 0} name="All strategies" note={`${options.length} in this list`} onClick={() => onChange([])} />
          {options.map((o) => (
            <Row key={o.key} on={chosen.includes(o.key)} name={o.name} note={o.note} tone={o.tone} onClick={() => toggle(o.key)} />
          ))}
        </ul>
        <div className="flex shrink-0 items-center gap-2 border-0 border-t border-solid border-[var(--line-soft)] p-2">
          <button
            type="button" disabled={chosen.length === 0} onClick={() => onChange([])}
            className="m-0 h-10 flex-1 appearance-none rounded-md border border-solid border-border bg-transparent font-[inherit] text-[13.5px] font-medium text-foreground disabled:opacity-40"
          >
            Clear
          </button>
          <button
            type="button" onClick={() => setOpen(false)}
            className="m-0 h-10 flex-1 appearance-none rounded-md border-0 bg-[var(--up)] font-[inherit] text-[13.5px] font-semibold text-[var(--bg)]"
          >
            Done
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Row({ on, name, note, tone, onClick }: { on: boolean; name: string; note?: string; tone?: 'up' | 'down'; onClick: () => void }) {
  return (
    <li role="option" aria-selected={on} className="m-0 p-0">
      <button
        type="button" onClick={onClick} tabIndex={0}
        className={cn(
          'm-0 flex min-h-[44px] w-full appearance-none items-center gap-2.5 rounded-md border-0 px-2 py-1.5 text-left font-[inherit]',
          on ? 'bg-[var(--up-bg)]' : 'bg-transparent',
        )}
      >
        <span
          aria-hidden
          className={cn('grid h-5 w-5 shrink-0 place-items-center rounded border border-solid', on ? 'border-[var(--up)] bg-[var(--up)] text-[var(--bg)]' : 'border-border bg-transparent')}
        >
          {on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-foreground">{name}</span>
          {note && (
            <span className={cn('block truncate text-[12px] tabular-nums', tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-muted-foreground')}>{note}</span>
          )}
        </span>
      </button>
    </li>
  );
}
