import { useState, type ReactNode } from 'react';
import type { DayRow } from '@/types/report';
import { compactInr, pnlTone, signedInr, usdToInr } from '@/lib/format';
import { byDay, heat, monthsOf } from '@/lib/report';
import { cn } from '@/lib/utils';

/**
 * The days of the P&L range as a calendar, for a thumb (owner, 6 Oct 2026): under each month's name what the month
 * made and how many days went up and down; a row of weekday letters; then a square a day, green or red by what it
 * made and stronger the bigger, with the figure written in it. A tap on a day puts that day's own numbers under
 * the calendar -- net, trades, profit, loss, charges, and the running total. The last day traded is open to begin with.
 *
 * Only the weeks that hold a day of the range are drawn, so seven days are one row, not a month of blanks.
 *
 * The gaps are marked important: the desk's own `.grid { gap: 12px }` (styles.css) comes after the utilities and
 * would otherwise win, leaving seven squares 33px wide on a 360px phone.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `2026-10-06` as "Tue, 6 Oct". */
function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const rs = (usd: number | null | undefined) => (usd === null || usd === undefined ? '—' : signedInr(usdToInr(usd)));
/** A day counts as traded when it booked or was charged anything. */
const traded = (r: DayRow | undefined): r is DayRow => !!r && (r.trades > 0 || r.netUsd !== 0);

