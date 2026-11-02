import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { REENTRY_DEFAULT, REENTRY_MAX_ENTRIES, type Reentry as Setting, type ReentryRule } from '@/types/strategy';

/**
 * Re-entry after an option exit (owner, 1 Nov 2026), this account's: a signal strategy's trade out on its option SL is
 * followed by a sale of the other side, one out on its target by the same side again -- by the same strategy, under all
 * its rules but the no-entry window, each in its own time range. One pill for both -- off, or which are on and when --
 * opening to the two rules side by side, with today's count.
 *
 * Each rule's "trades at once" (owner, 2 Nov 2026: "oru SL adicha opposite side 2 entry edukunum, 2, 3, 4 editable"): how
 * many trades the exit of the signal's own trade opens, a tap from 1 to 4. No "max in a row" on either rule (owner, the
 * same day: "REENTRY_MAX_IN_A_ROW venaa"): each re-entry is followed by one, while its time range is open.
 */

type Kind = keyof Setting;
type Draft = { on: boolean; from: string; to: string; entries: number };
// `?? 1`: a server from before 2 Nov sends no `entries` (and a `max` that is not used).
const draftOf = (r: ReentryRule): Draft => ({ on: r.on, from: r.from, to: r.to, entries: r.entries ?? 1 });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Why one rule cannot be saved; null when it can. */
const problemOf = (d: Draft): string | null =>
  !HHMM.test(d.from) || !HHMM.test(d.to) ? 'the time range is two times'
    : d.from === d.to ? 'the time range must not start and end at the same minute' : null;
const ruleOf = (d: Draft): ReentryRule => ({ on: d.on, from: d.from, to: d.to, entries: d.entries });
const settingOf = (d: Record<Kind, Draft>): Setting => ({ sl: ruleOf(d.sl), tgt: ruleOf(d.tgt) });
/** "×2" on the pill when an exit opens more than one. */
const times = (r: ReentryRule) => ((r.entries ?? 1) > 1 ? ` ×${r.entries}` : '');
/** "07:00" -> "7", "17:29" -> "17:29": for the pill. */
const short = (hhmm: string) => { const [h, m] = hhmm.split(':'); return m === '00' ? String(Number(h)) : `${Number(h)}:${m}`; };
const same = (a: Setting, b: Setting) => (['sl', 'tgt'] as const).every((k) => {
  const x = draftOf(a[k]), y = draftOf(b[k]);
  return x.on === y.on && x.from === y.from && x.to === y.to && x.entries === y.entries;
});
const ENTRIES = Array.from({ length: REENTRY_MAX_ENTRIES }, (_, i) => i + 1);

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
  const set = (kind: Kind, field: keyof Draft, value: string | boolean | number) => setDraft((d) => ({ ...d, [kind]: { ...d[kind], [field]: value } }));
  const problems = { sl: problemOf(draft.sl), tgt: problemOf(draft.tgt) };
  const valid = !problems.sl && !problems.tgt;
  const edited = valid && !same(settingOf(draft), reentry);
  const isDefault = same(reentry, REENTRY_DEFAULT);
  const save = async (r: Setting | null) => { if (await onSave(r)) setOpen(false); };
  const anyOn = reentry.sl.on || reentry.tgt.on;
  const pill = [
    reentry.sl.on ? `SL→opp${times(reentry.sl)} ${short(reentry.sl.from)}–${short(reentry.sl.to)}` : null,
    reentry.tgt.on ? `TGT→same${times(reentry.tgt)} ${short(reentry.tgt.from)}–${short(reentry.tgt.to)}` : null,
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
            </div>
            <div className={cn('mt-1.5 flex items-center gap-2 text-[12px]', !draft[kind].on && 'opacity-60')}>
              <span>Trades at once</span>
              <div role="radiogroup" aria-label={`${label}: trades at once`} className="inline-flex overflow-hidden rounded border border-solid border-border">
                {ENTRIES.map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={draft[kind].entries === n} disabled={busy} onClick={() => set(kind, 'entries', n)}
                          className={cn('m-0 h-7 w-8 appearance-none border-0 font-[inherit] text-[12px] tabular-nums',
                            n > 1 && 'border-l border-solid border-border',
                            draft[kind].entries === n ? 'bg-primary font-semibold text-primary-foreground' : 'bg-[var(--bg)] text-foreground')}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {problems[kind] && <p role="alert" className="m-0 mt-1.5 text-[11.5px] text-[var(--down)]">{label}: {problems[kind]}.</p>}
          </fieldset>
        ))}
        <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">
          Same rules and lot size as the strategy: delta, lots, min premium, SL, target, caps, momentum guard. The no-entry
          window is ignored; each re-entry's own time range is used instead. Trades at once: what the signal's own trade
          opens when it exits; each of those is then followed by one, so they never multiply. No limit in a row: re-entries
          go on while the time range is open and the caps allow.
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
          <button type="button" disabled={busy || !edited} onClick={() => void save(settingOf(draft))}
                  className="m-0 h-8 appearance-none rounded-md border-0 bg-primary px-3 font-[inherit] text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
            Save
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
