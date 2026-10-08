import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * The phone's tick-several filter (owner, 8 Oct 2026: "strategy select option, multiple select dropdown, mobile
 * user friendly -- the same filter on the signal filters", then "same UI, add a methods filter"): one button that
 * says what is chosen, opening a list to tick any number in. None ticked is all of them, which is how it starts.
 *
 * One control for strategies, for entry methods and for timeframes (the timeframe chain among them), on P&L -- where it keeps the trades of what is chosen -- and on
 * Signal history pairs, where it keeps the signals. The list stays open while it is ticked -- several are meant to
 * be chosen -- and closes on Done or a tap outside. Every row is a thumb high. A long list (the desk has 81
 * methods) gets a box to search it by. A choice that is no longer in the list is not counted and not shown.
 *
 * The button is a chip, and the chips sit in one row (`FilterBar`; owner, 8 Oct 2026: "many filters take the
 * space"): three of them stacked full width were a third of a phone's screen before any figure. A chip says its
 * kind until something is chosen in it, then the one name chosen, or its kind and how many, and turns green while
 * it filters. Three with nothing chosen fit a 360px phone side by side (measured: 324 of 328px); with long names
 * chosen the row scrolls sideways. While anything is chosen the row starts with a cross that takes every choice
 * off -- at the start, so it is on the screen however far the row runs.
 */

export type FilterOption = {
  key: string;
  name: string;
  /** Said under the name: "12 trades · +₹265", "on 15m · 8 methods". */
  note?: string;
  /** Colours the note: it made money, or lost it. */
  tone?: 'up' | 'down';
};

/** What is being chosen, as the button and the list name it: `{ label: 'Strategy', many: 'strategies' }`. */
export type FilterNoun = { label: string; many: string };
export const STRATEGIES: FilterNoun = { label: 'Strategy', many: 'strategies' };
export const METHODS: FilterNoun = { label: 'Method', many: 'methods' };
export const TIMEFRAMES: FilterNoun = { label: 'Time frame', many: 'time frames' };

/** A list longer than this gets a search box: past it, the one wanted is a scroll away. */
const SEARCH_FROM = 9;

/** "All strategies", the one name, or "3 of 8 strategies": what the button reads. */
export function pickedWords(options: readonly FilterOption[], picked: readonly string[], noun: FilterNoun = STRATEGIES): string {
  const chosen = options.filter((o) => picked.includes(o.key));
  if (chosen.length === 0) return `All ${noun.many}`;
  if (chosen.length === 1) return chosen[0]!.name;
  return `${chosen.length} of ${options.length} ${noun.many}`;
}

/** The filters' one row: the chips side by side, scrolling sideways where they do not fit, with a way to take every choice off at once. */
export function FilterBar({ children, onClear }: {
  children: ReactNode;
  /** Takes every filter's choice off; absent or null while nothing is chosen, and then the button is not shown. */
  onClear?: (() => void) | null;
}) {
  return (
    // Bleeds to the screen's edges like the other chip rows, so a chip cut off at the edge says there is more to the side.
    <div role="group" aria-label="Filters" className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1">
      {onClear && (
        <button
          type="button" onClick={onClear} aria-label="Clear all" title="Clear all filters"
          className="m-0 grid h-10 w-10 shrink-0 appearance-none place-items-center rounded-full border border-solid border-border bg-transparent p-0 text-muted-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
      {children}
    </div>
  );
}

export function FilterPicker({ noun, options, picked, onChange }: {
  noun: FilterNoun;
  options: readonly FilterOption[];
  /** The keys chosen; empty is every one. */
  picked: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  if (options.length === 0) return null;
  const chosen = options.filter((o) => picked.includes(o.key)).map((o) => o.key);
  const words = pickedWords(options, picked, noun);
  const on = chosen.length > 0;
  const toggle = (key: string) => onChange(chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]);
  const searchable = options.length >= SEARCH_FROM;
  const wanted = find.trim().toLowerCase();
  const shown = searchable && wanted ? options.filter((o) => o.name.toLowerCase().includes(wanted)) : options;
  const listName = noun.many[0]!.toUpperCase() + noun.many.slice(1);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setFind(''); }}>
      <PopoverTrigger asChild>
        <button
          type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${noun.label} filter: ${words}`}
          className={cn(
            'm-0 inline-flex h-10 max-w-[12rem] shrink-0 appearance-none items-center gap-1 whitespace-nowrap rounded-full border border-solid px-2.5 text-left font-[inherit] text-[13.5px] font-medium',
            on ? 'border-[var(--up)] bg-[var(--up-bg)] text-[var(--up)]' : 'border-border bg-transparent text-foreground',
          )}
        >
          {/* One chosen: its name alone, cut where it runs long -- the name says the kind. Otherwise the kind, and how many where several. */}
          {chosen.length === 1
            ? <span className="min-w-0 truncate font-semibold">{words}</span>
            : <span className="shrink-0">{noun.label}</span>}
          {chosen.length > 1 && (
            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[var(--up)] px-1 text-[11.5px] font-bold tabular-nums text-[var(--bg)]">{chosen.length}</span>
          )}
          <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', on ? 'text-[var(--up)]' : 'text-muted-foreground', open && 'rotate-180')} aria-hidden />
        </button>
      </PopoverTrigger>
      {/* As wide as a phone allows, whatever the chip's own width; kept clear of the screen's edges wherever the chip sits in the row. */}
      <PopoverContent align="start" sideOffset={4} collisionPadding={16} className="flex max-h-[min(60vh,440px)] w-[min(calc(100vw-32px),360px)] flex-col p-0">
        {searchable && (
          <div className="relative shrink-0 border-0 border-b border-solid border-[var(--line-soft)] p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              value={find} onChange={(e) => setFind(e.target.value)} aria-label={`Search ${noun.many}`} placeholder={`Search ${options.length} ${noun.many}`}
              inputMode="search" autoComplete="off"
              // 16px: a smaller font makes iOS zoom the whole page when the box is tapped.
              className="m-0 h-10 w-full appearance-none rounded-md border border-solid border-border bg-background pl-8 pr-2 font-[inherit] text-[16px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}
        <ul role="listbox" aria-multiselectable="true" aria-label={listName} className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
          {!wanted && <Row on={chosen.length === 0} name={`All ${noun.many}`} note={`${options.length} in this list`} onClick={() => onChange([])} />}
          {shown.map((o) => (
            <Row key={o.key} on={chosen.includes(o.key)} name={o.name} note={o.note} tone={o.tone} onClick={() => toggle(o.key)} />
          ))}
          {shown.length === 0 && <li className="m-0 px-2 py-3 text-[13px] text-muted-foreground">No {noun.label.toLowerCase()} named “{find.trim()}”.</li>}
        </ul>
        <div className="flex shrink-0 items-center gap-2 border-0 border-t border-solid border-[var(--line-soft)] p-2">
          <button
            type="button" disabled={chosen.length === 0} onClick={() => onChange([])}
            className="m-0 h-10 flex-1 appearance-none rounded-md border border-solid border-border bg-transparent font-[inherit] text-[13.5px] font-medium text-foreground disabled:opacity-40"
          >
            Clear
          </button>
          <button
            type="button" onClick={() => { setOpen(false); setFind(''); }}
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
