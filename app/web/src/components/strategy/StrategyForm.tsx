import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { saveStrategy } from '@/api/strategy';
import { DAY_NAMES, DEFAULT_CONFIG, type Strategy, type StrategyConfig } from '@/types/strategy';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Everything a strategy is, on one screen.
 *
 * Grouped the way the trade happens rather than the way the record is stored:
 * when it enters, what it sells, how it gets in, how it gets out, and which
 * days. Each field says what it does in the same words the desk uses
 * elsewhere -- "at least $15" reads the way the chain reads.
 *
 * Nothing here decides anything. The server validates and answers, and what it
 * answers is what gets shown; a form that reports success on a value the server
 * rejected is the worst kind of quiet failure.
 */
function Row({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <label
        className={cn('text-[12.5px] text-muted-foreground',
          hint && 'cursor-help underline decoration-dotted underline-offset-2')}
        title={hint}
      >
        {label}
      </label>
      <div className="flex flex-none items-center gap-1.5">{children}</div>
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-[var(--line)]">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn('px-2.5 py-1 text-[12px]',
            value === o.v ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const num = (v: string, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function StrategyForm({ editing, open, onOpenChange, onSaved }: {
  /** null means a new strategy. */
  editing: Strategy | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
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

  const save = async () => {
    setBusy(true);
    setProblems([]);
    try {
      await saveStrategy({ id: editing?.id, name: name.trim(), config: c });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      const m = (e as Error).message;
      // The server sends every objection at once; show them as a list.
      setProblems(m.split(/(?<=\.)\s+/).filter(Boolean));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={editing ? `Edit ${editing.name}` : 'New strategy'}
        description="Times are IST. Nothing runs until the strategy and the scheduler are both on."
      >
        <Row label="name">
          <Input
            value={name}
            aria-label="strategy name"
            className="w-44"
            onChange={(e) => setName(e.target.value)}
            placeholder="Double one-sided"
          />
        </Row>

        <div className="mt-2 mb-1 text-[11px] uppercase tracking-wide text-[var(--dim)]">when</div>
        <Row label="entry" hint="IST. The daily contract opens at 05:30.">
          <Input value={c.entryTime} aria-label="entry time" className="w-20"
                 onChange={(e) => set('entryTime', e.target.value)} />
        </Row>
        <Row label="exit" hint="IST. Settlement is 17:30, so 17:29 is the last minute that trades.">
          <Input value={c.exitTime} aria-label="exit time" className="w-20"
                 onChange={(e) => set('exitTime', e.target.value)} />
        </Row>
        <Row label="days" hint="Days it may run. Unticked days are skipped entirely.">
          <div className="flex gap-1">
            {DAY_NAMES.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-label={d}
                onClick={() => toggleDay(i)}
                className={cn('h-7 w-9 rounded border text-[11px]',
                  c.weekdays.includes(i)
                    ? 'border-[var(--up)] bg-muted text-foreground'
                    : 'border-[var(--line)] text-[var(--dim)]')}
              >
                {d}
              </button>
            ))}
          </div>
        </Row>

        <div className="mt-3 mb-1 text-[11px] uppercase tracking-wide text-[var(--dim)]">what to sell</div>
        <Row label="legs">
          <Choice value={c.legs} onChange={(v) => set('legs', v)}
                  options={[{ v: 'both', label: 'CE + PE' }, { v: 'CE', label: 'CE' }, { v: 'PE', label: 'PE' }]} />
        </Row>
        <Row label="premium" hint="At least: the furthest strike still paying it. At most: the richest strike under it.">
          <Choice value={c.premium.mode} onChange={(v) => set('premium', { ...c.premium, mode: v })}
                  options={[{ v: 'atLeast', label: '≥' }, { v: 'atMost', label: '≤' }]} />
          <Input value={String(c.premium.usd)} aria-label="premium usd" className="w-20"
                 onChange={(e) => set('premium', { ...c.premium, usd: num(e.target.value, 15) })} />
        </Row>
        <Row label="lots" hint="Contracts per leg. One contract is 0.001 BTC.">
          <Input value={String(c.lots)} aria-label="lots" className="w-20"
                 onChange={(e) => set('lots', Math.floor(num(e.target.value, 1)))} />
        </Row>

        <div className="mt-3 mb-1 text-[11px] uppercase tracking-wide text-[var(--dim)]">how it gets in</div>
        <Row label="price" hint="Offer rests and earns the spread. Now crosses and pays it.">
          <Choice value={c.entryPrice} onChange={(v) => set('entryPrice', v)}
                  options={[{ v: 'now', label: 'now' }, { v: 'offer', label: 'offer' }, { v: 'set', label: 'set' }]} />
        </Row>
        {c.entryPrice === 'set' && (
          <Row label="limit price">
            <Input value={String(c.entryLimit ?? '')} aria-label="entry limit" className="w-24"
                   onChange={(e) => set('entryLimit', num(e.target.value, 0))} />
          </Row>
        )}
        {c.entryPrice === 'offer' && (
          <Row label="cross after" hint="Wait this long at the offer, then take the bid. Zero rests until it fills.">
            <Input value={String(c.crossAfterSec)} aria-label="cross after seconds" className="w-20"
                   onChange={(e) => set('crossAfterSec', Math.floor(num(e.target.value, 5)))} />
            <span className="text-[11.5px] text-muted-foreground">sec</span>
          </Row>
        )}

        <div className="mt-3 mb-1 text-[11px] uppercase tracking-wide text-[var(--dim)]">how it gets out</div>
        <Row label="take profit" hint="Buy back once the premium has decayed this far. 0 holds to settlement.">
          <Input value={String(Math.round(c.takeProfitPct * 100))} aria-label="take profit pct" className="w-20"
                 onChange={(e) => set('takeProfitPct', num(e.target.value, 95) / 100)} />
          <span className="text-[11.5px] text-muted-foreground">% decay</span>
        </Row>
        <Row label="stop loss" hint="Buy back if the premium rises this far above entry. 0 means no stop.">
          <Input value={String(Math.round(c.stopLossPct * 100))} aria-label="stop loss pct" className="w-20"
                 onChange={(e) => set('stopLossPct', num(e.target.value, 0) / 100)} />
          <span className="text-[11.5px] text-muted-foreground">%</span>
        </Row>

        <div className="mt-3 mb-1 text-[11px] uppercase tracking-wide text-[var(--dim)]">the gate</div>
        <Row label="probability gate" hint="Refuse a leg the model puts below this to expire worthless.">
          <Choice value={c.probGate === null ? 'off' : 'on'}
                  onChange={(v) => set('probGate', v === 'on' ? 0.95 : null)}
                  options={[{ v: 'off', label: 'off' }, { v: 'on', label: 'on' }]} />
          {c.probGate !== null && (
            <>
              <Input value={String(Math.round(c.probGate * 1000) / 10)} aria-label="prob gate pct" className="w-20"
                     onChange={(e) => set('probGate', num(e.target.value, 95) / 100)} />
              <span className="text-[11.5px] text-muted-foreground">%</span>
            </>
          )}
        </Row>
        <Row label="double the survivor" hint="When the gate refuses one leg, sell two lots of the other.">
          <Choice value={c.doubleWhenOneSided ? 'on' : 'off'}
                  onChange={(v) => set('doubleWhenOneSided', v === 'on')}
                  options={[{ v: 'off', label: 'off' }, { v: 'on', label: 'on' }]} />
        </Row>

        {problems.length > 0 && (
          <ul className="m-0 mt-3 list-none p-0">
            {problems.map((p) => (
              <li key={p} className="text-[11.5px] leading-snug text-[var(--down)]">{p}</li>
            ))}
          </ul>
        )}

        <p className="m-0 mt-3 text-[11.5px] leading-snug text-muted-foreground">
          Saving does not arm it. A new strategy is always saved switched off.
        </p>

        <SheetFooter>
          <Button variant="outline" className="h-11 flex-none px-4" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button className="h-11 flex-1" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
