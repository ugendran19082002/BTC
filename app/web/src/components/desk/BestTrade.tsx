import type { BestTrade as BestTradeData, Leg } from '@/types/desk';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KV } from '@/components/ui/kv';
import { price, strike as fmtStrike, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * One trade, named, with the numbers it was chosen on.
 *
 * The board ranks strikes five ways at once — score, EV, the odds, the
 * distance, the book — and left the last step to a person at half past five in
 * the morning. This card does that step.
 *
 * It replaces *Best expected value*, which ranked on one number and could not
 * say what the trade would cost if it went wrong. Expected value is still on
 * the board, per strike, where it belongs.
 *
 * **It is not the tested engine.** `recommend.ts` splits the lots by a rule
 * with 733 days behind it, and where the two disagree that one is right — so
 * the card says which it is, every time, rather than leaving a reader to infer
 * it from two numbers on one screen.
 *
 * **Touch is shown and not ranked on.** A touch is a drawdown, not a loss: a
 * day that reaches the strike and comes back settles worthless like any other.
 * Ranking on it would refuse the strike that pays for exactly the risk a seller
 * is in business to take.
 *
 * The button hands the leg to the order ticket. Nothing is sent from here; the
 * ticket runs every gate again.
 */
export function BestTrade({ best, legs, onSell }: {
  best: BestTradeData;
  /** The board, so the ticket gets the real leg rather than a copy of the card. */
  legs: Leg[];
  onSell?: (leg: Leg) => void;
}) {
  const p = best.pick;
  const leg = p ? legs.find((l) => l.cp === p.cp && l.strike === p.strike) ?? null : null;
  const pctOf = (v: number | null | undefined, places = 1) =>
    v === null || v === undefined ? '—' : `${(v * 100).toFixed(places)}%`;

  return (
    <Card className="besttrade">
      <CardTitle
        right={
          p === null ? <Badge tone="neutral">nothing to sell</Badge>
            : best.bestOfNone ? <Badge tone="warn">Nothing clears</Badge>
              : best.agreesWithEngine
                ? <Badge tone="ok">Engine agrees</Badge>
                : <Badge tone="warn">Engine differs</Badge>
        }
      >
        Best trade · this expiry
      </CardTitle>

      {p === null ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">{best.why}</p>
      ) : (
        <>
          {/*
            The morning nothing clears.
            An empty card cannot say which strike came closest or what it was
            failing, and on that morning those are the only two things worth
            knowing. So the board is ranked anyway and the card says plainly
            that this is not a recommendation.
          */}
          {best.bestOfNone && (
            <p className="m-0 mb-2 rounded-md border border-solid border-[var(--warn)]/40 bg-[var(--warn-bg,transparent)] px-2.5 py-2 text-[12px] leading-snug text-[var(--warn)]">
              {best.why}
            </p>
          )}

          <div className="bt-head">
            <span className={cn('bt-order', p.side === 'CE' ? 'ce' : 'pe')}>
              SELL {p.side} {fmtStrike(p.strike)}
            </span>
            <span className="bt-rank" aria-label="rank">{p.rank}<span className="dim">/100</span></span>
          </div>

          <dl className="m-0 mt-3 grid gap-1.5" aria-label="the pick">
            <KV label="Premium (bid)" hint="What a seller receives. Every measured figure on this desk is built on the bid.">
              <b>{price(p.premiumUsd)}</b>
            </KV>
            <KV label="Expiry OTM" hint="Where it finishes: the chance it expires worthless, corrected by 733 settlements.">
              <span className={cn(p.expiryOtm !== null && p.expiryOtm >= 0.95 ? 'up' : 'warn')}>
                {pctOf(p.expiryOtm)}
              </span>
            </KV>
            <KV label="Touch" hint="What it feels like on the way: the chance BTC reaches the strike at least once. Shown, never ranked on — touching is not losing.">
              <span className={cn(p.touch !== null && p.touch >= 0.5 && 'down')}>{pctOf(p.touch, 0)}</span>
            </KV>
            <KV label="Near-zero" hint="The chance the premium itself collapses to about ten cents before settlement — the target filling.">
              {pctOf(p.nearZero, 0)}
            </KV>
            <KV label="EM×" hint="How far the strike is, in expected moves. Under 1.0 today's expected move reaches it.">
              {p.emBuffer === null ? '—' : `${p.emBuffer.toFixed(2)}×`}
            </KV>
            <KV label="Delta" hint="How much the premium moves per dollar of BTC.">
              {p.delta === null ? '—' : p.delta.toFixed(3)}
            </KV>

            <div className="my-0.5 h-px bg-border" />

            <KV label="Credit" hint="For the lots on the settings bar, after Delta's charges to open.">
              {usd(p.creditUsd)}
            </KV>
            <KV
              label={p.hedge ? 'Max loss (with hedge)' : 'Max loss'}
              hint={p.hedge
                ? 'The spread’s own worst case: the width, less what is kept.'
                : 'Nothing caps a naked short. Buy a hedge and this becomes a number.'}
            >
              {p.maxLossUsd === null
                ? <span className="down">uncapped — no hedge</span>
                : <span className="down">{usd(p.maxLossUsd)}</span>}
              {p.hedge && (
                <span className="block text-[11px] text-muted-foreground">
                  buying {fmtStrike(p.hedge.strike)} at {price(p.hedge.askUsd)} · ${p.hedge.widthUsd.toLocaleString('en-IN')} wide
                </span>
              )}
            </KV>
            <KV label="Credit / risk" hint="What the trade is paid as a share of what it can lose. Needs a hedge to be a number at all.">
              {p.creditRisk === null ? '—' : <b>{p.creditRisk.toFixed(2)}</b>}
            </KV>
            <KV label="Liquidity" hint="Spread, turnover against open interest, depth and how fresh the last print is.">
              <span className={cn(p.liquidity >= 70 ? 'up' : p.liquidity >= 40 ? 'warn' : 'down')}>
                {p.liquidity}<span className="dim">/100</span>
              </span>
            </KV>
          </dl>

          {p.failing.length > 0 && (
            <ul aria-label="what it is failing" className="m-0 mt-2 list-none p-0 text-[11.5px] leading-snug text-[var(--down)]">
              {p.failing.map((f) => <li key={f}>{f}</li>)}
            </ul>
          )}

          <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
            Chosen on: {p.reasons.join(' · ')}.
          </p>

          {best.runnersUp.length > 0 && (
            <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]">
              Behind it:{' '}
              {best.runnersUp.map((r) => `${r.side} ${fmtStrike(r.strike)} (${r.rank})`).join(', ')}.
            </p>
          )}

          {onSell && leg && (
            <Button
              variant="outline"
              className="mt-3 h-10 w-full"
              onClick={() => onSell(leg)}
            >
              Take it to the ticket
            </Button>
          )}

          <p className="m-0 mt-2 text-[10.5px] leading-snug text-[var(--dim)]">
            {best.agreesWithEngine
              ? 'The tested engine picked this strike too.'
              : 'The tested engine picked differently — where they disagree, follow the engine: '}
            This ranking has never been through the cross-period screen. Nothing is sent from
            here; the ticket runs every gate again.
          </p>
        </>
      )}
    </Card>
  );
}
