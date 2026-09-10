import type { MarketRead, Recommendation } from '@/types/desk';
import { Note } from '@/components/ui/card';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Stat, StatDivider } from '@/components/ui/stat';
import { Badge } from '@/components/ui/badge';
import { inr, pct, signedInr, signedUsd, usd } from '@/lib/format';

/** Green above 97%, amber 90–97%, red below — the bands the history splits on. */
function tone(p: number | null) {
  if (p === null) return 'dim' as const;
  if (p >= 0.97) return 'up' as const;
  if (p >= 0.9) return 'warn' as const;
  return 'down' as const;
}

/** Money on this card: rupees first, dollars beside. */
const money = (usdValue: number, usdinr: number) => `${inr(usdValue * usdinr)} · ${usd(usdValue)}`;

/**
 * What to sell, in as few words as possible. The big number is the one that
 * matters: how often strikes like this one really expired worthless.
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
        <Note>Not trading is a valid choice — quiet days often come before big moves.</Note>
      </CollapsibleCard>
    );
  }

  const naked = rec.totalMaxLossUsd === null;
  const oneSide = rec.sides.length === 1;
  // one leg has no "both": its own chance is the one that matters
  const bothChance = oneSide ? rec.sides[0]!.zeroChance : rec.bothZeroChance;
  // The reasoning behind the split, as a tooltip on the line it explains.
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
            ? `≥ $${minPremium} · ≥ ${(rec.safetyBar * 100).toFixed(1)}% safe`
            : `Premium ≥ $${minPremium}`}
        </Badge>
      }
    >
      {rec.sides.length === 1 && (
        <Note tone="warn">
          Only {rec.sides[0]!.side} qualifies today, so all lots go there. Normal in Safest mode.
        </Note>
      )}

      {/* Puts left, calls right, the way a chain is laid out; one side keeps the full width. */}
      <div className={rec.sides.length > 1 ? 'grid gap-2.5 md:grid-cols-2' : ''}>
      {[...rec.sides].sort((a, b) => (a.side === 'PE' ? -1 : 1) - (b.side === 'PE' ? -1 : 1)).map((s) => (
        <div key={s.side} className="mb-2.5 rounded-md border border-border bg-[var(--bg)] p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[15px]">
            <span className={s.side === 'CE' ? 'text-[var(--ce)]' : 'text-[var(--pe)]'}>{s.side}</span>
            <b>{s.leg.strike.toLocaleString()}</b>
            <span className="text-[var(--dim)]">×{s.lots} lots</span>
            {/* The ticket price is the ask; every figure below is built on the bid, the safer number. */}
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
              of similar strikes expired worthless
              <br />
              <span className="text-[var(--dim)]">
                {s.sample ? `${s.sample.toLocaleString()} strikes over 733 days` : 'No history for this one'}
              </span>
              {s.leg.zero && !s.leg.zero.comparableHorizon && (
                <>
                  <br />
                  <span className="text-[var(--warn)]">Tested on 12-hour trades; this one runs longer — treat as a guide</span>
                </>
              )}
            </span>
          </div>

          <StatDivider />
          {s.askPrice !== null && s.askPrice !== s.price && (
            <Stat label="Sells now at (bid)" value={s.price.toFixed(2)} tone="dim" hint="The bid. All figures below use it." />
          )}
          <Stat label="Expires worthless (model)" value={pct(s.pExpireWorthless, 2)} tone={tone(s.pExpireWorthless)} hint="The maths model alone, before real results correct it." />
          <Stat
            label="Touches strike before expiry"
            value={pct(s.pTouch, 1)}
            tone={s.pTouch !== null && s.pTouch > 0.2 ? 'warn' : 'plain'}
            hint="It can touch and come back. Still a win if it ends out of the money."
          />
          <Stat label="Chance to close early" value={pct(s.pNearZero, 1)} hint="Simulated: the premium drops near zero before expiry, so you could close early and keep most of it." />
          <Stat label="Distance from BTC price" value={`${s.leg.distancePct >= 0 ? '+' : ''}${s.leg.distancePct.toFixed(2)}%`} tone="dim" />
          <Stat label="Break-even" value={s.breakeven.toFixed(0)} tone="dim" />
          <Stat
            label="Max loss on this leg"
            value={s.maxLoss === null ? 'No limit' : money(s.maxLoss, usdinr)}
            tone={s.maxLoss === null ? 'down' : 'warn'}
          />
        </div>
      ))}
      </div>

      <StatDivider />
      <Stat
        label="Lots split"
        value={
          rec.sides.length === 1
            ? `100% ${rec.sides[0]!.side} — only side that qualifies`
            : `${Math.round(rec.split.ce * 100)}% CE · ${Math.round(rec.split.pe * 100)}% PE`
        }
        hint={whySplit}
      />
      <Stat label="Premium collected" value={money(rec.totalCreditUsd, usdinr)} tone="plain" hint="What buyers pay you, at the bid." />
      <Stat
        label="Delta charges to open"
        value={`− ${money(rec.chargesUsd, usdinr)}`}
        tone="dim"
        hint="Fee = the smaller of 0.01% of BTC value or 3.5% of premium, plus 18% GST. Nothing more is charged if it expires worthless."
      />
      <Stat
        label={oneSide ? 'You keep if it expires worthless' : 'You keep if both expire worthless'}
        value={money(rec.netCreditUsd, usdinr)}
        tone="up"
      />
      <Stat
        label={oneSide ? 'Chance it expires worthless' : 'Chance both expire worthless'}
        value={pct(bothChance, 1)}
        tone={tone(bothChance)}
        hint={oneSide ? undefined : 'A call and a put cannot both lose on the same day, so this is 100% minus each side’s chance of losing.'}
      />
      <Stat
        label="Max loss"
        value={naked ? 'No limit (no hedge)' : money(rec.totalMaxLossUsd!, usdinr)}
        tone="down"
      />
      {!naked && (
        <Stat
          label="Reward ÷ risk"
          value={rec.rewardToRisk === null ? '—' : rec.rewardToRisk.toFixed(3)}
          tone={rec.rewardToRisk !== null && rec.rewardToRisk < 0.05 ? 'warn' : 'plain'}
        />
      )}
      <Stat
        label="Margin used"
        value={money(rec.marginUsd, usdinr)}
        tone="dim"
        hint="Delta’s “Funds req.” at 200x: BTC price ÷ 200 × 0.001 per lot, plus the fee. Held while open, given back when closed."
      />
      {rec.expectedProfitUsd !== null ? (
        <>
          <Stat
            label="Expected profit"
            value={`${signedInr(rec.expectedProfitInr)} · ${signedUsd(rec.expectedProfitUsd)}`}
            tone={rec.expectedProfitUsd >= 0 ? 'up' : 'down'}
            hint="The average result: premium, minus what losing days cost on average in 733 days of real results, minus Delta charges."
          />
          <Stat
            label="Return on margin"
            value={rec.returnOnMarginPct === null ? '—' : `${rec.returnOnMarginPct.toFixed(2)}%`}
            tone={rec.returnOnMarginPct !== null && rec.returnOnMarginPct >= 0 ? 'up' : 'down'}
          />
        </>
      ) : (
        <Stat
          label="Expected profit"
          value="Needs a hedge"
          tone="warn"
          hint="With no hedge the loss has no cap, so an average cannot be worked out."
        />
      )}
    </CollapsibleCard>
  );
}
