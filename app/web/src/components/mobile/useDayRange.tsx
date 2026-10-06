import { useState, type ReactNode } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import { daysAgoIst, todayIst } from '@/lib/report';
import { rangeProblem } from '@/lib/custom-range';
import { Segmented } from '@/components/mobile/parts';
import { DateRangeSheet } from '@/components/mobile/DateRangeSheet';
import type { DateRangeValue } from '@/components/ui/date-range-picker';

/**
 * The phone's date filter, one for every screen that reads IST days (6 Oct 2026): Today, the last 7, 30 or 90 days,
 * or Custom -- last, as the owner asked -- which opens a sheet for any From and To. First on P&L; the signal
 * history's pairs have the same one, each screen remembering its own choice under its own name.
 */

export type DayRangeKey = 'today' | '7' | '30' | '90' | 'custom';
const RANGES: { key: DayRangeKey; label: string; spoken?: string; days: number }[] = [
  // Short on the button so five fit a 360px phone; said in full to a screen reader.
  { key: 'today', label: 'Today', days: 0 },
  { key: '7', label: '7D', spoken: '7 days', days: 6 },
  { key: '30', label: '30D', spoken: '30 days', days: 29 },
  { key: '90', label: '90D', spoken: '90 days', days: 89 },
  { key: 'custom', label: 'Custom', days: -1 },
];

export type DayRange = {
  key: DayRangeKey;
  isToday: boolean;
  isCustom: boolean;
  /** IST days, `YYYY-MM-DD`, both included. */
  from: string;
  to: string;
  today: string;
  /** Open the From / To sheet again: the "Change" beside a custom range. */
  pick: () => void;
  /** The control itself, and its sheet while that is open: put it at the top of the screen. */
  bar: ReactNode;
};

/** `name` is where the choice is remembered: `m-pnl` keeps P&L's, as it always has. */
export function useDayRange(name: string, now: number): DayRange {
  const [range, setRange] = usePersisted<DayRangeKey>(`${name}-range`, 'today');
  const r = RANGES.find((x) => x.key === range) ?? RANGES[0]!;
  const isToday = r.key === 'today';
  const today = todayIst(now);
  // The custom range, remembered; one that no longer holds (a year passed, a bad value) falls back to the last 7 days.
  const [custom, setCustom] = usePersisted<DateRangeValue>(`${name}-custom`, { from: daysAgoIst(6, now), to: today });
  const customOk = rangeProblem(custom, today) === null;
  const [picking, setPicking] = useState(false);
  const to = r.key === 'custom' && customOk ? custom.to : today;
  const from = isToday ? today : r.key === 'custom' ? (customOk ? custom.from : daysAgoIst(6, now)) : daysAgoIst(r.days, now);
  const bar = (
    <>
      <Segmented label="Range" value={r.key} options={RANGES} onChange={(k) => (k === 'custom' ? setPicking(true) : setRange(k))} />
      {picking && (
        <DateRangeSheet
          value={customOk ? custom : { from, to }} today={today}
          onApply={(v) => { setCustom(v); setRange('custom'); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
  return { key: r.key, isToday, isCustom: r.key === 'custom', from, to, today, pick: () => setPicking(true), bar };
}
