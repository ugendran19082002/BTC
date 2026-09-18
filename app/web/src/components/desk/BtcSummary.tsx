import { ChevronDown, Info } from 'lucide-react';
import type { Candle, MarketRead, OptionStructure, Outlook, SnapshotMeta, Wall } from '@/types/desk';
import type { ChartTf } from '@/components/desk/PriceChart';
import { expiresIn, trendWords } from '@/components/desk/SuddenMove';
import { strike as fmtStrike } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePersisted } from '@/hooks/usePersisted';

/**
 * BTC at a glance, beside the chart.
 *
 * Every line is something the desk already knows, said once and in words:
 * where price is and how it has moved, the contract and its time left, how far
 * options say it could move over the chart's own timeframe, the two walls and
 * how far away they are, and what the chart has been doing. The chart status is
 * the past -- "holding above" is a fact about the last bars, not a prediction.
 */

const EXPIRY_FORMAT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
});

/** The outlook card that answers each chart timeframe; 1m has none. */
const ROW_FOR: Record<ChartTf, string | null> = { '1m': null, '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '24h' };
const TF_MINUTES: Record<ChartTf, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
const YEAR_MINUTES = 365 * 24 * 60;
/** How many recent bars "holding above" looks back over. */
export const HOLD_BARS = 12;

/** The round level under spot, and whether the last few bars all stayed above it. */
export function holding(bars: Candle[], spot: number, step = 500): { level: number; held: boolean } | null {
  const recent = bars.slice(-HOLD_BARS);
  if (recent.length === 0 || !(spot > 0)) return null;
  const level = Math.floor(spot / step) * step;
  return { level, held: Math.min(...recent.map((b) => b.low)) >= level };
}

export function BtcSummary({ snap, market, structure, outlook, bars, tf }: {
  snap: SnapshotMeta;
  market: MarketRead | null;
  structure: OptionStructure;
  outlook: Outlook | null;
  bars: Candle[];
  tf: ChartTf;
}) {
  const spot = snap.spot;
  const change = market?.return24h ?? null;
  const changeUsd = change === null ? null : spot - spot / (1 + change / 100);
  const label = ROW_FOR[tf];
  const row = label ? outlook?.rows.find((r) => r.label === label) ?? null : null;
  const implied = row?.impliedUsd
    ?? (snap.atmIv === null ? null : spot * snap.atmIv * Math.sqrt(TF_MINUTES[tf] / YEAR_MINUTES));
  const away = (level: number) => ((level - spot) / spot) * 100;
  const trend = trendWords(row?.score ?? null);
  const hold = holding(bars, spot);
  const [open, setOpen] = usePersisted<boolean>('open:btc-summary', true);

  return (
    <aside className="btc-summary" aria-label="btc summary">
      {/* Folds like every other card; folded, the spot price stays in the title row. */}
      <button type="button" className="btc-summary-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={14} aria-hidden className={cn('btc-summary-chevron', !open && '-rotate-90')} />
        <h3 className="btc-summary-title"><span className="btc-logo sm" aria-hidden>₿</span> BTC summary</h3>
        {!open && <b className="btc-summary-folded">{fmtStrike(Math.round(spot))}</b>}
      </button>

      {open && <>

      <div className="btc-summary-block">
        <span className="btc-summary-label">Spot price</span>
        <b className="btc-summary-spot">{fmtStrike(Math.round(spot))}</b>
        {change !== null && changeUsd !== null && (
          <span className={cn('btc-summary-change', change >= 0 ? 'up' : 'down')}>
            {change >= 0 ? '+' : '−'}{fmtStrike(Math.round(Math.abs(changeUsd)))}{' '}
            {change >= 0 ? '+' : '−'}{Math.abs(change).toFixed(2)}% <small>(24h)</small>
          </span>
        )}
      </div>

      <dl className="btc-summary-rows">
        <div>
          <dt>Expiry</dt>
          <dd>{EXPIRY_FORMAT.format(snap.expiryTs * 1000)} IST<small>{expiresIn(snap.hoursToExpiry)} left</small></dd>
        </div>
        <div title="spot × IV × √(time ÷ a year): the move options are charging for this timeframe.">
          <dt>Expected move ({tf === '1d' ? '1D' : tf})</dt>
          <dd>
            {implied === null ? '—' : <>±{((implied / spot) * 100).toFixed(2)}% <small>(≈ ±${Math.round(implied).toLocaleString('en-IN')})</small></>}
          </dd>
        </div>
      </dl>

      {/*
        The wall within reach, not the heaviest on the board.
        18 September: this said "Resistance 89,000 (+16.0%)" with BTC at 76,723
        and ten hours left -- the largest call open interest anywhere on the
        chain, about eleven expected moves away. Real open interest; not a level
        anybody can trade against. So the near pair is drawn, and where nothing
        heavy sits near the money it says that instead of reaching further out.
      */}
      <dl className="btc-summary-rows">
        <Level label="Support" wall={structure.peOiWallNear ?? null} far={structure.peOiWall} away={away} tone="up" />
        <Level label="Resistance" wall={structure.ceOiWallNear ?? null} far={structure.ceOiWall} away={away} tone="down" />
      </dl>

      <div className="btc-summary-block">
        <span className="btc-summary-label">Chart status</span>
        <b className={cn('btc-summary-status', `smx-${trend.tone}`)} title={row?.why}>{trend.words}</b>
        {hold && (
          <span className="btc-summary-hold">
            {hold.held
              ? `Holding above ${fmtStrike(hold.level)} over the last ${HOLD_BARS} bars`
              : `Dipped below ${fmtStrike(hold.level)} in the last ${HOLD_BARS} bars`}
          </span>
        )}
      </div>

      <p className="btc-summary-note">
        <Info size={13} aria-hidden />
        <span>
          Support = heaviest put OI · Resistance = heaviest call OI, within{' '}
          {structure.wallWithinEm ?? 2} expected move{(structure.wallWithinEm ?? 2) === 1 ? '' : 's'} of spot.
          Levels where open interest sits, not where BTC will settle.
        </span>
      </p>
      </>}
    </aside>
  );
}

/**
 * One level: the near wall, or a plain sentence about the far one.
 *
 * A wall eleven expected moves out is not a level, and drawing it anyway is how
 * a screen ends up saying "resistance 89,000" under a ±0.07% expected move.
 */
function Level({ label, wall, far, away, tone }: {
  label: string;
  wall: Wall;
  far: Wall;
  away: (level: number) => number;
  tone: 'up' | 'down';
}) {
  const pct = (level: number) => `${away(level) >= 0 ? '+' : '−'}${Math.abs(away(level)).toFixed(1)}%`;
  return (
    <div>
      <dt>{label}</dt>
      {wall ? (
        <dd className={tone}>
          {fmtStrike(wall.strike)} <small>({pct(wall.strike)})</small>
        </dd>
      ) : (
        <dd className="dim" title={far ? `The heaviest is ${fmtStrike(far.strike)}, ${pct(far.strike)} away — too far to trade against.` : undefined}>
          none near
          {far && <small> (heaviest {fmtStrike(far.strike)}, {pct(far.strike)})</small>}
        </dd>
      )}
    </div>
  );
}

