import { useId, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { asPct, WIN_AT_LEAST_PCT, wonAtLeast } from '@/lib/win-line';

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
  /** More words the search box finds it by, beside its name: a strategy's account (13 Oct 2026, "filter by typing the account name"). */
  also?: string;
  /** What it made, in any unit: the In profit and In loss tabs are sorted by it (`split`). */
  value?: number;
  /** The share of its trades won, 0 to 1; absent with no trade. The Win tab keeps those at or over its line (`split`). */
  winRate?: number;
  /** How many trades its record is of: what "Most trades" sorts by. */
  trades?: number;
};

/**
 * How the list is ordered (15 Oct 2026, owner: "a sort row -- P&L low, P&L high, most trades, fewest trades, high
 * win"). `default` is the list's own order -- the methods by number -- and the profit and loss tabs' own.
 */
export type FilterSort = 'default' | 'pnl-high' | 'pnl-low' | 'trades-high' | 'trades-low' | 'win-high';
export const FILTER_SORTS: { key: FilterSort; label: string }[] = [
  { key: 'default', label: 'Default' }, { key: 'pnl-high', label: 'P&L high' }, { key: 'pnl-low', label: 'P&L low' },
  { key: 'trades-high', label: 'Most trades' }, { key: 'trades-low', label: 'Fewest trades' }, { key: 'win-high', label: 'Win % high' },
];
/** Options in a sort's order; those with nothing to sort by (no trade) last, in their own order. */
export function sortOptions<T extends Pick<FilterOption, 'value' | 'trades' | 'winRate'>>(xs: readonly T[], sort: FilterSort): T[] {
  if (sort === 'default') return [...xs];
  const by = (o: T): number | undefined => (sort === 'pnl-high' || sort === 'pnl-low' ? o.value : sort === 'win-high' ? o.winRate : o.trades);
  const dir = sort === 'pnl-low' || sort === 'trades-low' ? 1 : -1;
  return xs.map((o, i) => ({ o, i })).sort((a, b) => {
    const x = by(a.o), y = by(b.o);
    if (x === undefined || y === undefined) return (x === undefined ? 1 : 0) - (y === undefined ? 1 : 0) || a.i - b.i;
    // between equals the one with more behind it: more trades, then more money
    return dir * (x - y) || (b.o.trades ?? 0) - (a.o.trades ?? 0) || (b.o.value ?? 0) - (a.o.value ?? 0) || a.i - b.i;
  }).map((x) => x.o);
}

/**
 * The sort row: the picker's own, the day sheet's and the strategy form's. Its chips wrap to a second line rather than
 * scroll -- a sort past the edge of a phone is a sort nobody finds.
 */
export function SortRow({ value, onChange, className, label = 'Sort' }: { value: FilterSort; onChange: (v: FilterSort) => void; className?: string; label?: string }) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap items-center gap-1', className)}>
      <span className="shrink-0 pr-0.5 text-[12px] text-muted-foreground">Sort</span>
      {FILTER_SORTS.map((x) => (
        <button key={x.key} type="button" aria-pressed={value === x.key} onClick={() => onChange(x.key)}
          className={cn('m-0 h-8 shrink-0 appearance-none whitespace-nowrap rounded-full border border-solid px-2.5 font-[inherit] text-[12.5px] font-medium',
            value === x.key ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)] text-[var(--chosen-text)]' : 'border-border bg-transparent text-muted-foreground')}>
          {x.label}
        </button>
      ))}
    </div>
  );
}

type Side = 'all' | 'up' | 'down' | 'win';



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

