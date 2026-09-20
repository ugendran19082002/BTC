import type { Leg } from '@/types/desk';
import {
  premiumDecay, shockTable, type IvRv, type RiskEngine,
} from '@/lib/overview';
import { fmt, Panel, Row, Tag, useWidth } from './parts';

// ----------------------------------------------------------- risk engine

/** The risk engine for both chosen strikes, CE then PE: derived risk only, one block each. */
export function RiskEnginePanel({ strikes, contracts, hoursToExpiry, iv, step }: { strikes: { leg: Leg | null; risk: RiskEngine | null }[]; contracts: number; hoursToExpiry: number; iv: IvRv | null; step: number }) {
  const shown = strikes.filter((x) => x.leg && x.risk) as { leg: Leg; risk: RiskEngine }[];
  const title = shown.map((x) => `${fmt.n(x.leg.strike)} ${x.leg.cp === 'C' ? 'CE' : 'PE'}`).join(' · ');
  return (
    <Panel title={`Sell-side risk engine${title ? ` · ${title}` : ''}`} right={<small className="ov-muted">{contracts} ct</small>}>
      {shown.length === 0 ? <p className="ov-empty">Choose a strike with a price.</p> : shown.map((x) => <RiskBlock key={`${x.leg.cp}${x.leg.strike}`} leg={x.leg} risk={x.risk} contracts={contracts} hoursToExpiry={hoursToExpiry} iv={iv} step={step} two={shown.length > 1} />)}
    </Panel>
  );
}

function RiskBlock({ leg, risk, contracts, hoursToExpiry, iv, step, two }: { leg: Leg; risk: RiskEngine; contracts: number; hoursToExpiry: number; iv: IvRv | null; step: number; two: boolean }) {
  const side = leg.cp === 'C' ? 'CE' : 'PE';
  const usd = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`);
  return (
    <div className="ov-risk-block">
      {two && <h4 className="ov-subhead"><span>{fmt.n(leg.strike)} {side}</span></h4>}
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
      <div className="ov-subhead"><span>Stress &amp; scenario</span><small className="ov-muted">{contracts} ct · instant P&L, USD · by the greeks now</small></div>
      <StressRow leg={leg} contracts={contracts} />
      <DecayChart premium={risk.premium} intrinsic={risk.intrinsic} hoursToExpiry={hoursToExpiry} side={side} strike={leg.strike} />
    </div>
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

// ---------------------------------------------------------- stress row

/** BTC −500 … +500 by delta and gamma, IV ±1 / +2 by vega, for the size, as the short sees it: instant P&L, not settlement P&L. */
function StressRow({ leg, contracts }: { leg: Leg; contracts: number }) {
  const shocks = shockTable(leg, contracts);
  const num = (l: string) => Number(l.replace(/[^\d−-]/g, '').replace('−', '-'));
  const btc = shocks.filter((s) => s.label.startsWith('BTC')).sort((a, b) => num(a.label) - num(b.label));
  const ivs = shocks.filter((s) => s.label.startsWith('IV'));
  const cell = (s: { label: string; pnlUsd: number | null }) => (
    <span key={s.label} className={s.pnlUsd === null ? 'ov-muted' : s.pnlUsd >= 0 ? 'ov-up' : 'ov-down'}>
      <small>{s.label}</small>{s.pnlUsd === null ? '—' : fmt.signed(s.pnlUsd, 2)}
    </span>
  );
  return (
    <>
      <div className="ov-shocks">{btc.slice(0, 3).map(cell)}<span className="ov-now"><small>NOW</small>0.00</span>{btc.slice(3).map(cell)}</div>
      <div className="ov-shocks ov-shocks-iv">{ivs.map(cell)}</div>
    </>
  );
}
