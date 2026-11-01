import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { REENTRY_DEFAULT, REENTRY_MAX_IN_A_ROW, REENTRY_MAX_SIZE, type Reentry as Setting } from '@/types/strategy';

/**
 * Re-entry after an option SL (owner, 1 Nov 2026: "SL exit aana opposite side entry ... no-entry window restrict pana
 * kudathu"), this account's: a signal strategy's trade out on its option stop is followed by a sale of the other side,
 * by the same strategy, under all its rules but the no-entry window. A pill beside the momentum guard -- off, or on with
 * how many in a row and the size -- opening to the switch and the two numbers.
 */

const inRange = (text: string, most: number) => {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= most;
};

export function Reentry({ reentry, busy, onSave }: {
  /** The account's setting as saved. */
  reentry: Setting;
  busy?: boolean;
  /** The setting to keep; null, back to the default (off). */
  onSave: (reentry: Setting | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(reentry.on);
  const [max, setMax] = useState(String(reentry.max));
  const [size, setSize] = useState(String(reentry.size));
  useEffect(() => {
    if (!open) { setOn(reentry.on); setMax(String(reentry.max)); setSize(String(reentry.size)); }
  }, [open, reentry.on, reentry.max, reentry.size]);
  const problem = !inRange(max, REENTRY_MAX_IN_A_ROW) ? `In a row: a whole number from 1 to ${REENTRY_MAX_IN_A_ROW}.`
    : !inRange(size, REENTRY_MAX_SIZE) ? `Size: a whole number from 1 to ${REENTRY_MAX_SIZE}.` : null;
  const edited = on !== reentry.on || Number(max) !== reentry.max || Number(size) !== reentry.size;
  const isDefault = !reentry.on && reentry.max === REENTRY_DEFAULT.max && reentry.size === REENTRY_DEFAULT.size;
  const save = async (r: Setting | null) => { if (await onSave(r)) setOpen(false); };
  const field = (label: string, value: string, set: (v: string) => void, bad: boolean) => (
    <input
      aria-label={label} inputMode="numeric" value={value} disabled={busy}
      onChange={(e) => set(e.target.value.replace(/[^0-9]/g, '').slice(0, 1))}
      className={cn('m-0 h-7 w-10 rounded border border-solid border-border bg-[var(--bg)] px-1.5 text-right font-[inherit] text-[12px] tabular-nums text-foreground', bad && 'border-[var(--down)]')}
    />
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="desk-badge-pill inline-flex cursor-pointer items-center gap-1.5"
        title="After an option SL, the same strategy sells the other side: CE stopped, PE sold; PE stopped, CE sold. Every rule applies but the no-entry window."
        style={reentry.on
          ? { background: 'color-mix(in srgb, var(--up) 12%, transparent)', color: 'var(--up)', border: '1px solid color-mix(in srgb, var(--up) 30%, transparent)' }
          : { background: 'color-mix(in srgb, var(--text) 5%, transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
      >
        <span>Re-entry after SL</span>
        <span className={cn(!reentry.on && 'text-muted-foreground')}>
          {!reentry.on ? 'off' : `opposite · max ${reentry.max} · x${reentry.size}`}
        </span>
      </PopoverTrigger>
      <PopoverContent aria-label="Re-entry after SL" className="w-[18rem]">
        <p className="m-0 mb-2 text-[12px] leading-snug text-muted-foreground">
          When a trade's option SL hits, the same strategy sells the other side at once: CE stopped → PE sold, PE stopped → CE sold.
          Delta, premium, SL, target, caps and the momentum guard all apply; the no-entry window does not.
        </p>
        <label className="mb-2 flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={on} disabled={busy} onChange={(e) => setOn(e.target.checked)} />
          On
        </label>
        <label className="mb-1.5 flex items-center gap-2 text-[12px]">
          <span>At most</span>
          {field('Re-entries in a row', max, setMax, !inRange(max, REENTRY_MAX_IN_A_ROW))}
          <span>in a row (1–{REENTRY_MAX_IN_A_ROW})</span>
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <span>Size</span>
          {field('Times the lots', size, setSize, !inRange(size, REENTRY_MAX_SIZE))}
          <span>× the strategy's lots (1–{REENTRY_MAX_SIZE})</span>
        </label>
        {problem && <p role="alert" className="m-0 mt-2 text-[11.5px] text-[var(--down)]">{problem}</p>}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" disabled={busy || problem !== null || !edited} onClick={() => void save({ on, max: Number(max), size: Number(size) })}
                  className="m-0 h-8 appearance-none rounded-md border-0 bg-primary px-3 font-[inherit] text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
            Save
          </button>
          <button type="button" disabled={busy || isDefault} onClick={() => void save(null)}
                  className="m-0 h-8 appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[12px] text-muted-foreground disabled:opacity-50">
            Defaults
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
