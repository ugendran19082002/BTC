import { AlertOctagon } from 'lucide-react';
import type { Trade, TradeStatus } from '@/types/trade';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { contractLabel, countdown, pct, price, signedInr, size, usdToInr } from '@/lib/format';
import { positionRisk, type ExitRoom } from '@/lib/position-risk';
import { cn } from '@/lib/utils';

/**
 * One open position, read only: what is wrong with it first, then what it makes, then how far each exit is and
 * what it would leave, liquidation, and the time to settlement. No buttons: the phone's session could not use
 * them, and a screen that offers what it cannot do is lying.
 */
export function PositionCard({ trade, alarms, perpMark, now, showAccount }: {
  trade: Trade;
  alarms: TradeStatus['alarms'];
  perpMark: number | null;
  now: number;
  showAccount: boolean;
}) {
  const r = positionRisk(trade, { alarms, perpMark });
  const pnl = trade.live?.netIfClosedUsd ?? trade.live?.unrealisedPnl ?? null;
  const side = r.long ? 'BUY' : 'SELL';
  return (
    <Card className={cn(r.problems.length > 0 && 'border-[var(--down)]')}>
      {r.problems.length > 0 && (
        <div role="alert" className="mb-3 flex gap-2 rounded-md bg-[var(--down-bg)] px-3 py-2 text-[13.5px] leading-snug text-[#ffb3ae]">
          <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--down)]" aria-hidden="true" />
          <span>{r.problems.join(' ')}</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[17px] font-semibold">{contractLabel(trade.symbol)}</span>
            <span className={cn(
              'rounded px-1.5 py-0.5 text-[11px] font-semibold',
              r.long ? 'bg-[var(--up-bg)] text-[var(--up)]' : 'bg-[var(--down-bg)] text-[var(--down)]',
            )}>
              {side}
            </span>
          </div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">
            {size(trade.position)} contracts · in at {price(trade.entryAvgPrice)}
            {showAccount && trade.account ? ` · ${trade.account.name}` : ''}
            {trade.plan?.strategyName ? ` · ${trade.plan.strategyName}` : ''}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11.5px] text-muted-foreground">If closed now</div>
          <Money value={pnl} signed strong />
        </div>
      </div>

      <Rail risk={r} />

      <dl className="m-0 mt-3 flex flex-col divide-y divide-[var(--line-soft)]">
        <Row label="Stop (SL)" room={r.stop} ahead="away" empty={r.perp?.stop ? 'on the BTC perp (below)' : 'none'} danger />
        <Row label="Target (TGT)" room={r.target} ahead="to go" empty={r.perp?.target ? 'on the BTC perp (below)' : 'none'} />
        {r.perp && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">BTC perp</dt>
            <dd className="m-0 text-right text-[13px] tabular-nums">
              {r.perp.stop !== null && <div>SL {Math.round(r.perp.stop).toLocaleString('en-US')}{r.perp.toStop !== null && <span className="text-muted-foreground"> · {pts(r.perp.toStop)} away</span>}</div>}
              {r.perp.target !== null && <div>TGT {Math.round(r.perp.target).toLocaleString('en-US')}{r.perp.toTarget !== null && <span className="text-muted-foreground"> · {pts(r.perp.toTarget)} to go</span>}</div>}
            </dd>
          </div>
        )}
        {r.liquidation && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">Liquidation</dt>
            <dd className={cn('m-0 text-right text-[14px] tabular-nums', r.liquidation.multiple !== null && r.liquidation.multiple < 3 && 'font-semibold text-[var(--down)]')}>
              {price(r.liquidation.level)}
              {r.liquidation.multiple !== null && <span className="text-muted-foreground"> · {r.liquidation.multiple.toFixed(1)}× the price now</span>}
            </dd>
          </div>
        )}
        {r.settlesAt !== null && (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">Settles 17:30 IST</dt>
            <dd className="m-0 text-[14px] tabular-nums">{countdown(r.settlesAt, now)}</dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

const pts = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n) >= 100 ? Math.round(Math.abs(n)).toLocaleString('en-US') : Math.abs(n).toFixed(2)} pts`;

function Row({ label, room, ahead, empty, danger = false }: { label: string; room: ExitRoom | null; ahead: string; empty: string; danger?: boolean }) {
  const through = room !== null && Number.isFinite(room.points) && room.points <= 0;
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">{label}</dt>
      <dd className="m-0 text-right tabular-nums">
        {room === null ? (
          <span className="text-[13px] text-muted-foreground">{empty}</span>
        ) : (
          <>
            <div className="text-[14px]">
              <b>{price(room.level)}</b>
              {Number.isFinite(room.points) && (
                <span className={cn('text-muted-foreground', through && danger && 'font-semibold text-[var(--down)]')}>
                  {' · '}{through ? 'price is through it' : `${pts(room.points)} ${ahead}`}{!through && room.pct !== null ? ` (${pct(room.pct, 0)})` : ''}
                </span>
              )}
            </div>
            {room.moneyUsd !== null && (
              <div className="text-[12px] text-muted-foreground">
                would leave <span className={room.moneyUsd > 0 ? 'text-[var(--up)]' : room.moneyUsd < 0 ? 'text-[var(--down)]' : ''}>{signedInr(usdToInr(room.moneyUsd))}</span>
              </div>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

/**
 * Where the price stands between the target and the stop: the target at the left, the stop at the right, the
 * marker the price leaving costs. Read at a glance -- a marker near the right edge is a stop about to fill.
 */
function Rail({ risk }: { risk: ReturnType<typeof positionRisk> }) {
  const { stop, target, exitPx } = risk;
  if (!stop || !target || exitPx === null || stop.level === target.level) return null;
  const f = Math.min(1, Math.max(0, (exitPx - target.level) / (stop.level - target.level)));
  const colour = f >= 0.75 ? 'var(--down)' : f >= 0.5 ? 'var(--warn)' : 'var(--up)';
  return (
    <div className="mt-3" role="img" aria-label={`Price ${price(exitPx)}: ${Math.round(f * 100)}% of the way from the target to the stop`}>
      <div className="relative h-2 rounded-full bg-gradient-to-r from-[var(--up-bg)] via-[var(--panel-3)] to-[var(--down-bg)]">
        <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--bg)]" style={{ left: `${f * 100}%`, background: colour }} />
      </div>
      <div className="mt-1 flex justify-between text-[11.5px] text-muted-foreground tabular-nums">
        <span>TGT {price(target.level)}</span>
        <span>now {price(exitPx)}</span>
        <span>SL {price(stop.level)}</span>
      </div>
    </div>
  );
}
