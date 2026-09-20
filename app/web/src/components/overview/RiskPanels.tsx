import type { Leg } from '@/types/desk';
import {
  premiumDecay, shockTable, type IvRv, type RiskEngine,
} from '@/lib/overview';
import { fmt, Panel, Row, Tag, useWidth } from './parts';

// ----------------------------------------------------------- risk engine

export function RiskEnginePanel({ leg, risk, contracts, hoursToExpiry, iv, step }: { leg: Leg | null; risk: RiskEngine | null; contracts: number; hoursToExpiry: number; iv: IvRv | null; step: number }) {
  if (!leg || !risk) return <Panel title="Sell-side risk engine"><p className="ov-empty">Select a strike with a price.</p></Panel>;
  const side = leg.cp === 'C' ? 'CE' : 'PE';
  const usd = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`);
  return (
    <Panel title={`Sell-side risk engine · ${fmt.n(leg.strike)} ${side}`} right={<small className="ov-muted">{contracts} ct</small>}>
      <div className="ov-two">
        <div>
          <Row label="IV − RV" value={iv ? `${fmt.signed(iv.spreadPts, 1)} pts · ${iv.label}` : '—'} tone={iv ? (iv.label === 'rich' ? 'up' : iv.label === 'cheap' ? 'down' : undefined) : undefined} hint="This strike is sold into the board's implied against realised volatility" />
          <Row label="Tail loss (2×EM adverse)" value={risk.tailLossUsd === null ? '—' : `$${risk.tailLossUsd.toFixed(2)}`} tone="down" hint="The loss the desk plans for; a naked short has no bounded worst case" />
          <Row label="Theta / gamma" value={risk.thetaGammaRatio === null ? '—' : fmt.n(risk.thetaGammaRatio)} hint="Decay earned per unit of convexity risk; higher is calmer" />
          <Row label="Vega shock (+5 IV pts)" value={usd(risk.vegaShockUsd)} tone={risk.vegaShockUsd === null ? undefined : risk.vegaShockUsd >= 0 ? 'up' : 'down'} />
          <Row label="Gamma shock (1% adverse)" value={usd(risk.gammaShockUsd)} tone={risk.gammaShockUsd === null ? undefined : risk.gammaShockUsd >= 0 ? 'up' : 'down'} hint="Delta and gamma only, for the size" />
        </div>
        <div>
          <Row label="Margin yield" value={fmt.pct(risk.marginYield, 1)} hint="Credit after fees over the margin it ties up" />
          <Row label="Hedge availability" value={<Tag tone={risk.protectionAvailable ? 'up' : 'down'}>{risk.protectionAvailable ? 'yes' : 'none listed'}</Tag>} hint="A further strike on the same side with an ask: what a wing would cost" />
          <Row label="Protection distance" value={risk.hedge ? `${fmt.n(Math.abs(risk.hedge.strike - leg.strike))} (${Math.round(Math.abs(risk.hedge.strike - leg.strike) / (step || 200))} strike${Math.abs(risk.hedge.strike - leg.strike) / (step || 200) === 1 ? '' : 's'}) · ask ${fmt.n(risk.hedge.askUsd, 1)} · $${risk.hedge.costUsd.toFixed(2)}` : '—'} hint="How far out the nearest wing sits, and its cost for the size" />
          <Row label="Theoretical (BS at mark IV)" value={fmt.n(risk.theoretical, 1)} />
          <Row label="Market premium richness" value={risk.marketRichness === null ? '—' : fmt.pct(risk.marketRichness, 1)}
            tone={risk.marketRichness === null ? undefined : risk.marketRichness >= 0 ? 'up' : 'down'} hint="Bid against mark: what the market actually pays a seller" />
          <Row label="Break-even after fees" value={fmt.n(risk.breakevenAfterFees)} />
          <Row label="Slippage (half spread)" value={risk.slippageUsd === null ? '—' : `$${risk.slippageUsd.toFixed(2)}`} />
        </div>
      </div>
      <DecayChart premium={risk.premium} intrinsic={risk.intrinsic} hoursToExpiry={hoursToExpiry} side={side} strike={leg.strike} />
    </Panel>
  );
}

/**
 * Option premium decay: where the premium should be at each hour to
 * settlement under the √time model, and when half and four-fifths of it will
 * have gone. A model, and said so -- the record of what this strike actually
 * did sits in the what-changed table.
 */
function DecayChart({ premium, intrinsic, hoursToExpiry, side, strike }: { premium: number; intrinsic: number; hoursToExpiry: number; side: string; strike: number }) {
  const [box, W] = useWidth<HTMLDivElement>(320);
  const { points, milestones } = premiumDecay(premium, intrinsic, hoursToExpiry, 5);
  const H = 150, P = { top: 18, right: 12, bottom: 24, left: 34 };
  const T = Math.max(hoursToExpiry, 0.01);
  const top = Math.max(premium, 1);
  const px = (u: number) => P.left + (u / T) * (W - P.left - P.right);
  const py = (v: number) => P.top + (1 - v / top) * (H - P.top - P.bottom);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(p.hoursFromNow).toFixed(1)},${py(p.premium).toFixed(1)}`).join(' ');
  const area = `${line} L${px(T).toFixed(1)},${py(0).toFixed(1)} L${px(0).toFixed(1)},${py(0).toFixed(1)} Z`;
  const hm = (h: number) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`;
  return (
    <div className="ov-decay-chart">
      <div className="ov-subhead"><span>Option premium decay · {fmt.n(strike)} {side}</span><small className="ov-muted">model: extrinsic × √(time left ÷ time now)</small></div>
      <div className="ov-decay-row">
        <div ref={box} className="ov-chart-box">
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="ov-svg" role="img" aria-label="Premium to settlement">
            <path d={area} className="ov-area-accent" />
            <path d={line} fill="none" className="ov-line-accent" />
            <line x1={P.left} x2={W - P.right} y1={py(0)} y2={py(0)} className="ov-axis" />
            <text x={P.left - 6} y={py(0) + 4} textAnchor="end" className="ov-tick">0</text>
            {points.map((p) => (
              <g key={p.hoursFromNow}>
                <circle cx={px(p.hoursFromNow)} cy={py(p.premium)} r={3} className="ov-pt" />
                <text x={px(p.hoursFromNow)} y={py(p.premium) - 7} textAnchor="middle" className="ov-tick ov-tick-strong">{fmt.n(p.premium, p.premium < 10 ? 1 : 0)}</text>
                <text x={px(p.hoursFromNow)} y={H - 6} textAnchor="middle" className="ov-tick">{p.label}</text>
              </g>
            ))}
          </svg>
        </div>
        <div className="ov-decay-box">
          <span className="ov-kpi-label">Expected decay</span>
          {milestones.map((m) => (
            <Row key={m.share} label={`${Math.round(m.share * 100)}% of the extrinsic gone`} value={<b>{hm(m.hoursFromNow)}</b>} hint="From now, under the √time model" />
          ))}
          <Row label="Intrinsic (does not decay)" value={fmt.n(intrinsic, 1)} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- scenario

/**
 * The selected short under a shock, now: BTC −500 … +500 by delta and gamma,
 * IV ±1 / +2 points by vega, for the size, as the short sees it. Instant
 * P&L, not settlement P&L -- the payoff tab is that.
 */
export function ScenarioPanel({ leg, contracts }: { leg: Leg | null; contracts: number }) {
  if (!leg) return <Panel title="Scenario"><p className="ov-empty">Select a strike.</p></Panel>;
  const shocks = shockTable(leg, contracts);
  const btc = shocks.filter((s) => s.label.startsWith('BTC')).sort((a, b) => Number(a.label.replace(/[^\d−-]/g, '').replace('−', '-')) - Number(b.label.replace(/[^\d−-]/g, '').replace('−', '-')));
  const ivs = shocks.filter((s) => s.label.startsWith('IV'));
  const cell = (s: { label: string; pnlUsd: number | null }) => (
    <span key={s.label} className={s.pnlUsd === null ? 'ov-muted' : s.pnlUsd >= 0 ? 'ov-up' : 'ov-down'}>
      <small>{s.label}</small>{s.pnlUsd === null ? '—' : fmt.signed(s.pnlUsd, 2)}
    </span>
  );
  return (
    <Panel title={`Scenario · ${fmt.n(leg.strike)} ${leg.cp === 'C' ? 'CE' : 'PE'}`} right={<small className="ov-muted">{contracts} ct · instant P&L, USD</small>}>
      <div className="ov-shocks" title="Delta and gamma for the BTC moves, vega for the IV moves; instantaneous, for the size, as the short sees it">
        {btc.slice(0, 3).map(cell)}
        <span className="ov-now"><small>NOW</small>0.00</span>
        {btc.slice(3).map(cell)}
      </div>
      <div className="ov-shocks ov-shocks-iv">{ivs.map(cell)}</div>
      <p className="ov-foot">By the greeks at this instant, for {contracts} contracts: what the position would show if BTC or IV jumped now. At settlement the payoff tab applies.</p>
    </Panel>
  );
}
