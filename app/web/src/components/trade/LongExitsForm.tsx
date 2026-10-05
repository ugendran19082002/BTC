import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { updateExits } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SheetFooter } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { inr, price, usdToInr } from '@/lib/format';

/**
 * A bought position's exits (5 Oct 2026): the mirror of a short's. The target is over the price paid, with no
 * ceiling -- a tenfold is a target -- and rests at Delta as a reduce-only sale; the stop is under it, at most all of
 * it, and is judged by the desk on the bid. The short's sheet capped the target at 99% "of the credit" and spoke of
 * liquidation, neither of which a bought option has.
 */
type Leg = { on: boolean; mode: 'pct' | 'price'; pct: string; price: string };
type Own = NonNullable<NonNullable<Trade['plan']>['longExits']>['target'];

const legOf = (own: Own | undefined, entry: number, up: boolean, fallbackPct: number): Leg => {
  if (!own || !(own.value > 0)) return { on: false, mode: 'pct', pct: String(fallbackPct * 100), price: '' };
  const level = own.mode === 'pct' ? entry * (1 + (up ? own.value : -own.value))
    : own.mode === 'points' ? entry + (up ? own.value : -own.value) : own.value;
  const share = Math.abs(level / entry - 1);
  return own.mode === 'price'
    ? { on: true, mode: 'price', pct: String(Math.round(share * 1000) / 10), price: String(own.value) }
    : { on: true, mode: 'pct', pct: String(Math.round(share * 1000) / 10), price: String(Math.round(level * 10) / 10) };
};

/** The level a leg asks for, or a problem with it. */
function levelOf(leg: Leg, entry: number, up: boolean): { level: number | null; problem: string | null } {
  if (!leg.on) return { level: null, problem: null };
  if (leg.mode === 'pct') {
    const n = Number(leg.pct);
    if (!Number.isFinite(n) || n <= 0) return { level: null, problem: 'Enter a percentage above 0.' };
    if (!up && n > 100) return { level: null, problem: 'A stop is at most 100% under the price paid: a bought option cannot lose more.' };
    if (up && n > 10_000) return { level: null, problem: 'A target over 10,000% is a typo.' };
    return { level: entry * (1 + (up ? n : -n) / 100), problem: null };
  }
  const n = Number(leg.price);
  if (!Number.isFinite(n) || n <= 0) return { level: null, problem: 'Enter a price above 0.' };
  if (up && !(n > entry)) return { level: null, problem: `The target has to be over the ${price(entry)} paid.` };
  if (!up && !(n < entry)) return { level: null, problem: `The stop has to be under the ${price(entry)} paid.` };
  return { level: n, problem: null };
}

