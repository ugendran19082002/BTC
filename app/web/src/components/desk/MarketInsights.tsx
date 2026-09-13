import type { Bias, OptionStructure, SnapshotMeta } from '@/types/desk';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Badge } from '@/components/ui/badge';
import { Note } from '@/components/ui/card';
import { strike as fmtStrike } from '@/lib/format';

/** One tile: a label, the figure, and the one line that says what it rests on. */
function Tile({
  label, value, foot, tone = 'plain', hint,
}: {
  label: string;
  value: string;
  foot?: string;
  tone?: 'plain' | 'up' | 'down' | 'info' | 'warn';
  hint?: string;
}) {
  return (
    <div className={`insight insight-${tone}`} title={hint}>
      <div className="insight-label">{label}</div>
      <div className="insight-value">{value}</div>
      {foot && <div className="insight-foot">{foot}</div>}
    </div>
  );
}

/**
 * What the board is saying that the strip above does not already say.
 *
 * This is the card that was removed in September for not changing the
 * recommendation — which is still true, and is now said on the card instead of
 * enforced by hiding it. Every figure here was tested as a trading rule in
 * `feature_screen.py` and none survived 2024, 2025 and 2026 together.
 *
 * It carries four tiles, not eight. The first version repeated support,
 * resistance, the put/call ratio and max pain, all four of which are already on
 * the summary strip directly above it — so the same number appeared twice on
 * one screen, which is how two figures eventually disagree. What is left is
 * what only this card has: the band between the walls, how wide it is, the lean,
 * and whether options are priced richer than BTC has actually moved.
 *
 * The lean lives here now as one tile. It used to be three needle bars and five
 * lines of prose inside the Market card — the longest block on the screen, for
 * the one number on it that is explicitly not a forecast.
 */
export function MarketInsights({
  structure,
  bias,
  snap,
}: {
  structure: OptionStructure;
  bias: Bias;
  snap: SnapshotMeta;
}) {
  const r = structure.oiRange;
  const inBand = r !== null && snap.spot >= r.low && snap.spot <= r.high;

  return (
    <CollapsibleCard
      id="structure"
      title="Market insights"
      defaultOpen
      right={<Badge tone="neutral">For information</Badge>}
    >
      <div className="insight-grid">
        <Tile
          label="Expected range"
          tone="info"
          value={r === null ? '—' : `${fmtStrike(r.low)} – ${fmtStrike(r.high)}`}
          foot={
            r === null
              ? 'no open interest to read'
              : inBand
                ? 'BTC is inside it — where open interest sits, not where BTC settles'
                : `BTC is ${snap.spot > r.high ? 'above' : 'below'} it — where open interest sits, not where BTC settles`
          }
        />

        <Tile
          label="Range width"
          value={r === null ? '—' : `$${fmtStrike(Math.round(r.widthUsd))}`}
          foot={r === null ? undefined : `${r.widthPct.toFixed(2)}% of spot`}
        />

        <Tile
          label="Market lean"
          tone={bias.score > 0.15 ? 'up' : bias.score < -0.15 ? 'down' : 'plain'}
          value={bias.label}
          foot={
            bias.components.length
              ? `from ${bias.components.length} signals · none of them traded on`
              : undefined
          }
          hint="Read from puts against calls, which side costs more to insure, and which is trading more today."
        />

        <Tile
          label="Options against reality"
          tone={structure.volPremiumPts === null ? 'plain' : structure.volPremiumPts >= 0 ? 'up' : 'down'}
          value={
            structure.volPremiumPts === null
              ? '—'
              : `${structure.volPremiumPts >= 0 ? '+' : ''}${structure.volPremiumPts.toFixed(1)} pts`
          }
          foot={
            structure.volPremiumPts === null
              ? 'no realised volatility to compare against'
              : structure.volPremiumPts >= 0
                ? 'priced richer than BTC has actually moved — the seller’s case'
                : 'priced cheaper than BTC has actually moved — the seller is being underpaid'
          }
          hint="Implied minus realised volatility, in percentage points."
        />
      </div>

      <Note>
        None of this changes what the desk recommends. Every figure here was tested as a
        trading rule across 2024, 2025 and 2026 and none held up in all three. Open interest
        says where positions are, not which way BTC goes.
      </Note>
    </CollapsibleCard>
  );
}
