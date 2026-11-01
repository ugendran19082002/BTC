import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { REENTRY_DEFAULT, REENTRY_MAX_IN_A_ROW, REENTRY_MAX_SIZE, type Reentry as Setting, type ReentryRule } from '@/types/strategy';

/**
 * Re-entry after an option exit (owner, 1 Nov 2026), this account's: a signal strategy's trade out on its option SL is
 * followed by a sale of the other side, one out on its target by the same side again -- by the same strategy, under all
 * its rules but the no-entry window, each in its own time range. One pill for both -- off, or which are on and when --
 * opening to the two rules side by side, with today's count.
 */

type Kind = keyof Setting;
type Draft = { on: boolean; from: string; to: string; max: string; size: string };
const draftOf = (r: ReentryRule): Draft => ({ on: r.on, from: r.from, to: r.to, max: String(r.max), size: String(r.size) });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const whole = (text: string, most: number) => {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= most;
};
/** Why one rule cannot be saved; null when it can. */
const problemOf = (d: Draft): string | null =>
  !HHMM.test(d.from) || !HHMM.test(d.to) ? 'the time range is two times'
    : d.from === d.to ? 'the time range must not start and end at the same minute'
      : !whole(d.max, REENTRY_MAX_IN_A_ROW) ? `in a row: a whole number from 1 to ${REENTRY_MAX_IN_A_ROW}`
        : !whole(d.size, REENTRY_MAX_SIZE) ? `size: a whole number from 1 to ${REENTRY_MAX_SIZE}` : null;
const ruleOf = (d: Draft): ReentryRule => ({ on: d.on, from: d.from, to: d.to, max: Number(d.max), size: Number(d.size) });
/** "07:00" -> "7", "17:29" -> "17:29": for the pill. */
const short = (hhmm: string) => { const [h, m] = hhmm.split(':'); return m === '00' ? String(Number(h)) : `${Number(h)}:${m}`; };
const same = (a: ReentryRule, b: ReentryRule) => a.on === b.on && a.from === b.from && a.to === b.to && a.max === b.max && a.size === b.size;

const KINDS: { kind: Kind; title: string; does: string; label: string }[] = [
  { kind: 'sl', title: 'After SL', does: 'sell the OPPOSITE side', label: 'After SL' },
  { kind: 'tgt', title: 'After target', does: 'sell the SAME side again', label: 'After target' },
];

