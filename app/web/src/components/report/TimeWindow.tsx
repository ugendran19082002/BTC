import { useEffect, useState, type ReactNode } from 'react';
import { useSynced } from '@/hooks/useSynced';
import { clock12, isWholeContract, WHOLE_CONTRACT, windowProblem, type TimeWindow } from '@/lib/market-report';

/**
 * The time window of each expiry day a report counts trades in (owner, 29 Oct 2026: "from time to time, e.g. 5:31 PM
 * to 5:29 PM -- one contract by default, changeable, saved, user friendly on a phone"). Two times, the phone's own
 * time wheel for each, applied with a tap so a half-turned wheel does not ask the server; the whole contract a tap
 * back. Kept as the report's other choices are (`useSynced`): on this device at once, and by the desk where the
 * session may write -- a view-only phone keeps its own.
 */
export function useTimeWindow(prefix: string): { window: TimeWindow; whole: boolean; control: ReactNode } {
  const [stored, setStored] = useSynced<TimeWindow>(`${prefix}.window`, WHOLE_CONTRACT);
  // A kept window that cannot be asked for (an older build, storage edited by hand) is the whole contract.
  const hours = stored && windowProblem(stored) === null ? stored : WHOLE_CONTRACT;
  const [draft, setDraft] = useState<TimeWindow>(hours);
  useEffect(() => { setDraft(hours); }, [hours.from, hours.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const problem = windowProblem(draft);
  const changed = draft.from !== hours.from || draft.to !== hours.to;
  const whole = isWholeContract(hours);

  const time = (end: 'from' | 'to', label: string) => (
    <label className="grid min-w-0 gap-0.5 text-[12px] text-muted-foreground">
      {label}
      <input
        type="time" value={draft[end]} aria-label={`Trades entered ${label.toLowerCase()}`}
        onChange={(e) => setDraft((d) => ({ ...d, [end]: e.target.value }))}
        className="h-11 w-full min-w-0 rounded-md border border-solid border-border bg-transparent px-2 font-[inherit] text-[15px] tabular-nums text-foreground"
      />
    </label>
  );

  const control = (
    <section aria-label="Time window" className="grid min-w-0 gap-2 rounded-lg border border-solid border-border px-3 py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 text-[13px] font-medium">
          Trades entered <span className="font-normal text-muted-foreground">· each expiry day, IST</span>
        </span>
        {!whole && (
          <button
            type="button" onClick={() => setStored(WHOLE_CONTRACT)}
            className="min-h-[36px] shrink-0 border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]"
          >
            Whole contract
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {time('from', 'From')}
        {time('to', 'To')}
      </div>
      <p role={problem ? 'alert' : undefined} className={`m-0 text-[12px] leading-snug ${problem ? 'text-[var(--down)]' : 'text-muted-foreground'}`}>
        {problem ?? (isWholeContract(draft)
          ? `${clock12(draft.from)} → ${clock12(draft.to)}: the whole contract, from its open to its settlement.`
          : `${clock12(draft.from)} → ${clock12(draft.to)} of each expiry day. The day's figures and kind stay the whole day's.`)}
      </p>
      {changed && (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button" disabled={problem !== null} onClick={() => setStored(draft)}
            className="h-11 rounded-md border-0 bg-foreground font-[inherit] text-[14px] font-semibold text-background disabled:opacity-40"
          >
            Apply
          </button>
          <button
            type="button" onClick={() => setDraft(hours)}
            className="h-11 rounded-md border border-solid border-border bg-transparent font-[inherit] text-[14px] text-foreground"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
  return { window: hours, whole, control };
}
