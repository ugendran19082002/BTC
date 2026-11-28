import { useEffect, useState } from 'react';
import { getMoveExit, saveMoveExit, type MoveExitSetting } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * The BTC-move exit of the account shown (owner, 22 Nov 2026: "build panu best practice"): a sale whose strike is near
 * BTC is bought back when BTC runs against it -- a call as BTC rises, a put as it falls -- before its option stop. Off by
 * default. The numbers are chosen in a tap each and kept with Save, as the session limit's are.
 *
 * The study behind the numbers offered (docs/research/2026-11-22-sl-jump-study.md): 0.8% in 10 minutes, strikes within
 * 1.5% of BTC -- +₹17.9k over 30 days, loss days 3 → 1; or 1.0% in 15 minutes for the more cautious, no day worse.
 */

const MOVES = [0.6, 0.8, 1.0];
const WINDOWS = [10, 15];
const NEARS = [1.0, 1.5, 2.0];
/**
 * The hours watched (22 Nov 2026, the 45-day study §12): from 09:00 earned the most with no day worse than now (+₹18.9k);
 * from 12:00 the cautious one (+₹14.9k, none worse); all day caught one more morning run and two false alarms.
 */
const FROMS: (string | null)[] = [null, '09:00', '12:00', '13:00'];
const TOS: (string | null)[] = [null, '16:30'];
/** The setting with its hours always said (null for none), so a kept setting from before them compares as unchanged. */
const norm = (x: MoveExitSetting): MoveExitSetting => ({ on: x.on, pct: x.pct, minutes: x.minutes, nearPct: x.nearPct, from: x.from ?? null, to: x.to ?? null });
const same = (a: MoveExitSetting, b: MoveExitSetting) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
/** "From 12:00 to the 17:30 expiry" / "All day": the hours watched, in words. */
const hoursWords = (x: MoveExitSetting) => (!x.from && !x.to ? 'All day' : `From ${x.from ?? 'the day\'s start'} to ${x.to ?? 'the 17:30 expiry'}`);

/**
 * Any number in the server's range, not only the chips (owner, 27 Nov 2026: "add custom, 0.7%"): a "Custom" chip opens a
 * small box; a figure in range is taken on Enter or leaving the box, one out of range is said and not taken. The limits
 * are the server's (`trading/move-exit.ts`), so nothing typed here is refused on Save.
 */
type Custom = { min: number; max: number; whole?: boolean; unit: string };
export const MOVE_CUSTOM = {
  pct: { min: 0.2, max: 5, unit: '%' },
  minutes: { min: 1, max: 60, whole: true, unit: 'min' },
  nearPct: { min: 0.2, max: 10, unit: '%' },
} as const satisfies Record<string, Custom>;
/** Why a typed figure cannot be taken, or null with the number it reads as. */
export function customProblem(text: string, c: Custom): { why: string } | { n: number } {
  const t = text.trim();
  const n = t === '' ? Number.NaN : Number(t);
  const ok = Number.isFinite(n) && n >= c.min && n <= c.max && (!c.whole || Number.isInteger(n))
    && (c.whole || Math.round(n * 100) === n * 100);
  return ok ? { n } : { why: `${c.whole ? 'A whole number' : 'A number'} from ${c.min} to ${c.max} ${c.unit}${c.whole ? '' : ', up to two decimals'}.` };
}