export function Reentry({ reentry, today = null, busy, onSave }: {
  /** The account's setting as saved. */
  reentry: Setting;
  /** Re-entries this session, after an SL and after a target; null where the server does not say. */
  today?: { sl: number; tgt: number } | null;
  busy?: boolean;
  /** The setting to keep; null, back to the default (both off). */
  onSave: (reentry: Setting | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ sl: draftOf(reentry.sl), tgt: draftOf(reentry.tgt) });
  useEffect(() => { if (!open) setDraft({ sl: draftOf(reentry.sl), tgt: draftOf(reentry.tgt) }); }, [open, reentry]);
  const set = (kind: Kind, field: keyof Draft, value: string | boolean) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], [field]: value } }));
  const problems = { sl: problemOf(draft.sl), tgt: problemOf(draft.tgt) };
  const valid = !problems.sl && !problems.tgt;
  const edited = valid && (!same(ruleOf(draft.sl), reentry.sl) || !same(ruleOf(draft.tgt), reentry.tgt));
  const isDefault = same(reentry.sl, REENTRY_DEFAULT.sl) && same(reentry.tgt, REENTRY_DEFAULT.tgt);
  const save = async (r: Setting | null) => { if (await onSave(r)) setOpen(false); };
  const anyOn = reentry.sl.on || reentry.tgt.on;
  const pill = [
    reentry.sl.on ? `SL→opp ${short(reentry.sl.from)}–${short(reentry.sl.to)}` : null,
    reentry.tgt.on ? `TGT→same ${short(reentry.tgt.from)}–${short(reentry.tgt.to)}` : null,
  ].filter(Boolean).join(' · ');
  const field = 'm-0 h-7 rounded border border-solid border-border bg-[var(--bg)] px-1.5 font-[inherit] text-[12px] tabular-nums text-foreground';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="desk-badge-pill inline-flex cursor-pointer items-center gap-1.5"
        title="After an option SL, sell the opposite side; after a target, the same side again. Every rule applies but the no-entry window."
        style={anyOn
          ? { background: 'color-mix(in srgb, var(--up) 12%, transparent)', color: 'var(--up)', border: '1px solid color-mix(in srgb, var(--up) 30%, transparent)' }
          : { background: 'color-mix(in srgb, var(--text) 5%, transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
      >
        <span>Re-entry</span>
        <span className={cn(!anyOn && 'text-muted-foreground')}>{anyOn ? pill : 'off'}</span>
      </PopoverTrigger>
      <PopoverContent aria-label="Re-entry" className="w-[21rem] max-w-[calc(100vw-2rem)]">
        <p className="m-0 mb-2 text-[12px] font-semibold">Re-entry <span className="font-normal text-muted-foreground">· this account</span></p>
        {KINDS.map(({ kind, title, does, label }) => (
          <fieldset key={kind} aria-label={label} className="m-0 mb-2 rounded-md border border-solid border-border p-2">
            <label className="mb-1.5 flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" aria-label={`${label}: on`} checked={draft[kind].on} disabled={busy} onChange={(e) => set(kind, 'on', e.target.checked)} />
              <span><b>{title}</b> → {does}</span>
            </label>
            <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]', !draft[kind].on && 'opacity-60')}>
              <span>Time</span>
              <input type="time" aria-label={`${label}: from`} value={draft[kind].from} disabled={busy} onChange={(e) => set(kind, 'from', e.target.value)} className={cn(field, 'w-[5.5rem]')} />
              <span>–</span>
              <input type="time" aria-label={`${label}: to`} value={draft[kind].to} disabled={busy} onChange={(e) => set(kind, 'to', e.target.value)} className={cn(field, 'w-[5.5rem]')} />
              <span>Max in a row</span>
              <input aria-label={`${label}: max in a row`} inputMode="numeric" value={draft[kind].max} disabled={busy}
                     onChange={(e) => set(kind, 'max', e.target.value.replace(/[^0-9]/g, '').slice(0, 1))} className={cn(field, 'w-9 text-right')} />
              <span>Size</span>
              <input aria-label={`${label}: size`} inputMode="numeric" value={draft[kind].size} disabled={busy}
                     onChange={(e) => set(kind, 'size', e.target.value.replace(/[^0-9]/g, '').slice(0, 1))} className={cn(field, 'w-9 text-right')} />
              <span>× lots</span>
            </div>
            {problems[kind] && <p role="alert" className="m-0 mt-1.5 text-[11.5px] text-[var(--down)]">{label}: {problems[kind]}.</p>}
          </fieldset>
        ))}
        <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">
          Same rules as the strategy: delta, min premium, SL, target, caps, momentum guard. The no-entry window is ignored;
          each re-entry's own time range is used instead.
        </p>
        {today && (
          <p aria-label="Today" className="m-0 mt-1.5 text-[11.5px] tabular-nums text-muted-foreground">
            Today: {today.sl + today.tgt} re-entr{today.sl + today.tgt === 1 ? 'y' : 'ies'} · {today.sl} after SL · {today.tgt} after target
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap justify-end gap-1.5">
          <button type="button" disabled={busy || isDefault} onClick={() => void save(null)}
                  className="m-0 h-8 appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[12px] text-muted-foreground disabled:opacity-50">
            Defaults
          </button>
          <button type="button" disabled={busy || !edited} onClick={() => void save({ sl: ruleOf(draft.sl), tgt: ruleOf(draft.tgt) })}
                  className="m-0 h-8 appearance-none rounded-md border-0 bg-primary px-3 font-[inherit] text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
            Save
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
