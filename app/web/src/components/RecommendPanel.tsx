import type { MarketRead, Recommendation } from '../types';
import { Note } from './ui/card';
import { CollapsibleCard } from './ui/collapsible-card';
import { Stat, StatDivider } from './ui/stat';
import { Badge } from './ui/badge';

const pct = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%';

/** Green above 97, amber 90–97, red below. The bands the data splits on. */
function tone(p: number | null) {
  if (p === null) return 'dim' as const;
  if (p >= 0.97) return 'up' as const;
  if (p >= 0.9) return 'warn' as const;
  return 'down' as const;
}

/**
 * What to sell, in as few words as possible.
 *
 * The big number is the one that matters: how often strikes like this one
 * actually expired worthless. Everything below it is the working.
 */
export function RecommendPanel({
  rec,
  market,
  minPremium,
  usdinr,
}: {
  rec: Recommendation;
  market: MarketRead | null;
  minPremium: number;
  usdinr: number;
}) {
  if (!rec.ok) {
    return (
      <CollapsibleCard id="sell" title="What to sell">
        <p className="m-0 text-[13.5px] text-foreground">{rec.why}</p>
        <Note>
          Sitting out is a decision too. The days with nothing cheap on the board
          were often the days that moved.
        </Note>
      </CollapsibleCard>
    );
  }

  const naked = rec.totalMaxLossUsd === null;
  // The reasoning behind the split, and the market read it was taken from,
  // moved out of the card body and onto the line they explain. Hovering "lots"
  // still gets you the whole argument; it no longer costs eight lines of prose
  // under numbers you have already read.
  const whySplit = [
    rec.splitReason,
    market &&
      `Market now: ${market.regime}` +
        (market.return24h !== null
          ? `, ${market.return24h >= 0 ? 'up' : 'down'} ${Math.abs(market.return24h).toFixed(2)}% today`
          : '') +
        '. ' + market.timeframes.map((t) => `${t.tf} ${t.label}`).join(' · ') + '.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return (
    <CollapsibleCard
      id="sell"
      title="What to sell"
      right={
        <Badge tone="neutral">
          {rec.mode === 'safety'
            ? `≥ $${minPremium} and ≥ ${(rec.safetyBar * 100).toFixed(1)}% safe`
            : `premium ≥ $${minPremium}`}
        </Badge>
      }
    >

      {rec.sides.length === 1 && (
        <Note tone="warn">
          Only the {rec.sides[0]!.side} side has a strike clearing both bars today, so
          the whole position goes there. That is the normal case in this mode, not a
          failure — most qualifying days are one-sided, and skipping them cuts the
          number of tradeable days by more than half.
        </Note>
      )}

      {/*
        Two legs, two columns -- puts left, calls right, the way an option chain
        is laid out everywhere. Stacked one above the other they read as a
        sequence, as though the second were a follow-up to the first; side by
        side they read as what they are, one position with two halves.
        One qualifying side keeps the full width rather than leaving a hole.
      */}
      <div className={rec.sides.length > 1 ? 'grid gap-2.5 md:grid-cols-2' : ''}>
      {[...rec.sides].sort((a, b) => (a.side === 'PE' ? -1 : 1) - (b.side === 'PE' ? -1 : 1)).map((s) => (
        <div key={s.side} className="mb-2.5 rounded-md border border-border bg-[var(--bg)] p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[15px]">
            <span className={s.side === 'CE' ? 'text-[var(--ce)]' : 'text-[var(--pe)]'}>
              {s.side}
            </span>
            <b>{s.leg.strike.toLocaleString()}</b>
            <span className="text-[var(--dim)]">×{s.lots} lots</span>
            {/*
              The ticket price is the offer, not the bid. Hitting the bid fills
              you now at the lower number; posting at the ask joins the offer and
              pays the higher one when it fills. Both are shown because they are
              two different trades, and every measured figure below is built on
              the bid -- the conservative one.
            */}
            <span className="ml-auto">
              @ {(s.askPrice ?? s.price).toFixed(2)}
              {s.askPrice !== null && s.askPrice !== s.price && (
                <span className="ml-1.5 text-[11.5px] text-[var(--dim)]">ask</span>
              )}
            </span>
          </div>
          {s.hedgeOrder && (
            <div className="mt-1 font-mono text-[12.5px] text-muted-foreground">{s.hedgeOrder}</div>
          )}

          <div className="mt-2.5 flex items-center gap-3">
            <span
              className={`flex-none font-mono text-[26px] font-semibold leading-none ${
                tone(s.zeroChance) === 'up' ? 'text-[var(--up)]'
                : tone(s.zeroChance) === 'warn' ? 'text-[var(--warn)]'
                : tone(s.zeroChance) === 'down' ? 'text-[var(--down)]'
                : 'text-muted-foreground'
              }`}
            >
              {pct(s.zeroChance, 2)}
            </span>
            <span className="text-[11.5px] leading-[1.5] text-muted-foreground">
              of strikes like this one expired worthless
              <br />
              <span className="text-[var(--dim)]">
                {s.sample ? `${s.sample.toLocaleString()} of them, across 733 days` : 'no history for this one'}
              </span>
              {s.leg.zero && !s.leg.zero.comparableHorizon && (
                <>
                  <br />
                  <span className="text-[var(--warn)]">
                    those were 12-hour trades — this contract runs longer, so treat it as a guide
                  </span>
                </>
              )}
            </span>
          </div>

          <StatDivider />
          {s.askPrice !== null && s.askPrice !== s.price && (
            <Stat
              label="fills straight away at"
              value={s.price.toFixed(2)}
              tone="dim"
              hint="The bid. Every figure below is built on this one, because the 733-day record priced fills at the bid. Posting at the ask earns more only if it fills."
            />
          )}
          <Stat
            label="ends out of the money"
            value={pct(s.pExpireWorthless, 2)}
            tone={tone(s.pExpireWorthless)}
            hint="What the maths model says. N(d2), not delta."
          />
          <Stat
            label="ever touches your strike"
            value={pct(s.pTouch, 1)}
            tone={s.pTouch !== null && s.pTouch > 0.2 ? 'warn' : 'plain'}
            hint="It can cross and come back. Still a win if it ends the right side."
          />
          <Stat
            label="premium drops to near zero first"
            value={pct(s.pNearZero, 1)}
            hint="Simulated. This is when you could close early instead of waiting."
          />
          <Stat
            label="how far the strike is"
            value={`${s.leg.distancePct >= 0 ? '+' : ''}${s.leg.distancePct.toFixed(2)}%`}
            tone="dim"
          />
          <Stat label="break-even" value={s.breakeven.toFixed(0)} tone="dim" />
          <Stat
            label="most you can lose here"
            value={s.maxLoss === null ? 'no limit' : `$${s.maxLoss.toFixed(4)}`}
            tone={s.maxLoss === null ? 'down' : 'warn'}
          />
        </div>
      ))}
      </div>

      <StatDivider />
      <Stat
        label="lots"
        value={
          rec.sides.length === 1
            ? `100% ${rec.sides[0]!.side === 'CE' ? 'calls' : 'puts'} — only side that qualifies`
            : `${Math.round(rec.split.ce * 100)}% calls · ${Math.round(rec.split.pe * 100)}% puts`
        }
        hint={whySplit}
      />
      <Stat
        label="you keep if both expire worthless"
        value={`$${rec.totalCreditUsd.toFixed(4)} · ₹${rec.totalCreditInr.toFixed(2)}`}
        tone="up"
      />
      <Stat
        label="chance both expire worthless"
        value={pct(rec.bothZeroChance, 1)}
        tone={tone(rec.bothZeroChance)}
      />
      <Stat
        label="most you can lose"
        value={naked ? 'no limit — nothing caps it' : `$${rec.totalMaxLossUsd!.toFixed(4)} · ₹${(rec.totalMaxLossUsd! * usdinr).toFixed(2)}`}
        tone="down"
      />
      {!naked && (
        <Stat
          label="reward ÷ risk"
          value={rec.rewardToRisk === null ? '—' : rec.rewardToRisk.toFixed(3)}
          tone={rec.rewardToRisk !== null && rec.rewardToRisk < 0.05 ? 'warn' : 'plain'}
        />
      )}
      <Stat
        label="margin it ties up"
        value={`$${rec.marginUsd.toFixed(2)} · ₹${rec.marginInr.toFixed(0)}`}
        tone="dim"
      />
      {rec.expectedProfitUsd !== null ? (
        <>
          <Stat
            label="expected profit"
            value={`$${rec.expectedProfitUsd.toFixed(4)} · ₹${rec.expectedProfitInr!.toFixed(2)}`}
            tone={rec.expectedProfitUsd >= 0 ? 'up' : 'down'}
            hint="Credit × chance it works, minus the loss × chance it does not."
          />
          <Stat
            label="return on margin"
            value={rec.returnOnMarginPct === null ? '—' : `${rec.returnOnMarginPct.toFixed(2)}%`}
            tone={
              rec.returnOnMarginPct !== null && rec.returnOnMarginPct >= 0 ? 'up' : 'down'
            }
          />
        </>
      ) : (
        <Stat
          label="expected profit"
          value="cannot be stated"
          tone="warn"
          hint="With no hedge the loss has no ceiling, so an average cannot be worked out."
        />
      )}

    </CollapsibleCard>
  );
}