function Chips<T extends number | string | null>({ label, value, choices, word, onPick, custom }: {
  label: string; value: T; choices: readonly T[]; word: (c: T) => string; onPick: (c: T) => void;
  /** Numbers only: a "Custom" chip for any figure in this range. */
  custom?: Custom;
}) {
  const isCustom = custom !== undefined && !choices.includes(value);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(String(value ?? ''));
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => { setText(String(value ?? '')); }, [value]);
  const take = () => {
    if (!custom) return;
    const r = customProblem(text, custom);
    if ('why' in r) { setWhy(r.why); return; }
    setWhy(null); setOpen(false); onPick(r.n as T);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-[96px] text-[13px]">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap overflow-hidden rounded-md border border-solid border-border">
        {choices.map((c) => (
          <button
            key={String(c)} type="button" aria-pressed={value === c} onClick={() => { setOpen(false); setWhy(null); onPick(c); }}
            className={cn('h-9 min-w-[52px] border-0 px-2 font-[inherit] text-[13px]', value === c ? 'bg-[var(--accent-fill)] font-semibold text-foreground' : 'bg-transparent text-muted-foreground')}
          >
            {word(c)}
          </button>
        ))}
        {custom && (
          <button
            type="button" aria-pressed={isCustom} onClick={() => { setOpen(true); setWhy(null); }}
            className={cn('h-9 min-w-[64px] border-0 px-2 font-[inherit] text-[13px]', isCustom ? 'bg-[var(--accent-fill)] font-semibold text-foreground' : 'bg-transparent text-muted-foreground')}
          >
            {isCustom ? `Custom · ${word(value)}` : 'Custom'}
          </button>
        )}
      </div>
      {custom && open && (
        <span className="flex items-center gap-1.5">
          <input
            aria-label={`${label}, custom`} inputMode="decimal" value={text} autoFocus
            onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5))}
            onBlur={take}
            onKeyDown={(e) => { if (e.key === 'Enter') take(); if (e.key === 'Escape') { setOpen(false); setWhy(null); setText(String(value ?? '')); } }}
            className="m-0 h-9 w-[4.5rem] rounded-md border border-solid border-border bg-[var(--bg)] px-2 text-center font-[inherit] text-[13px] tabular-nums text-foreground"
          />
          <span className="text-[12px] text-muted-foreground">{custom.unit}</span>
        </span>
      )}
      {why && <span role="alert" className="basis-full text-[12px] text-[var(--down)]">{why}</span>}
    </div>
  );
}

export function MoveExitCard({ several = false }: { several?: boolean }) {
  const { data, error, refresh } = usePoll(getMoveExit, 30_000, { enabled: !several });
  const kept = data?.setting ?? null;
  const [draft, setDraft] = useState<MoveExitSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => { if (kept && !draft) setDraft(kept); }, [kept]); // eslint-disable-line react-hooks/exhaustive-deps

  if (several) return <p className="m-0 text-[12px] text-muted-foreground">BTC-move exit: set on each account&apos;s own tab.</p>;
  if (!data || !draft) return <p className="m-0 text-[12px] text-muted-foreground">{error ? `BTC-move exit: ${error.message}` : 'Reading the BTC-move exit…'}</p>;

  const changed = !same(draft, data.setting);
  const set = (patch: Partial<MoveExitSetting>) => setDraft((d) => d && ({ ...d, ...patch }));
  const save = async () => {
    setBusy(true); setRefusal(null);
    try {
      const r = await saveMoveExit(draft);
      setDraft(r.setting);
      await refresh();
    } catch (e) {
      setRefusal((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="BTC-move exit" className="grid min-w-0 gap-2">
      <Switch
        label="BTC-move exit" checked={draft.on} onCheckedChange={(v) => set({ on: v })}
        description={draft.on
          ? `${hoursWords(draft)}: when BTC moves ${draft.pct}% against a sale within ${draft.minutes} min (a call as BTC rises, a put as it falls), the sales with a strike within ${draft.nearPct}% of BTC are bought back at once, worst first. Sales further out keep their own stops and targets.`
          : 'Off: sales are left to their own stops and targets.'}
      />
      {draft.on && (
        <div className="grid gap-1.5">
          <Chips label="BTC move" value={draft.pct} choices={MOVES} word={(c) => `${c}%`} onPick={(c) => set({ pct: c })} custom={MOVE_CUSTOM.pct} />
          <Chips label="Within" value={draft.minutes} choices={WINDOWS} word={(c) => `${c} min`} onPick={(c) => set({ minutes: c })} custom={MOVE_CUSTOM.minutes} />
          <Chips label="Strikes near" value={draft.nearPct} choices={NEARS} word={(c) => `${c}%`} onPick={(c) => set({ nearPct: c })} custom={MOVE_CUSTOM.nearPct} />
          <Chips label="From" value={draft.from ?? null} choices={FROMS} word={(c) => c ?? 'All day'} onPick={(c) => set({ from: c })} />
          <Chips label="Until" value={draft.to ?? null} choices={TOS} word={(c) => c ?? 'Expiry 17:30'} onPick={(c) => set({ to: c })} />
        </div>
      )}
      {refusal && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">{refusal}</p>}
      {changed && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={() => void save()} className="h-10 rounded-md border-0 bg-foreground font-[inherit] text-[14px] font-semibold text-background disabled:opacity-40">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => { setDraft(data.setting); setRefusal(null); }} className="h-10 rounded-md border border-solid border-border bg-transparent font-[inherit] text-[14px] text-foreground">
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
