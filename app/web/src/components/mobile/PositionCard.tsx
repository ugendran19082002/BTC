import { AlertOctagon, ChevronRight, Clock } from 'lucide-react';
import type { Trade, TradeStatus } from '@/types/trade';
import { Card } from '@/components/ui/card';
import { contractLabel, countdown, duration, price, signedInr, size, usdToInr } from '@/lib/format';
import { positionRisk } from '@/lib/position-risk';
import { cn } from '@/lib/utils';
import { Rupees, SidePill } from '@/components/mobile/parts';
import { ExitRail } from '@/components/mobile/ExitRail';

/**
 * One open position, read only: what is wrong with it first, then entry, price now and P&L, then where the price
 * stands between the stop and the target, drawn and moving (ExitRail) -- the BTC perp's line for a signal trade,
 * whose real exits are there, and the option's own line only when the option has a stop or a target of its own --
 * then liquidation, settlement, how long it has been held and what opened it. No trading button: the phone's
 * session could not use one, and a screen that offers what it cannot do is lying.
 */
export function PositionCard({ trade, alarms, perpMark, perpLive = false, now, showAccount, onOpen }: {
  trade: Trade;
  alarms: TradeStatus['alarms'];
  perpMark: number | null;
  /** The perp's price is arriving as it prints. */
  perpLive?: boolean;
  now: number;
  showAccount: boolean;
  /** Open the trade's whole journal. */
  onOpen?: () => void;
}) {
  const r = positionRisk(trade, { alarms, perpMark });
  const pnl = trade.live?.netIfClosedUsd ?? trade.live?.unrealisedPnl ?? null;
  const entry = trade.entryAvgPrice;
  const firstFill = trade.fills.filter((f) => f.role === 'entry').reduce<number | null>((m, f) => (m === null || f.ts < m ? f.ts : m), null);
  const by = trade.plan?.signal ? `#${trade.plan.signal.n} ${trade.plan.signal.name} · ${trade.plan.signal.tf}` : trade.plan?.strategyName ?? null;

  const head = (
    <span className="flex w-full items-center gap-1.5">
      <span className="truncate text-[17px] font-semibold">{contractLabel(trade.symbol)}</span>
      <SidePill long={r.long} />
      <span className="text-[13px] text-muted-foreground">× {size(trade.position)}</span>
      {onOpen && <ChevronRight aria-hidden="true" className="ml-auto h-5 w-5 shrink-0 text-muted-foreground" />}
    </span>
  );

  return (
    <Card className={cn(r.problems.length > 0 && 'border-[var(--down)]')}>
      {r.problems.length > 0 && (
        <div role="alert" className="mb-3 flex gap-2 rounded-md bg-[var(--down-bg)] px-3 py-2 text-[13.5px] leading-snug text-[#ffb3ae]">
          <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--down)]" aria-hidden="true" />
          <span>{r.problems.join(' ')}</span>
        </div>
      )}

      {onOpen
        ? <button type="button" onClick={onOpen} aria-label={`${contractLabel(trade.symbol)}: what happened`} className="flex border-0 bg-transparent p-0 text-left font-[inherit] text-foreground">{head}</button>
        : head}
      {(showAccount && trade.account) || by ? (
        <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
          {[showAccount && trade.account ? trade.account.name : null, by, trade.plan?.signal && trade.plan.strategyName ? trade.plan.strategyName : null].filter(Boolean).join(' · ')}
        </div>
      ) : null}

      <dl className="m-0 mt-3 grid grid-cols-3 gap-2">
        <Fig label="Entry">{price(entry)}</Fig>
        <Fig label={r.long ? 'Bid now' : 'Ask now'}>{price(r.exitPx)}</Fig>
        <Fig label="P&L"><Rupees usd={pnl} signed size="sm" /></Fig>
      </dl>

      <div className="mt-3 flex flex-col gap-3">
        {r.perp && (r.perp.stop !== null || r.perp.target !== null) && (
          <ExitRail
            title="BTC perp" entry={r.perp.entry} target={r.perp.target} stop={r.perp.stop} current={perpMark}
            fmt={whole} nowLabel="last" live={perpLive}
          />
        )}
        {(r.stop || r.target) && (
          <div>
            <ExitRail
              title="Option" entry={entry} target={r.target?.level ?? null} stop={r.stop?.level ?? null} current={r.exitPx}
              fmt={(n) => price(n)} nowLabel={r.long ? 'bid' : 'ask'}
            />
            {(r.target?.moneyUsd != null || r.stop?.moneyUsd != null) && (
              <div className="mt-1 flex justify-between gap-2 text-[11.5px] tabular-nums text-muted-foreground">
                <span>{r.target?.moneyUsd != null ? <>TGT leaves <b className={moneyTone(r.target.moneyUsd)}>{signedInr(usdToInr(r.target.moneyUsd))}</b></> : ''}</span>
                <span>{r.stop?.moneyUsd != null ? <>SL leaves <b className={moneyTone(r.stop.moneyUsd)}>{signedInr(usdToInr(r.stop.moneyUsd))}</b></> : ''}</span>
              </div>
            )}
          </div>
        )}
        {!r.stop && !r.target && !(r.perp && (r.perp.stop !== null || r.perp.target !== null)) && (
          <p className="m-0 text-[13px] text-muted-foreground">No stop and no target on this position.</p>
        )}
      </div>

      <dl className="m-0 mt-2 flex flex-col divide-y divide-[var(--line-soft)]">
        <Line label="Bid / Ask">{price(trade.live?.bid)} / {price(trade.live?.ask)}</Line>
        {r.liquidation && (
          <Line label="Liquidation">
            <span className={cn(r.liquidation.multiple !== null && r.liquidation.multiple < 3 && 'font-semibold text-[var(--down)]')}>{price(r.liquidation.level)}</span>
            {r.liquidation.multiple !== null && <span className="text-muted-foreground"> · {r.liquidation.multiple.toFixed(1)}× now</span>}
          </Line>
        )}
        {r.settlesAt !== null && <Line label="Settles 17:30 IST">{countdown(r.settlesAt, now)}</Line>}
      </dl>
      {firstFill !== null && (
        <div className="mt-1.5 flex items-center justify-end gap-1 text-[12.5px] text-muted-foreground">
          <Clock aria-hidden="true" className="h-3.5 w-3.5" /> Held {duration(now - firstFill)}
        </div>
      )}
    </Card>
  );
}

const whole = (n: number) => Math.round(n).toLocaleString('en-US');
const moneyTone = (usd: number) => (usd > 0 ? 'text-[var(--up)]' : usd < 0 ? 'text-[var(--down)]' : 'text-foreground');

function Fig({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md bg-muted px-2.5 py-2">
      <dt className="truncate text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="m-0 truncate text-[15px] font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 text-right text-[13.5px] tabular-nums">{children}</dd>
    </div>
  );
}
