import { cn } from '@/lib/utils';
import type { EntryPlan } from '@/types/entry';

/**
 * Where the live price is against a TRADE's levels, on every tick: the
 * perpetual's last trade (the stream's `ltp`, ~0.1 s) against the entry zone,
 * the stop and TP1, in points. The signal itself comes from closed candles;
 * this only says where the market is now.
 */

export type LivePlace = 'above' | 'in' | 'below' | 'past-sl' | 'tp1';

/**
 * Where `price` sits for a trade in `dir`. Long: above the zone is still to
 * come down, in the zone is the fill, below it the stop still holds until it
 * does not. Short, the mirror. Past TP1 is TP1.
 */
export function placeOf(price: number, p: Pick<EntryPlan, 'entryLo' | 'entryHi' | 'stop' | 'tp1'>, dir: 'long' | 'short'): LivePlace {
  if (dir === 'long') {
    if (price <= p.stop) return 'past-sl';
    if (price >= p.tp1) return 'tp1';
    if (price > p.entryHi) return 'above';
    return price >= p.entryLo ? 'in' : 'below';
  }
  if (price >= p.stop) return 'past-sl';
  if (price <= p.tp1) return 'tp1';
  if (price < p.entryLo) return 'below';
  return price <= p.entryHi ? 'in' : 'above';
}

const fmt = (v: number) => Math.round(v).toLocaleString('en-US');

export function LiveStrip({ plan, dir, ltp, now = Date.now() }: {
  plan: EntryPlan;
  dir: 'long' | 'short';
  /** The last trade; null with the stream down. */
  ltp: { price: number; at: number } | null;
  now?: number;
}) {
  if (!ltp) {
    return <p className="mx-2 mb-1.5 mt-0 text-[11px] text-muted-foreground">Live price unavailable -- the stream is down; levels as above.</p>;
  }
  const fill = dir === 'long' ? plan.entryHi : plan.entryLo;
  const place = placeOf(ltp.price, plan, dir);
  const toEntry = Math.abs(ltp.price - fill);
  const toStop = Math.abs(ltp.price - plan.stop);
  const toTp1 = Math.abs(plan.tp1 - ltp.price);
  const fresh = now - ltp.at <= 5_000;
  // How far outside the zone, from its nearest edge -- not the fill, which for a short above it is the far edge.
  const out = place === 'above' ? ltp.price - plan.entryHi : place === 'below' ? plan.entryLo - ltp.price : 0;
  const chip: Record<LivePlace, { text: string; cls: string }> = {
    // Which side of the zone, and which way that is: toward the fill, or toward the stop.
    above: dir === 'long'
      ? { text: `${fmt(out)} pts above the zone · waiting for it to come down`, cls: 'bg-muted text-foreground' }
      : { text: `${fmt(out)} pts above the zone · toward the SL`, cls: 'bg-[rgba(226,80,79,0.18)] text-[var(--down)]' },
    below: dir === 'long'
      ? { text: `${fmt(out)} pts under the zone · toward the SL`, cls: 'bg-[rgba(226,80,79,0.18)] text-[var(--down)]' }
      : { text: `${fmt(out)} pts under the zone · waiting for it to come up`, cls: 'bg-muted text-foreground' },
    in: { text: 'IN THE ENTRY ZONE', cls: 'bg-[var(--series)] text-[var(--accent-ink)]' },
    'past-sl': { text: 'PAST THE STOP', cls: 'bg-[#e2504f] text-white' },
    tp1: { text: 'AT / PAST TP1', cls: 'bg-[#26a17b] text-white' },
  };
  return (
    <div aria-label="live price" className="mx-2 mb-1.5 rounded border border-border px-2 py-1 text-[11.5px] tabular-nums">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className={cn('mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle', fresh ? 'bg-[var(--up)]' : 'bg-[var(--warn)]')} aria-hidden />
          LTP <b>{ltp.price.toLocaleString('en-US', { maximumFractionDigits: 1 })}</b>
        </span>
        <span className={cn('rounded px-1.5 py-px text-[10.5px] font-bold', chip[place].cls)}>{chip[place].text}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-muted-foreground">
        <span>to entry <b className="text-[var(--series)]">{fmt(toEntry)}</b> pts</span>
        <span>to SL <b className="text-[var(--down)]">{fmt(toStop)}</b> pts</span>
        <span>to TP1 <b className="text-[var(--up)]">{fmt(toTp1)}</b> pts</span>
      </div>
    </div>
  );
}
