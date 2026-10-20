import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { timeQuickPicks, timeRangeProblem, timeRangeWords, type DateTimeRange } from '@/lib/date-time-range';
import { cn } from '@/lib/utils';
import { Chip, Segmented } from '@/components/mobile/parts';

/**
 * A From and a To -- each a date and a time, IST -- from the bottom of the screen (trade history, owner, 19 Oct 2026:
 * "a custom date and time range, user friendly"). The desk's own windows a tap away; the phone's date and time
 * pickers for anything else. Whether a trade counts by when it was entered or when it closed is chosen here too.
 * Checked as it is typed, the reason in words; Show is the only way out that changes anything.
 */
export type RangeBy = 'entry' | 'exit';

export function DateTimeRangeSheet({ value, by, now, onApply, onClose }: {
  value: DateTimeRange;
  by: RangeBy;
  now: number;
  onApply: (v: DateTimeRange, by: RangeBy) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DateTimeRange>(value);
  const [byDraft, setByDraft] = useState<RangeBy>(by);
  const problem = timeRangeProblem(draft, now);
  const first = useRef<HTMLInputElement>(null);
  const quick = timeQuickPicks(now);

  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = before; window.removeEventListener('keydown', esc); };
  }, [onClose]);

  const field = 'h-12 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-3 text-[16px] text-foreground';
  const same = (a: DateTimeRange, b: DateTimeRange) => a.from === b.from && a.to === b.to && a.fromTime === b.fromTime && a.toTime === b.toTime;
  const end = (name: 'From' | 'To', dayKey: 'from' | 'to', timeKey: 'fromTime' | 'toTime') => (
    <fieldset className="m-0 grid min-w-0 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium text-[var(--time)]">{name}</legend>
      <input ref={dayKey === 'from' ? first : undefined} type="date" aria-label={`${name} date`} className={field} value={draft[dayKey]}
        onChange={(e) => setDraft((d) => ({ ...d, [dayKey]: e.target.value }))} />
      <input type="time" aria-label={`${name} time`} className={field} value={draft[timeKey]}
        onChange={(e) => setDraft((d) => ({ ...d, [timeKey]: e.target.value }))} />
    </fieldset>
  );
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="presentation">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 border-0 bg-black/60 p-0" tabIndex={-1} />
      <div role="dialog" aria-modal="true" aria-labelledby="dt-range-title"
        className="relative max-h-[92vh] w-full max-w-[560px] overflow-y-auto rounded-t-2xl border-t border-border bg-background px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2">
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--line)]" />
        <div className="flex items-center justify-between">
          <h2 id="dt-range-title" className="m-0 text-[17px] font-semibold">Date and time</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 grid h-11 w-11 place-items-center rounded-md border-0 bg-transparent text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div role="group" aria-label="Quick picks" className="mt-2 flex flex-wrap gap-2">
          {quick.map((q) => <Chip key={q.label} on={same(draft, q.range)} onClick={() => setDraft(q.range)}>{q.label}</Chip>)}
        </div>

        <div className="mt-3 grid gap-3">
          {end('From', 'from', 'fromTime')}
          {end('To', 'to', 'toTime')}
        </div>

        <div className="mt-3">
          <Segmented label="A trade counts by" value={byDraft} onChange={setByDraft}
            options={[{ key: 'entry', label: 'Entry time', spoken: 'By when it was entered' }, { key: 'exit', label: 'Exit time', spoken: 'By when it closed' }]} />
        </div>

        <p role={problem ? 'alert' : 'status'} className={cn('m-0 mt-3 min-h-[20px] text-[13.5px]', problem ? 'text-[var(--down)]' : 'text-[var(--time)]')}>
          {problem ?? `${timeRangeWords(draft)} · by ${byDraft === 'entry' ? 'entry' : 'exit'} time, IST`}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <button type="button" onClick={onClose} className="h-12 rounded-lg border border-border bg-transparent font-[inherit] text-[15px] text-foreground">Cancel</button>
          <button type="button" disabled={problem !== null} onClick={() => onApply(draft, byDraft)}
            className="h-12 rounded-lg border-0 bg-[var(--up)] font-[inherit] text-[15px] font-semibold text-[var(--bg)] disabled:opacity-40">
            Show
          </button>
        </div>
      </div>
    </div>
  );
}
