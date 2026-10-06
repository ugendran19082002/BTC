import { AlertOctagon, ChevronRight, Clock } from 'lucide-react';
import type { Trade, TradeStatus } from '@/types/trade';
import { Card } from '@/components/ui/card';
import { contractLabel, countdown, duration, pct, price, signedInr, size, usdToInr } from '@/lib/format';
import { positionRisk, type ExitRoom } from '@/lib/position-risk';
import { cn } from '@/lib/utils';
import { Bar, Rupees, SidePill } from '@/components/mobile/parts';

/**
 * One open position, read only: what is wrong with it first, then entry, price now and P&L, then how far it has
 * gone toward its stop and its target -- each a bar, with the level, the points left and what it would leave --
 * then liquidation, settlement, how long it has been held and what opened it. No trading button: the phone's
 * session could not use one, and a screen that offers what it cannot do is lying.
 */
export function PositionCard({ trade, alarms, perpMark, now, showAccount, onOpen }: {
  trade: Trade;
  alarms: TradeStatus['alarms'];
  perpMark: number | null;
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

      <div className="mt-3 flex flex-col gap-2.5">
        <ExitBar kind="SL" room={r.stop} entry={entry} empty={r.perp?.stop ? 'on the BTC perp, below' : 'no stop'} />
        <ExitBar kind="TGT" room={r.target} entry={entry} empty={r.perp?.target ? 'on the BTC perp, below' : 'no target'} />
      </div>

      <dl className="m-0 mt-2 flex flex-col divide-y divide-[var(--line-soft)]">
        {r.perp && (
          <Line label="BTC perp">
            {r.perp.stop !== null && <div>SL {Math.round(r.perp.stop).toLocaleString('en-US')}{r.perp.toStop !== null && <span className="text-muted-foreground"> · {pts(r.perp.toStop)} away</span>}</div>}
            {r.perp.target !== null && <div>TGT {Math.round(r.perp.target).toLocaleString('en-US')}{r.perp.toTarget !== null && <span className="text-muted-foreground"> · {pts(r.perp.toTarget)} to go</span>}</div>}
          </Line>
        )}
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

const pts = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n) >= 100 ? Math.round(Math.abs(n)).toLocaleString('en-US') : Math.abs(n).toFixed(2)} pts`;

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

/**
 * How far the price has gone from the entry toward one exit: the bar fills as it nears, red for the stop and
 * green for the target; the level, the points still between, and what filling there would leave.
 */
function ExitBar({ kind, room, entry, empty }: { kind: 'SL' | 'TGT'; room: ExitRoom | null; entry: number | null; empty: string }) {
  if (!room) {
    return (
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-semibold text-muted-foreground">{kind}</span>
        <span className={cn(kind === 'SL' && empty === 'no stop' ? 'font-semibold text-[var(--down)]' : 'text-muted-foreground')}>{empty}</span>
      </div>
    );
  }
  const through = Number.isFinite(room.points) && room.points <= 0;
  const span = entry !== null ? Math.abs(room.level - entry) : 0;
  const gone = span > 0 && Number.isFinite(room.points) ? 1 - room.points / span : through ? 1 : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px] tabular-nums">
        <span className="min-w-0 truncate">
          <b className={kind === 'SL' ? 'text-[var(--down)]' : 'text-[var(--up)]'}>{kind}</b> {price(room.level)}
          <span className="text-muted-foreground">
            {' · '}{through ? 'price is through it' : Number.isFinite(room.points) ? `${pts(room.points)}${room.pct !== null ? ` (${pct(room.pct, 0)})` : ''}` : ''}
          </span>
        </span>
        {room.moneyUsd !== null && (
          <span className={cn('shrink-0 whitespace-nowrap', room.moneyUsd > 0 ? 'text-[var(--up)]' : room.moneyUsd < 0 ? 'text-[var(--down)]' : '')}>{signedInr(usdToInr(room.moneyUsd))}</span>
        )}
      </div>
      <Bar value={gone} tone={kind === 'SL' ? 'down' : 'up'} label={`${kind === 'SL' ? 'Stop' : 'Target'}: ${Math.round(Math.min(1, Math.max(0, gone)) * 100)}% of the way from the entry`} />
    </div>
  );
}
