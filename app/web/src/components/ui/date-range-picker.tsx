import { useEffect, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { CalendarDays } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * A date range, chosen in one place.
 *
 * Two `<input type="date">` boxes worked, and worked differently in every
 * browser: Chrome shows a picker, Safari on a phone shows a wheel, Firefox on
 * Linux shows nothing at all. On a desk where the answer is nearly always
 * "today" or "this week", the presets down the side are the actual interface
 * and the calendar is there for the day they are not enough.
 *
 * Everything is an IST calendar date, as `YYYY-MM-DD`. Dates are handled as
 * strings rather than as `Date` objects throughout, because a `Date` carries a
 * time and a zone and both of them are ways for "the 8th" to become the 7th.
 */

export type DateRangeValue = { from: string; to: string };

/** Today in IST. The desk runs in one zone and never asks which. */
export const istToday = (now = Date.now()): string =>
  new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);

const shift = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;

/** Midday UTC, so a timezone shift of a few hours cannot move the date. */
const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
const fromDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const PRESETS: { label: string; range: (today: string) => DateRangeValue }[] = [
  { label: 'today', range: (t) => ({ from: t, to: t }) },
  { label: 'yesterday', range: (t) => ({ from: shift(t, -1), to: shift(t, -1) }) },
  { label: 'last 7 days', range: (t) => ({ from: shift(t, -6), to: t }) },
  { label: 'last 30 days', range: (t) => ({ from: shift(t, -29), to: t }) },
  { label: 'this month', range: (t) => ({ from: monthStart(t), to: t }) },
];

const DISPLAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const WITH_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "8 Sept", "2–8 Sept", "today" — whichever is shortest and still exact. */
export function describeRange(value: DateRangeValue, today = istToday()): string {
  const matched = PRESETS.find((p) => {
    const r = p.range(today);
    return r.from === value.from && r.to === value.to;
  });
  if (matched) return matched.label;

  const sameYear = value.from.slice(0, 4) === value.to.slice(0, 4);
  const thisYear = value.from.slice(0, 4) === today.slice(0, 4);
  const fmt = thisYear && sameYear ? DISPLAY : WITH_YEAR;
  if (value.from === value.to) return fmt.format(toDate(value.from));
  return `${fmt.format(toDate(value.from))} – ${fmt.format(toDate(value.to))}`;
}

export function DateRangePicker({
  value, onChange, className,
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const today = istToday();

  // While the calendar is being used there is a moment with only one end
  // chosen. Committing that would reload the list against half a range, so it
  // is held here and only handed over once both ends exist.
  const [draft, setDraft] = useState<DateRange | undefined>();
  useEffect(() => {
    if (open) setDraft({ from: toDate(value.from), to: toDate(value.to) });
  }, [open, value.from, value.to]);

  const pick = (next: DateRange | undefined) => {
    setDraft(next);
    if (next?.from && next.to) {
      onChange({ from: fromDate(next.from), to: fromDate(next.to) });
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'inline-flex h-9 items-center gap-2 rounded-md border border-border bg-muted px-2.5',
          'font-[inherit] text-[13px] text-foreground',
          'hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          className,
        )}
      >
        <CalendarDays className="h-3.5 w-3.5 flex-none text-muted-foreground" />
        {describeRange(value, today)}
      </PopoverTrigger>

      <PopoverContent className="flex w-auto gap-3 p-3">
        {/* The presets are the interface; the calendar is the escape hatch. */}
        <div className="flex w-[7.5rem] flex-none flex-col gap-0.5 border-r border-border pr-3">
          {PRESETS.map((p) => {
            const r = p.range(today);
            const active = r.from === value.from && r.to === value.to;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => { onChange(r); setOpen(false); }}
                className={cn(
                  'rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted-foreground',
                  'hover:bg-accent hover:text-foreground',
                  active && 'bg-muted text-foreground',
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <Calendar
          mode="range"
          selected={draft}
          onSelect={pick}
          defaultMonth={toDate(value.from)}
          // The desk has no orders from the future, so neither has this.
          disabled={{ after: toDate(today) }}
          numberOfMonths={1}
          classNames={{
            day_range_start: 'bg-primary text-primary-foreground rounded-l-md',
            day_range_end: 'bg-primary text-primary-foreground rounded-r-md',
            day_range_middle: 'bg-muted text-foreground rounded-none',
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