export function DayCalendar({ from, to, rows, today }: { from: string; to: string; rows: DayRow[]; today: string }) {
  // Only the days of the range asked for: a reading still on screen from the range before must not show through.
  const inRange = rows.filter((r) => r.day >= from && r.day <= to);
  const map = byDay(inRange);
  const days = inRange.filter(traded);
  const maxAbs = Math.max(0, ...days.map((x) => Math.abs(x.netUsd)));
  const [picked, setPicked] = useState<string | null>(null);
  // The day chosen, while it is still in the range shown; else the last day traded.
  const open = picked && traded(map.get(picked)) ? picked : days[days.length - 1]?.day ?? null;
  const row = open ? map.get(open) : undefined;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {monthsOf(from, to).map((m) => {
        const weeks = m.weeks.filter((w) => w.some((d) => d !== null));
        if (weeks.length === 0) return null;
        const mine = days.filter((r) => r.day.startsWith(m.key));
        const net = mine.reduce((n, r) => n + r.netUsd, 0);
        const up = mine.filter((r) => r.netUsd > 0).length;
        const down = mine.filter((r) => r.netUsd < 0).length;
        return (
          <section key={m.key} aria-label={m.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[12px] font-semibold tracking-[0.5px] text-muted-foreground">{m.label}</span>
              {mine.length > 0 && (
                <span className="text-[12px] tabular-nums text-muted-foreground">
                  <span className={cn('font-semibold', pnlTone(net) === 'up' && 'text-[var(--up)]', pnlTone(net) === 'down' && 'text-[var(--down)]')}>{rs(net)}</span>
                  {' · '}{up} up · {down} down
                </span>
              )}
            </div>
            <div aria-hidden="true" className="mb-1 grid grid-cols-7 !gap-[4px] text-center text-[10.5px] text-[var(--dim)]">
              {WEEKDAYS.map((w) => <span key={w}>{w[0]}</span>)}
            </div>
            <div className="grid grid-cols-7 !gap-[4px]">
              {weeks.flat().map((d, i) => {
                if (!d) return <span key={i} />;
                const r = map.get(d);
                const isToday = d === today;
                const num = Number(d.slice(8));
                if (!traded(r)) {
                  return (
                    <span
                      key={i} aria-label={`${dayLabel(d)}: no trades`} aria-current={isToday ? 'date' : undefined}
                      className={cn('grid min-h-[44px] place-items-center rounded-md bg-muted text-[11.5px] tabular-nums text-[var(--dim)]', isToday && 'ring-1 ring-[var(--time)]')}
                    >
                      {num}
                    </span>
                  );
                }
                const level = heat(r.netUsd, maxAbs);
                const gain = r.netUsd > 0;
                return (
                  <button
                    key={i} type="button" onClick={() => setPicked(d)} aria-pressed={d === open} aria-current={isToday ? 'date' : undefined}
                    aria-label={`${dayLabel(d)}: ${rs(r.netUsd)}, ${r.trades} trade${r.trades === 1 ? '' : 's'}`}
                    className={cn(
                      'flex min-h-[44px] min-w-0 flex-col items-center justify-center gap-[3px] rounded-md border-0 p-0 font-[inherit] tabular-nums',
                      level === 0 && 'bg-muted text-muted-foreground',
                      gain && level === 1 && 'bg-[color-mix(in_srgb,var(--up)_22%,transparent)] text-foreground',
                      gain && level === 2 && 'bg-[color-mix(in_srgb,var(--up)_48%,transparent)] text-foreground',
                      gain && level === 3 && 'bg-[var(--up)] text-[var(--bg)]',
                      !gain && level === 1 && 'bg-[color-mix(in_srgb,var(--down)_22%,transparent)] text-foreground',
                      !gain && level === 2 && 'bg-[color-mix(in_srgb,var(--down)_48%,transparent)] text-foreground',
                      !gain && level === 3 && 'bg-[var(--down)] text-[var(--bg)]',
                      d === open ? 'ring-2 ring-foreground' : isToday && 'ring-1 ring-[var(--time)]',
                    )}
                  >
                    <span className="text-[11px] leading-none opacity-75">{num}</span>
                    <span className="max-w-full truncate text-[11.5px] font-semibold leading-none min-[390px]:text-[12.5px]">{compactInr(usdToInr(r.netUsd))}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {/* What the colours mean, once, under the last month. */}
      <div aria-hidden="true" className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <span>Loss</span>
        {['bg-[var(--down)]', 'bg-[color-mix(in_srgb,var(--down)_48%,transparent)]', 'bg-[color-mix(in_srgb,var(--down)_22%,transparent)]', 'bg-muted',
          'bg-[color-mix(in_srgb,var(--up)_22%,transparent)]', 'bg-[color-mix(in_srgb,var(--up)_48%,transparent)]', 'bg-[var(--up)]'].map((c) => (
          <span key={c} className={cn('h-2.5 w-4 rounded-sm', c)} />
        ))}
        <span>Profit</span>
      </div>

      {row ? (
        <div className="rounded-lg bg-muted p-2.5" aria-live="polite">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-semibold text-[var(--time)]">{dayLabel(row.day)}{row.day === today ? ' · today' : ''}</span>
            <span className={cn('text-[16px] font-semibold tabular-nums', pnlTone(row.netUsd) === 'up' && 'text-[var(--up)]', pnlTone(row.netUsd) === 'down' && 'text-[var(--down)]')}>
              {rs(row.netUsd)}
            </span>
          </div>
          {/* Its own small grid, not the screen's tiles: six figures have to fit whole inside this box on a 360px phone. */}
          <dl className="m-0 grid grid-cols-3 !gap-x-[8px] !gap-y-[8px]">
            <Figure label="Trades">{row.trades}</Figure>
            <Figure label="Profit" tone={row.profitUsd ? 'up' : undefined}>{row.profitUsd === undefined ? '—' : rs(row.profitUsd)}</Figure>
            <Figure label="Loss" tone={row.lossUsd ? 'down' : undefined}>{row.lossUsd === undefined ? '—' : rs(-row.lossUsd)}</Figure>
            <Figure label="Gross" tone={pnlTone(row.realisedUsd)}>{rs(row.realisedUsd)}</Figure>
            <Figure label="Charges" tone={row.chargesUsd ? 'down' : undefined}>{rs(-row.chargesUsd)}</Figure>
            <Figure label="Running total" tone={pnlTone(row.cumulativeUsd)}>{rs(row.cumulativeUsd)}</Figure>
          </dl>
          {days.length > 1 && <p className="m-0 mt-1.5 text-[11.5px] text-muted-foreground">Tap a day for its figures.</p>}
        </div>
      ) : (
        <p className="m-0 text-[12.5px] text-muted-foreground">No day in this range has a trade yet.</p>
      )}
    </div>
  );
}

function Figure({ label, tone, children }: { label: string; tone?: 'up' | 'down'; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 whitespace-nowrap text-[13.5px] font-semibold tabular-nums', tone === 'up' && 'text-[var(--up)]', tone === 'down' && 'text-[var(--down)]')}>{children}</dd>
    </div>
  );
}
