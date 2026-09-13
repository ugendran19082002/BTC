import type { LucideIcon } from 'lucide-react';
import {
  TrendingUp, TrendingDown, Activity, Scale, ArrowDownToLine, ArrowUpToLine,
  Crosshair, ArrowLeftRight, Ruler, Compass, Percent,
} from 'lucide-react';
import type { Bias, MarketRead, OptionStructure, SnapshotMeta } from '@/types/desk';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Badge } from '@/components/ui/badge';
import { strike as fmtStrike } from '@/lib/format';

type Tone = 'plain' | 'up' | 'down' | 'warn' | 'info';

/**
 * One figure: an icon, a label, the number, and the line that says what it
 * rests on.
 *
 * The icon is not decoration. Ten tiles of identical grey is a wall, and the
 * icon is the only part still recognisable at a glance — which is the whole job
 * of this card.
 */
function Tile({
  icon: Icon, label, value, foot, tone = 'plain', footTone, hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  foot?: string;
  tone?: Tone;
  footTone?: Tone;
  hint?: string;
}) {
  return (
    <div className={`insight insight-${tone}`} title={hint}>
      <span className={`bs-icon bs-${tone}`} aria-hidden>
        <Icon size={15} aria-hidden />
      </span>
      <span className="insight-body">
        <span className="insight-label">{label}</span>
        <span className={`insight-value insight-${tone}-v`}>{value}</span>
        {foot && <span className={`insight-foot insight-${footTone ?? 'plain'}-v`}>{foot}</span>}
      </span>
    </div>
  );
}

/**
 * Everything the option board is saying, in one card.
 *
 * This was two things for a while — a summary strip of six figures above a card
 * of four — and the strip repeated support, resistance, the put/call ratio and
 * max pain straight out of the card below it. The same number twice on one
 * screen is how two figures eventually disagree, so they are one card now.
 *
 * The card itself was removed in September for not changing the recommendation.
 * That is still true and is now said on the card rather than enforced by hiding
 * it: every figure here was tested as a trading rule in `feature_screen.py` and
 * none survived 2024, 2025 and 2026 together. It is back because "is BTC
 * anywhere near the strikes people actually hold" is a question asked before
 * sizing, and answering it by reading open interest down a column of two dozen
 * strikes is work the page can do instead.
 *
 * The "For information" badge is the whole caveat on screen now; the reasoning
 * behind it is here and in TODO.md. Nothing on the trading side reads any of
 * these figures, and the day one of them is to decide something it goes through
 * the cross-period screen first.
 *
 * The lean is one tile. It used to be three needle bars and five lines of prose
 * inside the Market card — the longest block on the screen, for the one number
 * on it that is explicitly not a forecast.
 */
