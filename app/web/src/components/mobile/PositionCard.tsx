import { AlertOctagon, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import type { Trade, TradeStatus } from '@/types/trade';
import { Card } from '@/components/ui/card';
import { contractLabel, countdown, duration, price, signedInr, size, usdToInr } from '@/lib/format';
import { positionRisk } from '@/lib/position-risk';
import { cn } from '@/lib/utils';
import { Rupees, SidePill } from '@/components/mobile/parts';
import { ExitRail } from '@/components/mobile/ExitRail';
import { isWaiting } from '@/lib/trade-events';
import { isLongTrade } from '@/lib/long-exits';
import { PlacedLine } from '@/components/mobile/StrategyTag';

/**
 * One open position, read only: what is wrong with it first, then entry, price now and P&L, then where the price
 * stands between the stop and the target, drawn and moving (ExitRail) -- the BTC perp's line for a signal trade,
 * whose real exits are there, and the option's own line only when the option has a stop or a target of its own --
 * then liquidation, settlement, how long it has been held and what opened it -- the strategy as a tag under the
 * contract (`StrategyTag`), with the signal and the account beside it. No trading button: the phone's
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
  if (isWaiting(trade)) return <WaitingCard trade={trade} now={now} showAccount={showAccount} onOpen={onOpen} />;
  const r = positionRisk(trade, { alarms, perpMark });
  const pnl = trade.live?.netIfClosedUsd ?? trade.live?.unrealisedPnl ?? null;
  const entry = trade.entryAvgPrice;
  const firstFill = trade.fills.filter((f) => f.role === 'entry').reduce<number | null>((m, f) => (m === null || f.ts < m ? f.ts : m), null);
  const signal = trade.plan?.signal ? `#${trade.plan.signal.n} ${trade.plan.signal.name} · ${trade.plan.signal.tf}` : null;

  const nearLiq = r.liquidation?.multiple != null && r.liquidation.multiple < 3;
  const hasPerpRail = Boolean(r.perp && (r.perp.stop !== null || r.perp.target !== null));

  const head = (
    <span className="flex w-full items-center gap-1.5">
      <span className="truncate text-[16px] font-semibold">{contractLabel(trade.symbol)}</span>
      <SidePill long={r.long} />
      <span className="text-[12.5px] text-muted-foreground">× {size(trade.position)}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Rupees usd={pnl} signed size="sm" />
        {onOpen && <ChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground" />}
      </span>
    </span>
  );

  return (
    <Card className={cn('!p-3', r.problems.length > 0 && 'border-[var(--down)]')}>
      {r.problems.length > 0 && (
        <div role="alert" className="mb-2 flex gap-2 rounded-md bg-[var(--down-bg)] px-2.5 py-1.5 text-[13px] leading-snug text-[#ffb3ae]">
          <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--down)]" aria-hidden="true" />
          <span>{r.problems.join(' ')}</span>
        </div>
      )}

      {onOpen
        ? <button type="button" onClick={onOpen} aria-label={`${contractLabel(trade.symbol)}: what happened`} className="-my-[6px] flex min-h-[36px] items-center border-0 bg-transparent p-0 text-left font-[inherit] text-foreground">{head}</button>
        : head}
      {/* Who placed it: the strategy as a tag, first, then the signal and the account. */}
      <PlacedLine plan={trade.plan} rest={[signal, showAccount && trade.account ? trade.account.name : null]} className="mt-0.5" />

      {/* Entry, what leaving costs now, and the mark: one line, where three boxes made the card a screen tall. */}
      <dl className="m-0 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] tabular-nums">
        <Inline k="Entry" v={price(entry)} />
        <Inline k={r.long ? 'Bid' : 'Ask'} v={price(r.exitPx)} strong />
        <Inline k="Mark" v={price(trade.live?.markPrice)} />
      </dl>

      <div className="mt-2.5 flex flex-col gap-2.5">
        {hasPerpRail && (
          <ExitRail
            title="BTC perp" entry={r.perp!.entry} target={r.perp!.target} stop={r.perp!.stop} current={perpMark}
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
              <div className="flex justify-between gap-2 text-[11.5px] tabular-nums text-muted-foreground">
                <span>{r.target?.moneyUsd != null ? <>TGT leaves <b className={moneyTone(r.target.moneyUsd)}>{signedInr(usdToInr(r.target.moneyUsd))}</b></> : ''}</span>
                <span>{r.stop?.moneyUsd != null ? <>SL leaves <b className={moneyTone(r.stop.moneyUsd)}>{signedInr(usdToInr(r.stop.moneyUsd))}</b></> : ''}</span>
              </div>
            )}
          </div>
        )}
        {!r.stop && !r.target && !hasPerpRail && (
          <p className="m-0 text-[13px] text-muted-foreground">No stop and no target on this position.</p>
        )}
      </div>

      {/* The rest, a tap away: what is read once in a while, not at every glance. Near liquidation it is said anyway. */}
      <details className="group mt-2 border-t border-[var(--line-soft)] pt-1">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 text-[12px] text-muted-foreground [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 items-center gap-1 truncate">
            {firstFill !== null && <><Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> held {duration(now - firstFill)}</>}
            {nearLiq && <b className="ml-1 text-[var(--down)]">· liquidation {r.liquidation!.multiple!.toFixed(1)}× now</b>}
          </span>
          <span className="flex shrink-0 items-center gap-0.5">Details <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" /></span>
        </summary>
        <dl className="m-0 flex flex-col divide-y divide-[var(--line-soft)]">
          <Line label="Bid / Ask">{price(trade.live?.bid)} / {price(trade.live?.ask)}</Line>
          {r.liquidation && (
            <Line label="Liquidation">
              <span className={cn(nearLiq && 'font-semibold text-[var(--down)]')}>{price(r.liquidation.level)}</span>
              {r.liquidation.multiple !== null && <span className="text-muted-foreground"> · {r.liquidation.multiple.toFixed(1)}× now</span>}
            </Line>
          )}
          {r.settlesAt !== null && <Line label="Settles 17:30 IST">{countdown(r.settlesAt, now)}</Line>}
        </dl>
      </details>
    </Card>
  );
}

