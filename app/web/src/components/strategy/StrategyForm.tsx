import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { saveStrategy } from '@/api/strategy';
import { DAY_NAMES, DEFAULT_CONFIG, type Strategy, type StrategyConfig } from '@/types/strategy';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describeStrategy, sizingOf } from '@/lib/strategy-preview';
import { inr, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Everything a strategy is, on one screen, in words rather than symbols.
 *
 * The first version put the premium rule behind a "≥ / ≤" pair, and the two
 * are opposites: one takes the furthest strike still paying the number, the
 * other the richest strike under it. One click apart, a third of the return and
 * nearly half the drawdown between them, and nothing on screen saying so. It
 * got picked by accident, which is the clearest argument there is for spelling
 * a setting out.
 *
 * So: every choice that changes what gets sold says what it does, the days say
 * which ones they are, and the panel at the top reads the whole rule back as a
 * sentence while it is being edited. Nothing here decides anything -- the server
 * validates and answers, and what it answers is what gets shown.
 */
function Field({ label, hint, children, stack }: {
  label: string; hint?: string; children: React.ReactNode; stack?: boolean;
}) {
  return (
    <div className={cn('py-2', stack ? '' : 'flex items-center justify-between gap-3')}>
      <label
        className={cn('block text-[12.5px] text-muted-foreground',
          hint && 'cursor-help underline decoration-dotted underline-offset-2',
          stack && 'mb-1.5')}
        title={hint}
      >
        {label}
      </label>
      <div className={cn('flex items-center gap-1.5', stack ? 'flex-wrap' : 'flex-none')}>
        {children}
      </div>
    </div>
  );
}

/** Buttons that say what they mean, with room for a line of explanation. */
function Pick<T extends string>({ value, options, onChange, wide }: {
  value: T;
  options: { v: T; label: string; note?: string }[];
  onChange: (v: T) => void;
  wide?: boolean;
}) {
  return (
    <div className={cn('grid gap-1', wide ? 'w-full' : 'grid-flow-col')}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-left',
            value === o.v
              ? 'border-[var(--warn)] bg-muted text-foreground'
              : 'border-[var(--line)] text-muted-foreground',
          )}
        >
          <span className="block text-[12.5px] font-medium">{o.label}</span>
          {o.note && <span className="block text-[11px] leading-snug text-[var(--dim)]">{o.note}</span>}
        </button>
      ))}
    </div>
  );
}

const num = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

