import type { TradeStatus } from '@/types/trade';
import { Card, CardTitle } from '@/components/ui/card';
import { inr, pct, signedInr, signedUsd, usd, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The money, in plain words.
 *
 * Four questions, in the order they get asked: what did I put in, what is free,
 * how is it doing, and how much of today's loss budget is left. Dollars because
 * that is what the exchange quotes in, rupees beside them because that is the
 * account -- neither should have to be converted in your head.
 *
 * It sits above the positions rather than on the Live tab, where it used to be.
 * "Can I afford this" is a question you ask before a trade; "how am I doing" is
 * one you ask after, and this card only answers the second.
 */
export function AccountCard({ status }: { status: TradeStatus | null }) {
  if (!status) return null;

  const free = status.balanceUsd;
  // What the open positions are holding. The exchange reports free margin, so
  // what is tied up is the difference from the equity below -- and equity is
  // free plus the mark-to-market on what is open.
  const unrealised = status.unrealisedPnlUsd ?? 0;
  const booked = status.realisedTodayUsd ?? 0;
  const held = status.positions.reduce((n, p) => n + Math.abs(p.size), 0);

  const budget = status.limits.maxDailyLossUsd;
  const spent = Math.max(0, -booked);
  const leftOfBudget = Math.max(0, budget - spent);
  const budgetUsed = budget > 0 ? spent / budget : 0;

  return (
    <Card>
      <CardTitle
        right={
          <span className="text-[11px] text-muted-foreground">
            {status.mode === 'live' ? 'real money' : 'paper'}
          </span>
        }
      >
        Your account
      </CardTitle>

      <dl className="m-0 grid gap-2">
        <Line
          label="free to trade with"
          usdValue={free}
          hint={`What is not already tied up in a position. Delta calls this "Available Margin".`}
        />
        <Line
          label="held against open positions"
          usdValue={heldMarginOf(status)}
          note={held > 0 ? `${held} contract${held === 1 ? '' : 's'}` : 'nothing open'}
          hint="Locked while the position is on, and returned when it closes."
        />

        <div className="my-0.5 h-px bg-border" />

        <Line
          label="open positions are up"
          usdValue={status.unrealisedPnlUsd ?? null}
          signed
          hint="Marked at the exchange's price. You have not banked it until you close."
        />
        <Line
          label="booked today"
          usdValue={status.realisedTodayUsd ?? null}
          signed
          hint="Closed trades since 05:30 IST, when the daily contract opens."
        />

        <div className="my-0.5 h-px bg-border" />

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="m-0 text-[12.5px] text-muted-foreground">today&rsquo;s loss budget</dt>
            <dd className="m-0 text-[13px] tabular-nums text-foreground">
              {usd(leftOfBudget)} <span className="text-[var(--dim)]">of {usd(budget)} left</span>
            </dd>
          </div>
          {/* The gate that stops new trades. Worth seeing before it fires. */}
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className={cn('h-full rounded-full', budgetUsed > 0.75 ? 'bg-[var(--down)]' : 'bg-[var(--warn)]')}
              style={{ width: `${Math.min(100, budgetUsed * 100)}%` }}
            />
          </div>
          {budgetUsed > 0 && (
            <p className="m-0 mt-1 text-[11px] text-muted-foreground">
              {pct(budgetUsed, 0)} used. New trades stop when it runs out.
            </p>
          )}
        </div>
      </dl>

      {unrealised !== 0 && (
        <p className="m-0 mt-2.5 text-[11.5px] text-[var(--dim)]">
          Rupees at ₹85 to the dollar, the same rate the 733-day record uses.
        </p>
      )}
    </Card>
  );
}

/**
 * What the open positions are holding, estimated.
 *
 * The exchange reports free margin rather than used, so this is worked out from
 * the leverage each trade was opened at. It is an estimate and reads as one --
 * the authority is the Delta screen.
 */
function heldMarginOf(status: TradeStatus): number | null {
  const rows = status.open.filter((t) => t.position !== 0);
  if (rows.length === 0) return 0;
  let total = 0;
  for (const t of rows) {
    const leverage = t.plan?.leverage ?? 200;
    const spot = t.live?.liquidationPrice != null && t.entryAvgPrice != null
      // room = spot x 0.5 / leverage, so spot = room x leverage / 0.5
      ? (t.live.liquidationPrice - t.entryAvgPrice) * leverage * 2
      : null;
    if (spot === null) return null;
    total += (spot / leverage) * 0.001 * Math.abs(t.position);
  }
  return total;
}

function Line({ label, usdValue, signed, note, hint }: {
  label: string;
  usdValue: number | null;
  signed?: boolean;
  note?: string;
  hint?: string;
}) {
  const rupees = usdToInr(usdValue);
  const tone = signed && usdValue ? (usdValue > 0 ? 'up' : 'down') : null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt
        className={cn('m-0 text-[12.5px] text-muted-foreground', hint && 'cursor-help underline decoration-dotted underline-offset-2')}
        title={hint}
      >
        {label}
        {note && <span className="ml-1.5 text-[11px] text-[var(--dim)]">{note}</span>}
      </dt>
      <dd className="m-0 flex items-baseline gap-2 tabular-nums">
        <span
          className={cn(
            'text-[14px] font-semibold',
            tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-foreground',
          )}
        >
          {signed ? signedUsd(usdValue) : usd(usdValue)}
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {signed ? signedInr(rupees) : inr(rupees)}
        </span>
      </dd>
    </div>
  );
}