/**
 * An order sent and not filled yet: what it is, at what price it rests and for how long -- amber, with a dot that
 * breathes, so a waiting order is never taken for a position that is running.
 */
function WaitingCard({ trade, now, showAccount, onOpen }: { trade: Trade; now: number; showAccount: boolean; onOpen?: () => void }) {
  const long = isLongTrade(trade);
  const limit = trade.plan?.entry.limitPrice ?? null;
  const signal = trade.plan?.signal ? `#${trade.plan.signal.n} ${trade.plan.signal.name}` : null;
  const body = (
    <span className="block w-full">
      <span className="flex w-full items-center gap-1.5">
        <span className="truncate text-[16px] font-semibold">{contractLabel(trade.symbol)}</span>
        <SidePill long={long} />
        <span className="text-[12.5px] text-muted-foreground">× {size(trade.requestedSize)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded bg-[var(--warn-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--warn)]">
          <span aria-hidden="true" className="m-breathe h-2 w-2 rounded-full bg-[var(--warn)]" /> WAITING
        </span>
        {onOpen && <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </span>
      <span className="mt-0.5 block truncate text-[12.5px] tabular-nums text-muted-foreground">
        {limit !== null ? <>Resting at <b className="text-foreground">{price(limit)}</b></> : 'At market'}
        {' · '}sent {duration(Math.max(0, now - trade.updatedAt))} ago
      </span>
      <PlacedLine plan={trade.plan} rest={[signal, showAccount && trade.account ? trade.account.name : null]} className="mt-1" />
    </span>
  );
  return (
    <Card className="!p-3 border-[color-mix(in_srgb,var(--warn)_45%,transparent)]">
      {onOpen
        ? <button type="button" onClick={onOpen} aria-label={`${contractLabel(trade.symbol)}, waiting to fill: what happened`} className="flex w-full border-0 bg-transparent p-0 text-left font-[inherit] text-foreground">{body}</button>
        : body}
    </Card>
  );
}

const whole = (n: number) => Math.round(n).toLocaleString('en-US');
const moneyTone = (usd: number) => (usd > 0 ? 'text-[var(--up)]' : usd < 0 ? 'text-[var(--down)]' : 'text-foreground');

function Inline({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn('m-0', strong ? 'font-semibold text-foreground' : 'text-foreground')}>{v}</dd>
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