export function StrategyForm({ editing, open, onOpenChange, onSaved, balanceUsd, spot }: {
  editing: Strategy | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  balanceUsd?: number | null;
  spot?: number | null;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [c, setC] = useState<StrategyConfig>(editing?.config ?? DEFAULT_CONFIG);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const set = <K extends keyof StrategyConfig>(k: K, v: StrategyConfig[K]) =>
    setC((p) => ({ ...p, [k]: v }));

  const toggleDay = (d: number) =>
    set('weekdays', c.weekdays.includes(d)
      ? c.weekdays.filter((x) => x !== d)
      : [...c.weekdays, d].sort());

  const sizing = sizingOf(c, balanceUsd ?? null, spot ?? null);

  const save = async () => {
    setBusy(true);
    setProblems([]);
    try {
      await saveStrategy({ id: editing?.id, name: name.trim(), config: c });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setProblems((e as Error).message.split(/(?<=\.)\s+/).filter(Boolean));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={editing ? `Edit ${editing.name}` : 'New strategy'}
        description="Times are IST. Nothing runs until this strategy and auto-trading are both on."
      >
        {/*
          The whole rule as a sentence, updating as it is edited. Reading a
          config back in prose is how a wrong setting gets noticed before it is
          saved rather than after it has traded.
        */}
        <p className="m-0 mb-3 rounded-lg bg-muted px-2.5 py-2 text-[12px] leading-relaxed text-foreground">
          {describeStrategy(c)}
        </p>

        <Field label="Name">
          <Input value={name} aria-label="strategy name" className="w-48"
                 onChange={(e) => setName(e.target.value)} placeholder="Double one-sided" />
        </Field>

        <div className="mt-2 border-t border-[var(--line)] pt-2 text-[11px] uppercase tracking-wide text-[var(--dim)]">
          When
        </div>
        <Field label="Entry time" hint="IST. The daily contract opens at 05:30.">
          <Input value={c.entryTime} aria-label="entry time" className="w-20"
                 onChange={(e) => set('entryTime', e.target.value)} />
        </Field>
        <Field label="Exit time" hint="IST. Expiry is 17:30, so 17:29 is the last minute to trade.">
          <Input value={c.exitTime} aria-label="exit time" className="w-20"
                 onChange={(e) => set('exitTime', e.target.value)} />
        </Field>

        <Field label="Days" stack>
          <div className="flex flex-wrap gap-1">
            {DAY_NAMES.map((d, i) => {
              const on = c.weekdays.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  aria-label={d}
                  aria-pressed={on}
                  onClick={() => toggleDay(i)}
                  className={cn('h-8 w-11 rounded-md border text-[11.5px] font-medium',
                    on
                      // Filled, not merely outlined: seven buttons that differ
                      // only by border colour read as seven identical buttons.
                      ? 'border-[var(--warn)] bg-[var(--warn)] text-black'
                      : 'border-[var(--line)] bg-transparent text-[var(--dim)]')}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex gap-2 text-[11px]">
            {([['Every day', [0, 1, 2, 3, 4, 5, 6]], ['Weekdays', WEEKDAYS], ['Weekends', WEEKEND]] as const)
              .map(([label, days]) => (
                <button key={label} type="button"
                        className="text-muted-foreground underline underline-offset-2"
                        onClick={() => set('weekdays', [...days])}>
                  {label}
                </button>
              ))}
          </div>
        </Field>

        <div className="mt-2 border-t border-[var(--line)] pt-2 text-[11px] uppercase tracking-wide text-[var(--dim)]">
          What to sell
        </div>
        <Field label="Legs" stack>
          <Pick wide value={c.legs} onChange={(v) => set('legs', v)}
                options={[
                  { v: 'both', label: 'Call and put', note: 'both sides — the tested strategy' },
                  { v: 'CE', label: 'Call only', note: 'profits if BTC does not rise much' },
                  { v: 'PE', label: 'Put only', note: 'profits if BTC does not fall much' },
                ]} />
        </Field>

        {/*
          The setting that caused the trouble. Both halves spelled out: which
          strike each rule takes, and which way that moves the risk.
        */}
        <Field label="Premium rule" stack>
          <Pick wide value={c.premium.mode} onChange={(v) => set('premium', { ...c.premium, mode: v })}
                options={[
                  {
                    v: 'atLeast',
                    label: `At least $${c.premium.usd}`,
                    note: 'furthest strike that still pays this — more premium, more risk',
                  },
                  {
                    v: 'atMost',
                    label: `At most $${c.premium.usd}`,
                    note: 'best strike paying up to this — less premium, less risk',
                  },
                ]} />
          <div className="mt-1 flex items-center gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">$ per BTC</span>
            <Input value={String(c.premium.usd)} aria-label="premium usd" className="w-20"
                   onChange={(e) => set('premium', { ...c.premium, usd: num(e.target.value, 15) })} />
          </div>
        </Field>

        <Field label="Lots per leg" hint="1 lot = 1 contract = 0.001 BTC.">
          <Input value={String(c.lots)} aria-label="lots" className="w-24"
                 onChange={(e) => set('lots', Math.floor(num(e.target.value, 1)))} />
        </Field>

        {/* What that size actually means, before it is saved. */}
        <div className="rounded-lg bg-muted px-2.5 py-2 text-[11.5px] leading-relaxed">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Max contracts at once</span>
            <span className="tabular-nums text-foreground">{sizing.maxContracts}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Margin needed</span>
            <span className="tabular-nums text-foreground">
              {spot ? `${inr(sizing.marginInr)} · ${usd(sizing.marginUsd)}` : '— waiting for price'}
            </span>
          </div>
          {sizing.shareOfAccount !== null && (
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground"
                    title="Measured against free margin. Money already behind an open position cannot fund a new one.">
                Share of free margin
              </span>
              <span className={cn('tabular-nums',
                sizing.shareOfAccount > 0.5 ? 'text-[var(--down)]' : 'text-foreground')}>
                {Math.round(sizing.shareOfAccount * 100)}%
              </span>
            </div>
          )}
        </div>

        <div className="mt-2 border-t border-[var(--line)] pt-2 text-[11px] uppercase tracking-wide text-[var(--dim)]">
          Entry
        </div>
        <Field label="Price" stack>
          <Pick wide value={c.entryPrice} onChange={(v) => set('entryPrice', v)}
                options={[
                  { v: 'offer', label: 'Sell at the offer', note: 'better price if someone takes it' },
                  { v: 'now', label: 'Sell now at the bid', note: 'fills at once, lower price' },
                  { v: 'set', label: 'My own price', note: 'waits there until it fills' },
                ]} />
        </Field>
        {c.entryPrice === 'set' && (
          <Field label="Limit price">
            <Input value={String(c.entryLimit ?? '')} aria-label="entry limit" className="w-24"
                   onChange={(e) => set('entryLimit', num(e.target.value, 0))} />
          </Field>
        )}
        {c.entryPrice === 'offer' && (
          <Field label="Sell at bid after" hint="Wait this long at the offer, then take the bid. 0 waits until it fills.">
            <Input value={String(c.crossAfterSec)} aria-label="cross after seconds" className="w-20"
                   onChange={(e) => set('crossAfterSec', Math.floor(num(e.target.value, 5)))} />
            <span className="text-[11.5px] text-muted-foreground">
              {c.crossAfterSec > 0 ? 'sec' : 'sec — waits until filled'}
            </span>
          </Field>
        )}

        <div className="mt-2 border-t border-[var(--line)] pt-2 text-[11px] uppercase tracking-wide text-[var(--dim)]">
          Exit
        </div>
        <Field label="Take profit" hint="Buy back once this much of the premium has decayed. 0 holds to expiry.">
          <Input value={String(Math.round(c.takeProfitPct * 100))} aria-label="take profit pct" className="w-20"
                 onChange={(e) => set('takeProfitPct', num(e.target.value, 95) / 100)} />
          <span className="text-[11.5px] text-muted-foreground">% earned</span>
        </Field>
        <Field label="Stop loss" hint="Buy back if the premium rises this much above the entry price. 0 means no stop.">
          <Input value={String(Math.round(c.stopLossPct * 100))} aria-label="stop loss pct" className="w-20"
                 onChange={(e) => set('stopLossPct', num(e.target.value, 0) / 100)} />
          <span className="text-[11.5px] text-muted-foreground">
            {c.stopLossPct > 0 ? '%' : '% — no stop'}
          </span>
        </Field>

        <div className="mt-2 border-t border-[var(--line)] pt-2 text-[11px] uppercase tracking-wide text-[var(--dim)]">
          Safety filter
        </div>
        <Field label="Skip a leg that is not safe enough" stack>
          <Pick wide value={c.probGate === null ? 'off' : 'on'}
                onChange={(v) => set('probGate', v === 'on' ? 0.95 : null)}
                options={[
                  { v: 'on', label: 'On', note: 'skip a leg below your safety %' },
                  { v: 'off', label: 'Off', note: 'always sell both legs' },
                ]} />
          {c.probGate !== null && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">Safety</span>
              <Input value={String(Math.round(c.probGate * 1000) / 10)} aria-label="prob gate pct" className="w-20"
                     onChange={(e) => set('probGate', num(e.target.value, 95) / 100)} />
              <span className="text-[11.5px] text-muted-foreground">% to expire worthless</span>
            </div>
          )}
        </Field>
        <Field label="Double the other leg" stack>
          <Pick wide value={c.doubleWhenOneSided ? 'on' : 'off'}
                onChange={(v) => set('doubleWhenOneSided', v === 'on')}
                options={[
                  { v: 'on', label: 'On', note: 'if one leg is skipped, sell double on the other' },
                  { v: 'off', label: 'Off', note: 'same lots on each leg, always' },
                ]} />
        </Field>

        {/* Live objections, before the button rather than after it. */}
        {sizing.warnings.map((wn) => (
          <p key={wn} className="m-0 mt-2 text-[11.5px] leading-snug text-[var(--warn)]">{wn}</p>
        ))}
        {problems.map((p) => (
          <p key={p} className="m-0 mt-2 text-[11.5px] leading-snug text-[var(--down)]">{p}</p>
        ))}

        <p className="m-0 mt-3 text-[11.5px] leading-snug text-muted-foreground">
          New strategies are saved switched off. Turn it on from the list when you are ready.
        </p>

        <SheetFooter>
          <Button variant="outline" className="h-11 flex-none px-4" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="h-11 flex-1" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
