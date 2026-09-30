import { forwardRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TfRead } from '@/lib/smc/context';
import type { BigTradeSummary, FlowRead, VolRegime } from './flow-layers';
import type { PerpOiChange } from '@/api/desk';

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
const pct = (v: number) => `${Math.round(v * 100)}%`;

type Shown = { open: number; high: number; low: number; close: number; when: string; hovering: boolean; flow?: FlowRead | null };
const k = (v: number) => (Math.abs(v) >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : `${Math.round(v)}`);

/**
 * The chart's corner readout: the candle under the pointer (or the last), the
 * timeframe context, positioning, big trades and the candle's flow -- what the
 * market is doing, never a setup. Setups are the entry section's
 * (components/desk/entry), drawn on the chart from there. Inside the chart,
 * over the candles' quietest corner, and folds to one line.
 */
export const ChartHud = forwardRef<HTMLDivElement, {
  open: boolean;
  onToggle: () => void;
  tf: string;
  context: readonly TfRead[];
  candle: Shown | null;
  /** Big trades in view, the size they start at (contracts) and how it was set. */
  big?: (BigTradeSummary & { min: number; basis?: string }) | null;
  /** Positioning and volatility: the perp's OI against an hour ago, funding, and the chart's ATR against its usual. */
  derivs?: { oi: PerpOiChange | null; funding: number | null; vol: VolRegime | null } | null;
}>(function ChartHud({ open, onToggle, tf, context, candle, big, derivs }, ref) {
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
          {big && (
            <p className="pc-hud-ohlc" aria-label="Big trades in view" title={`Big trades start at ${big.min / 1_000} BTC: ${big.basis ?? 'the market\'s own size'}. Taker orders, counted over the candles in view. Hover a bubble for its detail.`}>
              <span>Big ≥{(big.min / 1_000).toFixed(1)} BTC</span>
              <span className="bbuy">● {big.buys} buy · {big.buyBtc.toFixed(1)}</span>
              <span className="bsell">● {big.sells} sell · {big.sellBtc.toFixed(1)}</span>
              <span className={big.buyBtc >= big.sellBtc ? 'bbuy' : 'bsell'}>net {big.buyBtc - big.sellBtc >= 0 ? '+' : '−'}{Math.abs(big.buyBtc - big.sellBtc).toFixed(1)} BTC</span>
            </p>
          )}
          {candle?.flow && (
            <p className="pc-hud-ohlc" aria-label="Candle flow" title="Taker buying minus selling in this candle (contracts), the buyers' share, and its trade rate against the twenty candles before it.">
              <span>Flow</span>
              <span className={candle.flow.delta >= 0 ? 'up' : 'down'}>Δ {candle.flow.delta >= 0 ? '+' : '−'}{k(Math.abs(candle.flow.delta))}</span>
              {candle.flow.buyPct !== null && <span>buy {pct(candle.flow.buyPct)}</span>}
              <span>{candle.flow.trades} trades</span>
              {candle.flow.velocity !== null && <span className={candle.flow.velocity >= 2 ? 'hot' : ''}>{candle.flow.velocity.toFixed(1)}× pace</span>}
              {!candle.flow.whole && <span>· minutes missing</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

