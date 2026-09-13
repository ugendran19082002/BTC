import type { LucideIcon } from 'lucide-react';
import {
  TrendingUp, TrendingDown, Activity, Scale, ArrowDownToLine, ArrowUpToLine, Crosshair,
} from 'lucide-react';
import type { MarketRead, OptionStructure, SnapshotMeta } from '@/types/desk';
import { strike as fmtStrike } from '@/lib/format';

type Tone = 'up' | 'down' | 'warn' | 'plain';

/**
 * One figure, with the icon that says at a glance which of the six it is.
 *
 * The icon is not decoration: the strip scrolls sideways on a phone, and a row
 * of six identical grey tiles gives a thumb nothing to aim at. It is the only
 * thing on the tile still recognisable at a glance while scrolling.
 */
function Cell({
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
    <div className="bs-cell" title={hint}>
      <span className={`bs-icon bs-${tone}`} aria-hidden>
        <Icon size={15} aria-hidden />
      </span>
      <span className="bs-body">
        <span className="bs-label">{label}</span>
        <span className={`bs-value bs-${tone}`}>{value}</span>
        {foot && <span className={`bs-foot bs-${footTone ?? 'plain'}`}>{foot}</span>}
      </span>
    </div>
  );
}

/**
 * The six figures a decision starts from, on one line that never has to be
 * opened.
 *
 * They already existed — spot on the Market card, implied volatility two rows
 * into it, the put/call ratio buried in the lean block, the two walls nowhere
 * and max pain nowhere at all — and reading them meant opening three cards and
 * scrolling past twenty strikes.
 */
export function BoardStrip({
  snap,
  structure,
  market,
}: {
  snap: SnapshotMeta;
  structure: OptionStructure;
  market: MarketRead | null;
}) {
  const change = market?.return24h ?? null;
  const pcr = structure.pcrOi;
  // The move in dollars as well as percent: "+$286" is what a trader carries in
  // their head, and a percentage alone reads the same on a quiet day as on a
  // violent one.
  const changeUsd = change === null ? null : snap.spot - snap.spot / (1 + change / 100);
  /*
   * Bands sit close to parity because parity is the only meaningful line here:
   * below it more calls are open than puts, which is the crowd positioned for a
   * rise. 0.86 reads Bearish, which is what every options screen calls it.
   *
   * This is a label on positioning, not the desk's lean -- that is worked out
   * from three signals in `domain/score.ts` and shown on its own tile.
   */
  const lean = pcr === null ? null : pcr > 1.1 ? 'Bullish' : pcr < 0.9 ? 'Bearish' : 'Neutral';
  const up = change !== null && change >= 0;

  return (
    <div className="board-strip" aria-label="board summary">
      <Cell
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

      <Cell
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

      <Cell
        icon={Scale}
        label="Puts per call · OI"
        value={pcr === null ? '—' : pcr.toFixed(2)}
        tone={pcr === null ? 'plain' : 'warn'}
        foot={lean ?? undefined}
        footTone={lean === 'Bullish' ? 'up' : lean === 'Bearish' ? 'down' : 'plain'}
        hint="Open interest on puts divided by calls. Positioning, not a forecast — nothing reads it."
      />

      <Cell
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

      <Cell
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

      <Cell
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
    </div>
  );
}
