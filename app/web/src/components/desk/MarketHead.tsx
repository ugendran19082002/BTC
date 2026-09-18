import type { MarketRead, SnapshotMeta } from '@/types/desk';
import { Stat } from '@/components/ui/stat';
import { istLabel } from '@/lib/format';
import { cn } from '@/lib/utils';

/** "76,232.9": the price the way it is read aloud, one decimal. */
const spotText = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * The head of the Market card: BTC and its price on the left, the contract's
 * four facts on the right.
 *
 * The price used to be a bare "76351.4" over four rows that ran the full width
 * of the card, with the ATM strike a divider away from the rest. Here the price
 * carries its 24-hour change -- the one thing a bare price cannot say -- and the
 * facts sit beside it as one block, so the card reads in a single glance.
 *
 * The 24-hour change is the same `return24h` the BTC summary beside the chart
 * shows, so the two cannot disagree.
 */
export function MarketHead({ snap, market }: { snap: SnapshotMeta; market: MarketRead | null }) {
  const change = market?.return24h ?? null;
  const changeUsd = change === null ? null : snap.spot - snap.spot / (1 + change / 100);
  const left = snap.hoursToExpiry < 48
    ? `${snap.hoursToExpiry.toFixed(1)}h left`
    : `${(snap.hoursToExpiry / 24).toFixed(0)} days left`;

  return (
    <div className="mkt-head">
      <div className="mkt-price">
        <span className="btc-logo lg" aria-hidden>₿</span>
        <div className="min-w-0">
          <div className="mkt-pair"><b>BTC</b> / USD</div>
          <div className="mkt-spot" aria-label="spot">{spotText(snap.spot)}</div>
          {change !== null && changeUsd !== null && (
            <div className={cn('mkt-change', change >= 0 ? 'up' : 'down')} aria-label="24 hour change">
              {change >= 0 ? '+' : '−'}{Math.round(Math.abs(changeUsd)).toLocaleString('en-US')}{' '}
              {change >= 0 ? '+' : '−'}{Math.abs(change).toFixed(2)}% <small>(24h)</small>
            </div>
          )}
        </div>
      </div>

      <div className="mkt-facts">
        <Stat label="Settles" value={istLabel(snap.expiryTs)} />
        <Stat label="Contract" value={`${snap.expiry} · ${left}`} tone="dim" />
        <Stat label="As of" value={istLabel(snap.ts)} tone="dim" />
        <Stat label="ATM strike" value={snap.atm.toLocaleString('en-US')} />
      </div>
    </div>
  );
}
