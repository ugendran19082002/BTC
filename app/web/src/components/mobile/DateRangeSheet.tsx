import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { describeRange, type DateRangeValue } from '@/components/ui/date-range-picker';
import { daysIn, quickPicks, rangeProblem, shiftDay } from '@/lib/custom-range';
import { cn } from '@/lib/utils';
import { Chip } from '@/components/mobile/parts';

/**
 * A From and a To date, from the bottom of the screen (the phone's P&L, owner, 6 Oct 2026). Quick picks for the
 * ranges asked for most; the phone's own date picker for anything else -- the one a thumb already knows. The range
 * is checked as it is typed, with the reason in words, and Show is the only way out that changes anything.
 */
export function DateRangeSheet({ value, today, onApply, onClose }: {
  value: DateRangeValue;
  today: string;
  onApply: (v: DateRangeValue) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DateRangeValue>(value);
  const problem = rangeProblem(draft, today);
  const first = useRef<HTMLInputElement>(null);
  const earliest = shiftDay(today, -365);

  useEffect(() => {
    first.current?.focus({ preventScroll: true });
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = before; window.removeEventListener('keydown', esc); };
  }, [onClose]);

  const field = 'h-12 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-3 text-[16px] text-foreground [color-scheme:dark]';
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="presentation">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 border-0 bg-black/60 p-0" tabIndex={-1} />
      <div
        role="dialog" aria-modal="true" aria-labelledby="range-title"
        className="relative w-full max-w-[560px] rounded-t-2xl border-t border-border bg-background px-4 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2"
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--line)]" />
        <div className="flex items-center justify-between">
          <h2 id="range-title" className="m-0 text-[17px] font-semibold">Custom range</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 grid h-11 w-11 place-items-center rounded-md border-0 bg-transparent text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div role="group" aria-label="Quick picks" className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-1">
          {quickPicks(today).map((q) => (
            <Chip key={q.label} on={draft.from === q.range.from && draft.to === q.range.to} onClick={() => setDraft(q.range)}>{q.label}</Chip>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] text-muted-foreground">From</span>
            <input ref={first} type="date" className={field} value={draft.from} min={earliest} max={today}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] text-muted-foreground">To</span>
            <input type="date" className={field} value={draft.to} min={earliest} max={today}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
          </label>
        </div>

        <p role={problem ? 'alert' : 'status'} className={cn('m-0 mt-3 min-h-[20px] text-[13.5px]', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
          {problem ?? `${describeRange(draft, today)} · ${daysIn(draft)} day${daysIn(draft) === 1 ? '' : 's'}`}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <button type="button" onClick={onClose} className="h-12 rounded-lg border border-border bg-transparent font-[inherit] text-[15px] text-foreground">
            Cancel
          </button>
          <button
            type="button" disabled={problem !== null} onClick={() => onApply(draft)}
            className="h-12 rounded-lg border-0 bg-[var(--up)] font-[inherit] text-[15px] font-semibold text-[var(--bg)] disabled:opacity-40"
          >
            Show
          </button>
        </div>
      </div>
    </div>
  );
}
