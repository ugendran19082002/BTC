import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { istToday } from '@/components/ui/date-range-picker';
import { cn } from '@/lib/utils';

/**
 * One IST day, chosen on a calendar -- the single-day partner of the
 * date-range picker (the P&L's minute-by-minute line, owner 2 Oct 2026: "a
 * date picker", in place of a dropdown of dates).
 *
 * `available` is the days there is anything to show for: only those (and
 * today) can be picked, the rest are greyed, and the arrows either side step
 * to the previous or next of them -- the quick way through a run of days.
 * Dates are `YYYY-MM-DD` strings throughout, as in the range picker: a `Date`
 * carries a time and a zone, and both are ways for "the 8th" to become the 7th.
 */

const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
const fromDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const DISPLAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const WITH_YEAR = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** "Today · Fri 2 Oct", "Yesterday · Thu 1 Oct", "Mon 28 Sept" (the year only when it is not this one). */
export function describeDay(day: string, today = istToday()): string {
  const fmt = day.slice(0, 4) === today.slice(0, 4) ? DISPLAY : WITH_YEAR;
  const text = fmt.format(toDate(day));
  if (day === today) return `Today · ${text}`;
  if (day === shift(today, -1)) return `Yesterday · ${text}`;
  return text;
}

export function DayPicker({ value, onChange, available, label = 'which day', className }: {
  value: string;
  onChange: (day: string) => void;
  /** The days with something to show, any order. Today is always allowed. */
  available: readonly string[];
  /** What the day is for, read by screen readers. */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const today = istToday();
  const days = [...new Set([today, ...available])].filter((d) => d <= today).sort();
  const allowed = new Set(days);
  const i = days.indexOf(value);
  const prev = i > 0 ? days[i - 1] : i === -1 ? days.filter((d) => d < value).at(-1) : undefined;
  const next = i >= 0 && i < days.length - 1 ? days[i + 1] : i === -1 ? days.find((d) => d > value) : undefined;
  const pick = (d: string) => { onChange(d); setOpen(false); };
  const arrow = 'inline-flex h-9 w-8 items-center justify-center rounded-md border border-solid border-border bg-muted text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35';

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <button type="button" className={arrow} disabled={!prev} onClick={() => prev && onChange(prev)}
              aria-label={prev ? `previous day with a line: ${describeDay(prev, today)}` : 'no earlier day'}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={`${label}: ${describeDay(value, today)}`}
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-md border border-border bg-muted px-2.5',
            'font-[inherit] text-[13px] text-foreground',
            'hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          <CalendarDays className="h-3.5 w-3.5 flex-none text-muted-foreground" />
          {describeDay(value, today)}
        </PopoverTrigger>
        <PopoverContent className="flex w-auto flex-col gap-2 p-3">
          <div className="flex gap-1.5">
            {[['today', today], ['yesterday', shift(today, -1)]].map(([name, d]) => (
              <button key={name} type="button" disabled={!allowed.has(d!)} onClick={() => pick(d!)}
                      className={cn('rounded-md px-2 py-1 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35',
                        value === d && 'bg-muted text-foreground')}>
                {name}
              </button>
            ))}
          </div>
          <Calendar
            mode="single"
            selected={toDate(value)}
            onSelect={(d) => d && pick(fromDate(d))}
            defaultMonth={toDate(value)}
            // Only the days with a line; the future has none.
            disabled={(d) => !allowed.has(fromDate(d))}
            modifiers={{ hasLine: days.map(toDate) }}
            modifiersClassNames={{ hasLine: 'font-semibold' }}
            numberOfMonths={1}
          />
          <p className="m-0 text-[11px] text-muted-foreground">Bold: a day with a line. IST days.</p>
        </PopoverContent>
      </Popover>
      <button type="button" className={arrow} disabled={!next} onClick={() => next && onChange(next)}
              aria-label={next ? `next day with a line: ${describeDay(next, today)}` : 'no later day'}>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