export function LongExitsForm({ trade, onDone, onCancel }: { trade: Trade; onDone: () => void; onCancel: () => void }) {
  const entry = trade.entryAvgPrice ?? 0;
  const size = Math.abs(trade.position);
  // From the plan; and where the plan does not say (an older server) but a sale is resting, from the book -- so
  // the form never opens "off" over a target that is there, and saving it as it stands never takes one off.
  const [target, setTarget] = useState<Leg>(() => legOf(
    trade.plan?.longExits?.target ?? (trade.onBook?.target != null ? { mode: 'price', value: trade.onBook.target } : undefined),
    entry, true, 1,
  ));
  const [stop, setStop] = useState<Leg>(() => legOf(trade.plan?.longExits?.stop, entry, false, 0.5));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const t = levelOf(target, entry, true);
  const s = levelOf(stop, entry, false);
  const problem = t.problem ?? s.problem;
  const worth = (level: number | null) => (level === null ? null : usdToInr((level - entry) * size * 0.001));

  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await updateExits(trade.tradeId, {
        ...(target.on && target.mode === 'price' ? { takeProfitPrice: Number(target.price) } : { takeProfitPct: target.on ? Number(target.pct) / 100 : 0 }),
        ...(stop.on && stop.mode === 'price' ? { stopPrice: Number(stop.price) } : { stopLossPct: stop.on ? Number(stop.pct) / 100 : 0 }),
      });
      onDone();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (name: 'Target' | 'Stop', leg: Leg, set: (l: Leg) => void, level: { level: number | null; problem: string | null }, up: boolean) => {
    const w = worth(level.level);
    return (
      <div className="rounded-lg border border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <Checkbox label={<span className={cn('text-[13.5px] font-semibold', up ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{name}</span>}
                    checked={leg.on} onChange={(e) => set({ ...leg, on: e.target.checked })} aria-label={`${name.toLowerCase()} on`} />
          <div role="group" aria-label={`${name.toLowerCase()} as`} className="inline-flex overflow-hidden rounded-md border border-border text-[12px]">
            {(['pct', 'price'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={leg.mode === m} disabled={!leg.on} onClick={() => set({ ...leg, mode: m })}
                      className={cn('px-2.5 py-1 font-medium disabled:opacity-50', leg.mode === m ? 'bg-background text-foreground' : 'text-muted-foreground')}>
                {m === 'pct' ? '%' : 'Price'}
              </button>
            ))}
          </div>
        </div>
        {leg.on && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="relative w-32">
              <Input inputMode="decimal" aria-label={`${name.toLowerCase()} ${leg.mode === 'pct' ? 'percent' : 'price'}`}
                     value={leg.mode === 'pct' ? leg.pct : leg.price}
                     onChange={(e) => set(leg.mode === 'pct' ? { ...leg, pct: e.target.value } : { ...leg, price: e.target.value })}
                     className="h-10 pr-7 text-[14px] tabular-nums" />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{leg.mode === 'pct' ? '%' : ''}</span>
            </div>
            <span className="text-[12px] text-muted-foreground">
              {level.level !== null && (
                <>{leg.mode === 'pct' ? <>at <b className="tabular-nums text-foreground">{price(level.level)}</b> · </> : null}
                  <span className={up ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{up ? 'keep ' : 'lose '}{inr(Math.abs(w ?? 0))}</span> before charges</>
              )}
            </span>
          </div>
        )}
        <p className="m-0 mt-1.5 text-[11px] leading-snug text-[var(--dim)]">
          {up
            ? (leg.on ? `${leg.mode === 'pct' ? 'Over' : 'At'} the price paid, no upper limit. Rests at Delta as a sale, so it works with the desk down.` : 'Off — holds until you close it or it expires.')
            : (leg.on ? 'Under the price paid, at most 100%. The desk sells when the bid holds at it for 15 s.' : 'Off — the most it can lose is what was paid.')}
        </p>
        {level.problem && <p className="m-0 mt-1 text-[11.5px] text-[var(--down)]">{level.problem}</p>}
      </div>
    );
  };

  return (
    <>
      <div className="grid gap-2.5">
        {row('Target', target, setTarget, t, true)}
        {row('Stop', stop, setStop, s, false)}
      </div>
      <dl className="m-0 mt-3 grid gap-1 rounded-lg bg-muted px-2.5 py-2 text-[12px]">
        <div className="flex justify-between gap-3">
          <dt className="m-0 text-muted-foreground">On Delta now · target</dt>
          <dd className="m-0 tabular-nums text-foreground">{trade.onBook?.target != null ? `sell at ${price(trade.onBook.target)}` : 'none'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="m-0 text-muted-foreground">Stop</dt>
          <dd className="m-0 text-right text-foreground">{s.level !== null || trade.plan?.longExits?.stop ? 'watched by the desk, on the bid' : 'none'}</dd>
        </div>
      </dl>
      {failed && <p className="m-0 mt-2 text-[12px] text-[var(--down)]">{failed}</p>}
      <SheetFooter>
        <Button variant="outline" className="h-11 flex-none px-4" onClick={onCancel}>Cancel</Button>
        <Button className="h-11 flex-1" disabled={busy || problem !== null || entry <= 0} onClick={() => void save()}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Save exits
        </Button>
      </SheetFooter>
    </>
  );
}