export function MarketInsights({
  structure,
  bias,
  snap,
  market,
}: {
  structure: OptionStructure;
  bias: Bias;
  snap: SnapshotMeta;
  market: MarketRead | null;
}) {
  const r = structure.oiRange;
  const pcr = structure.pcrOi;
  const change = market?.return24h ?? null;
  const inBand = r !== null && snap.spot >= r.low && snap.spot <= r.high;
  const up = change !== null && change >= 0;

  // The move in dollars as well as percent: "+$286" is what a trader carries in
  // their head, and a percentage alone reads the same on a quiet day as on a
  // violent one.
  const changeUsd = change === null ? null : snap.spot - snap.spot / (1 + change / 100);

  /*
   * Bands sit close to parity because parity is the only meaningful line here:
   * below it more calls are open than puts, which is the crowd positioned for a
   * rise. 0.86 reads Bearish, which is what every options screen calls it.
   *
   * A label on positioning, not the desk's lean — that is worked out from three
   * signals in `domain/score.ts` and has its own tile.
   */
  const crowd = pcr === null ? null : pcr > 1.1 ? 'Bullish' : pcr < 0.9 ? 'Bearish' : 'Neutral';

  return (
    <CollapsibleCard
      id="structure"
      title="Market insights"
      defaultOpen
      right={<Badge tone="neutral">For information</Badge>}
    >
      <div className="insight-grid">
        <Tile
          icon={up ? TrendingUp : TrendingDown}
          label={snap.live ? 'BTC spot' : 'BTC at snapshot'}
          value={`${fmtStrike(Math.round(snap.spot))} USD`}
          tone={change === null ? 'plain' : up ? 'up' : 'down'}
          foot={
            change === null || changeUsd === null
              ? `${snap.expiry} · ${snap.hoursToExpiry.toFixed(1)}h left`
              : `${up ? '+' : '−'}${fmtStrike(Math.round(Math.abs(changeUsd)))} (${up ? '+' : ''}${change.toFixed(2)}%)`
          }
          footTone={change === null ? 'plain' : up ? 'up' : 'down'}
        />

        <Tile
          icon={Activity}
          label="Implied volatility"
          value={snap.atmIv === null ? '—' : `${(snap.atmIv * 100).toFixed(1)}%`}
          foot={
            snap.expectedMove === null
              ? `${snap.expiry} · ${snap.hoursToExpiry.toFixed(1)}h left`
              : `±$${snap.expectedMove.toFixed(0)} by expiry`
          }
          hint="At the money, annualised. The expected move underneath is what it means for today."
        />

        <Tile
          icon={Scale}
          label="Puts per call · OI"
          value={pcr === null ? '—' : pcr.toFixed(2)}
          tone={pcr === null ? 'plain' : 'warn'}
          foot={crowd ?? undefined}
          footTone={crowd === 'Bullish' ? 'up' : crowd === 'Bearish' ? 'down' : 'plain'}
          hint="Open interest on puts divided by calls. Positioning, not a forecast — nothing reads it."
        />

        <Tile
          icon={ArrowDownToLine}
          label="Support · PE OI"
          value={structure.peOiWall === null ? '—' : fmtStrike(structure.peOiWall.strike)}
          tone="up"
          foot={
            structure.peOiWall === null
              ? undefined
              : `${(structure.peOiWall.value / 1000).toFixed(1)}K open`
          }
          hint="The put strike carrying the most open interest. Where positions sit, not where BTC stops."
        />

        <Tile
          icon={ArrowUpToLine}
          label="Resistance · CE OI"
          value={structure.ceOiWall === null ? '—' : fmtStrike(structure.ceOiWall.strike)}
          tone="down"
          foot={
            structure.ceOiWall === null
              ? undefined
              : `${(structure.ceOiWall.value / 1000).toFixed(1)}K open`
          }
          hint="The call strike carrying the most open interest."
        />

        <Tile
          icon={Crosshair}
          label="Max pain"
          value={structure.maxPain === null ? '—' : fmtStrike(structure.maxPain.strike)}
          foot={
            structure.maxPain === null
              ? undefined
              : Math.abs(structure.maxPain.strike - snap.spot) < 1
                ? 'at spot'
                : structure.maxPain.strike > snap.spot
                  ? 'above spot'
                  : 'below spot'
          }
          hint="Where the open options would pay out least at settlement. Widely read as a magnet; this desk does not treat it as one."
        />

        <Tile
          icon={ArrowLeftRight}
          label="Expected range"
          tone="info"
          value={r === null ? '—' : `${fmtStrike(r.low)} – ${fmtStrike(r.high)}`}
          foot={
            r === null
              ? 'no open interest to read'
              : inBand
                ? 'BTC is inside it'
                : `BTC is ${snap.spot > r.high ? 'above' : 'below'} it`
          }
          footTone={r === null || inBand ? 'plain' : 'warn'}
          hint="Between the two walls. Where open interest sits, not where BTC settles."
        />

        <Tile
          icon={Ruler}
          label="Range width"
          value={r === null ? '—' : `$${fmtStrike(Math.round(r.widthUsd))}`}
          foot={r === null ? undefined : `${r.widthPct.toFixed(2)}% of spot`}
        />

        <Tile
          icon={Compass}
          label="Market lean"
          tone={bias.score > 0.15 ? 'up' : bias.score < -0.15 ? 'down' : 'plain'}
          value={bias.label}
          foot={
            bias.components.length
              ? `from ${bias.components.length} signals · none traded on`
              : undefined
          }
          hint="Read from puts against calls, which side costs more to insure, and which is trading more today."
        />

        <Tile
          icon={Percent}
          label="Options against reality"
          tone={structure.volPremiumPts === null ? 'plain' : structure.volPremiumPts >= 0 ? 'up' : 'down'}
          value={
            structure.volPremiumPts === null
              ? '—'
              : `${structure.volPremiumPts >= 0 ? '+' : ''}${structure.volPremiumPts.toFixed(1)} pts`
          }
          foot={
            structure.volPremiumPts === null
              ? 'nothing to compare against'
              : structure.volPremiumPts >= 0
                ? 'richer than BTC has moved'
                : 'cheaper than BTC has moved'
          }
          hint="Implied minus realised volatility, in percentage points. Positive is the seller's case."
        />
      </div>
    </CollapsibleCard>
  );
}
