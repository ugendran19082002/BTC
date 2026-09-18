import type { BestTrade as BestTradeData, Leg } from '@/types/desk';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KV } from '@/components/ui/kv';
import { BestTradeSettings } from '@/components/desk/BestTradeSettings';
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
export function BestTrade({ best, legs, onSell, onSettingsChanged }: {
  best: BestTradeData;
  /** The board, so the ticket gets the real leg rather than a copy of the card. */
  legs: Leg[];
  onSell?: (leg: Leg) => void;
  /** The floor changed on the server: the board should be asked again. */
  onSettingsChanged?: () => void;
}) {
  const p = best.pick;
  const leg = p ? legs.find((l) => l.cp === p.cp && l.strike === p.strike) ?? null : null;
  const pctOf = (v: number | null | undefined, places = 1) =>
    v === null || v === undefined ? '—' : `${(v * 100).toFixed(places)}%`;

  /*
   * Two cards, one above the other: the pick and its figures, then what to do
   * about it -- the phone alert, the premium floor and the order form. The
   * controls used to sit inside the pick under a hairline, which made the card
   * the tallest on the screen and hid the button below the fold on a laptop.
   */
  const alerts = (
    <CollapsibleCard id="best-pick-alerts" title="Alerts for this pick" className="besttrade bt-alerts" ariaLabel="best pick alerts">
      {/*
        "Tell me when the pick changes" and the premium floor, above the
        ticket. Their own switch, nothing to do with the header's fill alerts.
      */}
      <BestTradeSettings onChanged={onSettingsChanged} />

      {p !== null && onSell && leg && (
        <Button
          variant="outline"
          className="mt-3 h-10 w-full"
          onClick={() => onSell(leg)}
        >
          Open the order form with this
        </Button>
      )}

      {p !== null && (
        <p className="m-0 mt-2 text-[10.5px] leading-snug text-[var(--dim)]">
          {best.agreesWithEngine
            ? 'The tested rule picked this strike too. '
            : 'The tested rule picked differently — follow the tested rule. '}
          This ranking has not been checked against past years. Nothing is sent from here;
          the order form runs every check again.
        </p>
      )}
    </CollapsibleCard>
  );

  return (
    <>
    <CollapsibleCard
      id="best-pick"
      className="besttrade"
      title="Best pick for today’s contract"
      right={
        p === null ? <Badge tone="neutral">nothing to sell</Badge>
          : best.bestOfNone ? <Badge tone="warn">None pass the checks</Badge>
            : best.agreesWithEngine
              // Clears every hard rule and the tested engine picked it too:
              // the only combination on this card that deserves the word.
              ? <Badge tone="ok">Recommended</Badge>
              : <Badge tone="warn">The tested rule picks differently</Badge>
      }
    >
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
            <div className="m-0 mb-2 rounded-md border border-solid border-[var(--warn)]/40 bg-[var(--warn-bg,transparent)] px-2.5 py-2 text-[12px] leading-snug text-[var(--warn)]">
              <p className="m-0">{best.why}</p>
              {/*
                The failures, here, where the sentence says "below" -- not ten
                rows further down under the figures. What a strike is failing is
                the reason it is not a recommendation, and that has to be read
                before the numbers make it look like one.
              */}
              {p.failing.length > 0 && (
                <ul aria-label="what it is failing" className="m-0 mt-1.5 list-none p-0 text-[11.5px] leading-snug text-[var(--down)]">
                  {p.failing.map((f) => <li key={f}>{f}</li>)}
                </ul>
              )}
            </div>
          )}

          <div className="bt-head">
            <span className={cn('bt-order', p.side === 'CE' ? 'ce' : 'pe')}>
              SELL {p.side} {fmtStrike(p.strike)}
            </span>
            <span className="bt-rank" aria-label="rank">{p.rank}<span className="dim">/100</span></span>
          </div>

          {/*
            Two columns on a desk, one on a phone. Eleven figures in one column
            ran the card to twice the height of the Market card beside it, and
            the pair are meant to be read as one row.
          */}
          <dl className="bt-figures" aria-label="the pick">
            <KV label="You’d be paid" hint="The bid — what a seller actually receives per contract. Every measured figure on this desk is built on the bid, not the mid or the mark.">
              <b>{price(p.premiumUsd)}</b>
            </KV>
            <KV label="Chance you keep it all" hint="The chance this option expires worthless, so the whole premium stays with you. Corrected by what really happened to strikes like it over 733 settlements.">
              <span className={cn(p.expiryOtm !== null && p.expiryOtm >= 0.95 ? 'up' : 'warn')}>
                {pctOf(p.expiryOtm)}
              </span>
            </KV>
            <KV label="Chance price gets there first" hint="The chance BTC reaches the strike at some point before settlement — the drawdown on the way, not a loss. Shown, never ranked on: touching is not losing.">
              <span className={cn(p.touch !== null && p.touch >= 0.5 && 'down')}>{pctOf(p.touch, 0)}</span>
            </KV>
            <KV label="Chance it collapses early" hint="The chance this option’s own price falls to about ten cents before settlement — the target filling early.">
              {pctOf(p.nearZero, 0)}
            </KV>
            <KV label="How far away, in usual moves" hint="Distance to the strike in units of today’s expected move. Under 1.0 an ordinary day reaches it.">
              {p.emBuffer === null ? '—' : `${p.emBuffer.toFixed(2)}×`}
            </KV>
            <KV label="Sensitivity to BTC" hint="Delta: how much the premium moves per dollar of BTC.">
              {p.delta === null ? '—' : p.delta.toFixed(3)}
            </KV>

            <div className="bt-figures-break" />

            <KV label="You collect" hint="For the lots on the settings bar, after Delta’s charges to open.">
              {usd(p.creditUsd)}
            </KV>
            <KV
              label={p.hedge ? 'Most you can lose (with the safety leg)' : 'Most you can lose'}
              hint={p.hedge
                ? 'The spread’s own worst case: the width, less what is kept.'
                : 'Nothing caps a naked short. Buy a hedge and this becomes a number.'}
            >
              {p.maxLossUsd === null
                ? <span className="down">no limit — no safety leg</span>
                : <span className="down">{usd(p.maxLossUsd)}</span>}
              {p.hedge && (
                <span className="block text-[11px] text-muted-foreground">
                  safety leg: buy {fmtStrike(p.hedge.strike)} at {price(p.hedge.askUsd)} · ${p.hedge.widthUsd.toLocaleString('en-IN')} apart
                </span>
              )}
            </KV>
            <KV label="Paid ÷ most you can lose" hint="What the trade collects as a share of the most it can lose. Needs a safety leg to be a number at all.">
              {p.creditRisk === null ? '—' : <b>{p.creditRisk.toFixed(2)}</b>}
            </KV>
            <KV label="How easy to trade" hint="Liquidity, 0–100: the gap between buy and sell prices, how much traded today, how many contracts are open, and how fresh the last trade is.">
              <span className={cn(p.liquidity >= 70 ? 'up' : p.liquidity >= 40 ? 'warn' : 'down')}>
                {p.liquidity}<span className="dim">/100</span>
              </span>
            </KV>
          </dl>

          <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
            Chosen on: {p.reasons.join(' · ')}.
            {best.runnersUp.length > 0 && (
              <span className="text-[var(--dim)]">
                {' '}Behind it: {best.runnersUp.map((r) => `${r.side} ${fmtStrike(r.strike)} (${r.rank})`).join(', ')}.
              </span>
            )}
          </p>
        </>
      )}
    </CollapsibleCard>
    {alerts}
    </>
  );
}