export function FilterPicker({ noun, options, picked, onChange, split = false, winAtLeast, onWinAtLeast, sort, onSort }: {
  noun: FilterNoun;
  options: readonly FilterOption[];
  /** The keys chosen; empty is every one. */
  picked: readonly string[];
  onChange: (next: string[]) => void;
  /**
   * Tabs for the options' profit and loss (owner, 13 Oct 2026: "a profit / loss tab in the methods dropdown"):
   * All, In profit -- the most first -- and In loss -- the worst first -- by each option's `tone` and `value`,
   * each with a tap that chooses every one in it.
   */
  split?: boolean;
  /**
   * The Win tab's line, in whole percent (owner, 14 Oct 2026: "all, profit, loss, win -- 30% by default, a % I can
   * edit; 30 shows 30 and over"). Kept by the caller so it lasts; without it, the picker keeps its own from 30.
   */
  winAtLeast?: number;
  onWinAtLeast?: (pct: number) => void;
  /** The list's order (`FilterSort`), kept by the caller so it lasts; without it, the picker keeps its own. Shown where the options carry a record. */
  sort?: FilterSort;
  onSort?: (s: FilterSort) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const [side, setSide] = useState<Side>('all');
  const [ownLine, setOwnLine] = useState(WIN_AT_LEAST_PCT);
  const [ownSort, setOwnSort] = useState<FilterSort>('default');
  const order = sort ?? ownSort;
  const setOrder = (v: FilterSort) => { setOwnSort(v); onSort?.(v); };
  const line = asPct(winAtLeast ?? ownLine);
  const setLine = (pct: number) => { setOwnLine(asPct(pct)); onWinAtLeast?.(asPct(pct)); };
  if (options.length === 0) return null;
  const chosen = options.filter((o) => picked.includes(o.key)).map((o) => o.key);
  const words = pickedWords(options, picked, noun);
  const on = chosen.length > 0;
  const toggle = (key: string) => onChange(chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]);
  const searchable = options.length >= SEARCH_FROM;
  const wanted = find.trim().toLowerCase();
  const tabs = split && options.some((o) => o.tone);
  const winTab = tabs && options.some((o) => o.winRate !== undefined);
  const ofSide = (x: Side): FilterOption[] => {
    if (x === 'all') return [...options];
    // The most won first; between equals, the one with more trades behind it.
    if (x === 'win') return options.filter((o) => wonAtLeast(o.winRate, line)).sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0) || (b.value ?? 0) - (a.value ?? 0));
    return options.filter((o) => o.tone === x)
      .sort((a, b) => (x === 'up' ? (b.value ?? 0) - (a.value ?? 0) : (a.value ?? 0) - (b.value ?? 0)));
  };
  const sides: Side[] = winTab ? ['all', 'up', 'down', 'win'] : ['all', 'up', 'down'];
  const sideWords = (x: Side) => (x === 'all' ? 'All' : x === 'up' ? 'In profit' : x === 'down' ? 'In loss' : `Win ≥${line}%`);
  const sortable = options.some((o) => o.value !== undefined || o.trades !== undefined || o.winRate !== undefined);
  const onSide = sortOptions(tabs ? ofSide(side) : [...options], sortable ? order : 'default');
  const shown = searchable && wanted ? onSide.filter((o) => `${o.name} ${o.also ?? ''}`.toLowerCase().includes(wanted)) : onSide;
  const listName = noun.many[0]!.toUpperCase() + noun.many.slice(1);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setFind(''); setSide('all'); } }}>
      <PopoverTrigger asChild>
        <button
          type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${noun.label} filter: ${words}`}
          className={cn(
            'm-0 inline-flex h-10 max-w-[12rem] shrink-0 appearance-none items-center gap-1 whitespace-nowrap rounded-full border border-solid px-2.5 text-left font-[inherit] text-[13.5px] font-medium',
            on ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)] text-[var(--chosen-text)]' : 'border-border bg-transparent text-foreground',
          )}
        >
          {/* One chosen: its name alone, cut where it runs long -- the name says the kind. Otherwise the kind, and how many where several. */}
          {chosen.length === 1
            ? <span className="min-w-0 truncate font-semibold">{words}</span>
            : <span className="shrink-0">{noun.label}</span>}
          {chosen.length > 1 && (
            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[var(--chosen)] px-1 text-[11.5px] font-bold tabular-nums text-[var(--chosen-ink)]">{chosen.length}</span>
          )}
          <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', on ? 'text-[var(--chosen-text)]' : 'text-muted-foreground', open && 'rotate-180')} aria-hidden />
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
        {tabs && (
          <div role="group" aria-label={`${listName} by profit and loss`} className="flex shrink-0 gap-1 border-0 border-b border-solid border-[var(--line-soft)] p-1.5">
            {sides.map((x) => (
              <button
                key={x} type="button" aria-pressed={side === x} onClick={() => setSide(x)}
                // The name, its count under it: four side by side fit a 360px phone that way (measured, 14 Oct 2026).
                className={cn(
                  'm-0 flex min-h-[44px] min-w-0 flex-1 appearance-none flex-col items-center justify-center rounded-md border-0 px-1 py-1 font-[inherit] text-[12.5px] font-semibold leading-tight',
                  side === x ? (x === 'up' ? 'bg-[var(--up-bg)] text-[var(--up)]' : x === 'down' ? 'bg-[var(--down-bg)] text-[var(--down)]' : x === 'win' ? 'bg-[var(--chosen-soft)] text-[var(--chosen-text)]' : 'bg-muted text-foreground') : 'bg-transparent text-muted-foreground',
                )}
              >
                <span className="whitespace-nowrap">{sideWords(x)}</span> <span className="text-[11.5px] tabular-nums opacity-80">{ofSide(x).length}</span>
              </button>
            ))}
          </div>
        )}
        {winTab && side === 'win' && <WinLine pct={line} onChange={setLine} />}
        {sortable && <SortRow value={order} onChange={setOrder} className="shrink-0 border-0 border-b border-solid border-[var(--line-soft)] px-2 py-1.5" />}
        <ul role="listbox" aria-multiselectable="true" aria-label={listName} className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
          {!wanted && side === 'all' && <Row on={chosen.length === 0} name={`All ${noun.many}`} note={`${options.length} in this list`} onClick={() => onChange([])} />}
          {!wanted && side !== 'all' && onSide.length > 0 && (
            <Row
              on={chosen.length === onSide.length && onSide.every((o) => chosen.includes(o.key))}
              name={`Only the ${onSide.length} ${side === 'up' ? 'in profit' : side === 'down' ? 'in loss' : `that won ${line}% or more`}`} note={`Choose every ${noun.label.toLowerCase()} on this tab, and no other`}
              onClick={() => onChange(onSide.map((o) => o.key))}
            />
          )}
          {shown.map((o) => (
            <Row key={o.key} on={chosen.includes(o.key)} name={o.name} note={o.note} tone={o.tone} onClick={() => toggle(o.key)} />
          ))}
          {shown.length === 0 && (
            <li className="m-0 px-2 py-3 text-[13px] text-muted-foreground">
              {wanted ? `No ${noun.label.toLowerCase()} matches “${find.trim()}”.`
                : side === 'win' ? `No ${noun.label.toLowerCase()} won ${line}% or more here. Lower the line above.`
                : `No ${noun.label.toLowerCase()} is ${side === 'up' ? 'in profit' : 'in loss'} here.`}
            </li>
          )}
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
            className="m-0 h-10 flex-1 appearance-none rounded-md border-0 bg-[var(--chosen)] font-[inherit] text-[13.5px] font-semibold text-[var(--chosen-ink)]"
          >
            Done
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Win tab's line: a whole percent typed in, or stepped five at a time. What is typed is kept as typed while it is
 * being typed -- an empty box is not 0 -- and the list follows each whole number as it lands.
 */
export function WinLine({ pct, onChange, className, name = 'Win rate at least, percent' }: { pct: number; onChange: (pct: number) => void; className?: string; name?: string }) {
  const [text, setText] = useState(String(pct));
  const id = useId();
  const step = (by: number) => { const next = asPct(pct + by); setText(String(next)); onChange(next); };
  const stepper = 'm-0 grid h-10 w-10 shrink-0 appearance-none place-items-center rounded-md border border-solid border-border bg-transparent font-[inherit] text-[18px] font-semibold text-foreground disabled:opacity-40';
  return (
    <div className={className ?? 'flex shrink-0 items-center gap-2 border-0 border-b border-solid border-[var(--line-soft)] px-2 py-1.5'}>
      <label htmlFor={id} className="min-w-0 flex-1 text-[13px] text-muted-foreground">Won at least</label>
      <button type="button" aria-label="Five less" disabled={pct <= 0} onClick={() => step(-5)} className={stepper}>−</button>
      <span className="relative">
        <input
          id={id} aria-label={name} value={text}
          inputMode="numeric" autoComplete="off" maxLength={3}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, '');
            setText(raw);
            if (raw !== '') onChange(asPct(Number(raw)));
          }}
          onBlur={() => setText(String(pct))}
          // 16px: a smaller font makes iOS zoom the whole page when the box is tapped.
          className="m-0 h-10 w-[4.5rem] appearance-none rounded-md border border-solid border-border bg-background pl-2 pr-6 text-right font-[inherit] text-[16px] tabular-nums text-foreground outline-none"
        />
        <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[14px] text-muted-foreground">%</span>
      </span>
      <button type="button" aria-label="Five more" disabled={pct >= 100} onClick={() => step(5)} className={stepper}>+</button>
    </div>
  );
}

function Row({ on, name, note, tone, onClick }: { on: boolean; name: string; note?: string; tone?: 'up' | 'down'; onClick: () => void }) {
  return (
    <li role="option" aria-selected={on} className="m-0 p-0">
      <button
        type="button" onClick={onClick} tabIndex={0}
        className={cn(
          'm-0 flex min-h-[44px] w-full appearance-none items-center gap-2.5 rounded-md border-0 px-2 py-1.5 text-left font-[inherit]',
          on ? 'bg-[var(--chosen-soft)]' : 'bg-transparent',
        )}
      >
        <span
          aria-hidden
          className={cn('grid h-5 w-5 shrink-0 place-items-center rounded border border-solid', on ? 'border-[var(--chosen)] bg-[var(--chosen)] text-[var(--chosen-ink)]' : 'border-border bg-transparent')}
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
