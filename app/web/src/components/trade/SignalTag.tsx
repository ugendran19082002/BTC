import { Radio } from 'lucide-react';
import type { Trade } from '@/types/trade';
import { cn } from '@/lib/utils';

/**
 * A signal strategy's trade, said on its row: which method's signal, BUY or
 * SELL, on which timeframe (or with the timeframe chain) -- and its real exits,
 * the signal's SL and TGT on the BTC perp. Nothing for any other trade.
 */
const btc = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-US'));

export function signalWords(s: NonNullable<NonNullable<Trade['plan']>['signal']>): string {
  return `#${s.n} ${s.name} · ${s.dir === 1 ? 'BUY' : 'SELL'} · ${s.mode === 'mtf' ? '5m + TF chain' : s.tf}`;
}

export function SignalTag({ plan, className }: { plan: Trade['plan'] | undefined; className?: string }) {
  const s = plan?.signal;
  const u = plan?.underlying;
  if (!s && !u) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {s && (
        <span
          className={cn('inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-semibold',
            s.dir === 1 ? 'bg-[var(--up)]/12 text-[var(--up)]' : 'bg-[var(--down)]/12 text-[var(--down)]')}
          aria-label="signal"
          title={`Traded the TRADE signal of method #${s.n} ${s.name}, ${s.mode === 'mtf' ? 'with the timeframe chain (entry on 5m)' : `on ${s.tf}, without the chain`}: a ${s.dir === 1 ? 'BUY sells the put' : 'SELL sells the call'}.`}
        >
          <Radio size={10} aria-hidden />
          {signalWords(s)}
        </span>
      )}
      {u && (u.stop !== null || u.target !== null) && (
        <span className="rounded bg-muted px-1.5 py-px text-[10.5px] tabular-nums text-muted-foreground" aria-label="perp exits"
              title="The trade's real exits: when the BTC perp's last trade reaches either, the desk buys the option back. The option's own target and stop rest at Delta as the backstop.">
          {u.entry != null && <>perp entry <span className="text-foreground">{btc(u.entry)}</span> · </>}
          {u.entry != null ? 'SL' : 'perp SL'} <span className="text-[var(--down)]">{btc(u.stop)}</span> · TGT <span className="text-[var(--up)]">{btc(u.target)}</span>
        </span>
      )}
    </span>
  );
}
