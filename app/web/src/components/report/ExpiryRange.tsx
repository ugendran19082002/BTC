import { useState, type ReactNode } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import { dayLabel, expiryDayOf, rangeOf, type RangeKey } from '@/lib/market-report';
import { daysIn } from '@/lib/custom-range';
import { Segmented } from '@/components/mobile/parts';
import { DateRangeSheet } from '@/components/mobile/DateRangeSheet';

/**
 * Which expiry days a report covers (13 Oct 2026): since 1 Oct, the last 7 or 30, or a range of the owner's own
 * ("I want a custom date"). The custom range is picked in the phone's own date sheet -- quick picks, a From and
 * a To -- which serves the desk as well, and is remembered beside the choice. The dates are expiry days: the day
 * a contract settles, each running from 5:30 PM the evening before.
 */

type Choice = RangeKey | 'custom';
const OPTIONS: { key: Choice; label: string; spoken: string }[] = [
  { key: 'all', label: 'Since 1 Oct', spoken: 'Every expiry day since 1 October' },
  { key: '7', label: '7 days', spoken: 'The last 7 expiry days' },
  { key: '30', label: '30 days', spoken: 'The last 30 expiry days' },
  { key: 'custom', label: 'Custom', spoken: 'A range of expiry days of your own' },
];
/** The server reads at most this many days at a time (`REPORT_MAX_DAYS`). */
const MAX_DAYS = 190;

export function useExpiryRange(prefix: string, now: number): { range: { from: string; to: string }; control: ReactNode } {
  const [stored, setChoice] = usePersisted<Choice>(`${prefix}.range`, 'all');
  const [custom, setCustom] = usePersisted<{ from: string; to: string } | null>(`${prefix}.custom`, null);
  const [picking, setPicking] = useState(false);
  const today = expiryDayOf(now);
  // A custom choice with no range kept (an older build, cleared storage) is "since 1 Oct".
  const choice: Choice = stored === 'custom' ? (custom ? 'custom' : 'all') : OPTIONS.some((o) => o.key === stored) ? stored : 'all';
  const range = choice === 'custom' ? custom! : rangeOf(choice, now);
  const tooLong = picking ? null : daysIn(range) > MAX_DAYS;

  const control = (
    <div className="grid min-w-0 gap-1.5">
      <Segmented
        label="Expiry days" value={choice} options={OPTIONS}
        // Custom opens the sheet every time it is tapped: chosen already, a tap is "change the dates".
        onChange={(key) => { if (key === 'custom') setPicking(true); else setChoice(key); }}
      />
      {choice === 'custom' && (
        <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 px-1 text-[13px]">
          <span className="text-muted-foreground">
            Expiry days <span className="text-foreground">{dayLabel(range.from)} → {dayLabel(range.to)}</span> · {daysIn(range)} day{daysIn(range) === 1 ? '' : 's'}
            {tooLong && <span className="text-[var(--down)]"> · at most {MAX_DAYS} days can be read at a time</span>}
          </span>
          <button type="button" onClick={() => setPicking(true)} className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">Change dates</button>
        </p>
      )}
      {picking && (
        <DateRangeSheet
          value={custom ?? rangeOf('7', now)} today={today}
          onApply={(v) => { setCustom(v); setChoice('custom'); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
  return { range, control };
}
