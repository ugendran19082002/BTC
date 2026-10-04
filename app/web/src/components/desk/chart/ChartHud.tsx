import { forwardRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TfRead } from '@/lib/smc/context';
import type { VolRegime } from '@/lib/vol-regime';
import type { PerpOiChange } from '@/api/desk';

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');

type Shown = { open: number; high: number; low: number; close: number; when: string; hovering: boolean };

/**
 * The chart's corner readout: the candle under the pointer (or the last), the
 * timeframe context and positioning -- what the market is doing, never a
 * setup. Setups are the entry section's
 * (components/desk/entry), drawn on the chart from there. Inside the chart,
 * over the candles' quietest corner, and folds to one line.
 */
export const ChartHud = forwardRef<HTMLDivElement, {
  open: boolean;
  onToggle: () => void;
  tf: string;
  context: readonly TfRead[];
  candle: Shown | null;
  /** Positioning and volatility: the perp's OI against an hour ago, funding, and the chart's ATR against its usual. */
  derivs?: { oi: PerpOiChange | null; funding: number | null; vol: VolRegime | null } | null;
}>(function ChartHud({ open, onToggle, tf, context, candle, derivs }, ref) {
  const up = candle ? candle.close >= candle.open : true;
  return (
    <div ref={ref} className="pc-hud" aria-label="Chart readout">
      <button type="button" className="pc-hud-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        <b>BTCUSD{candle ? ` ${fmt(candle.close)}` : ''}</b>
        <span className="pc-hud-tf">{tf}</span>
      </button>
      {open && (
        <div className="pc-hud-body">
          {context.length > 0 && (
            <div className="pc-hud-ctx" aria-label="Timeframe context">
              {context.map((c) => (
                <span key={c.tf} className={c.trend === 'bull' ? 'up' : c.trend === 'bear' ? 'down' : ''}
                  title={c.last ? `${c.last.kind} ${c.last.dir === 'bull' ? 'up' : 'down'}, ${c.last.barsAgo} candles ago` : 'No break yet'}>
                  <b>{c.tf}</b> {c.trend === 'bull' ? '▲' : c.trend === 'bear' ? '▼' : '–'} {c.role}
                </span>
              ))}
            </div>
          )}

          {candle && (
            <p className="pc-hud-ohlc">
              <span>{candle.hovering ? candle.when : 'Last'}</span>
              <span>O {fmt(candle.open)}</span><span>H {fmt(candle.high)}</span><span>L {fmt(candle.low)}</span>
              <span className={up ? 'up' : 'down'}>C {fmt(candle.close)}</span>
            </p>
          )}
          {derivs && (derivs.oi || derivs.funding !== null || derivs.vol) && (
            <p className="pc-hud-ohlc" aria-label="Positioning and volatility">
              {derivs.oi && (
                <span className={derivs.oi.changePct >= 0 ? 'up' : 'down'}
                  title={`Perpetual open interest, ${derivs.oi.overMinutes} min change, read with the price over the same window (${derivs.oi.priceChangePct === null ? 'price n/a' : `price ${derivs.oi.priceChangePct >= 0 ? '+' : ''}${derivs.oi.priceChangePct.toFixed(2)}%`}). Positioning context, not a signal: over 2024-26 on Binance's perpetual, none of the four reads moved the next hour or four the same way in both halves (research/FLOW-STUDY.txt).`}>
                  OI {fmt(derivs.oi.oiContracts / 1_000)} BTC {derivs.oi.changePct >= 0 ? '▲' : '▼'}{Math.abs(derivs.oi.changePct).toFixed(1)}% 1h · {derivs.oi.read}
                </span>
              )}
              {derivs.funding !== null && (
                <span className={derivs.funding > 0.02 ? 'down' : derivs.funding < 0 ? 'up' : ''}
                  title="Funding per period, as Delta publishes it. Positive: longs pay shorts -- the long side is the crowded one; high positive is a crowded long.">
                  Funding {derivs.funding >= 0 ? '+' : ''}{derivs.funding.toFixed(4)}%
                </span>
              )}
              {derivs.vol && (
                <span className={derivs.vol.label === 'expanding' ? 'hot' : ''}
                  title="This chart's ATR(14) against its median over the candles loaded: what the stop's buffer and floor are sized from. Expanding from 1.3x, quiet under 0.7x.">
                  Vol {derivs.vol.label} {derivs.vol.ratio.toFixed(1)}× · ATR {Math.round(derivs.vol.atr)} pts
                </span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

