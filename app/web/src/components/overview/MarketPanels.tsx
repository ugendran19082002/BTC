import { useEffect, useState } from 'react';
import type { ChainResponse, MarketRead } from '@/types/desk';
import { getTerm, type TermPoint } from '@/api/desk';
import { ivRv, keyLevels, modelView, skew, type IvRv } from '@/lib/overview';
import { fmt, NotCaptured, Panel, Row, Tag } from './parts';

// ------------------------------------------------------------------ KPI strip

export function KpiStrip({ data, spot, iv }: { data: ChainResponse; spot: number; iv: IvRv | null }) {
  const m = data.market;
  const s = data.structure;
  const view = modelView(data.outlook, 720);
  const change = m?.return24h ?? null;
  return (
    <div className="ov-kpis">
      <Kpi label="BTC spot" value={fmt.n(spot, 1)} sub={change === null ? '24h —' : `${fmt.signed(change, 2)}% 24h`} tone={change === null ? undefined : change >= 0 ? 'up' : 'down'} />
      <Kpi label="Options 24h volume" value={fmt.n(s.ceVolume + s.peVolume)} sub={`CE ${fmt.n(s.ceVolume)} · PE ${fmt.n(s.peVolume)}`} />
      <Kpi label="Options open interest" value={fmt.n(s.ceOi + s.peOi)} sub={`CE ${fmt.n(s.ceOi)} · PE ${fmt.n(s.peOi)}`} />
      <Kpi label="Funding / perp" value="—" sub="not captured" muted />
      <Kpi label="IV (ATM)" value={s.atmIv === null ? '—' : `${(s.atmIv * 100).toFixed(1)}%`}
        sub={iv ? `RV ${iv.rvPct.toFixed(1)}% · ${iv.label}` : 'realised vol —'} tone={iv?.label === 'rich' ? 'up' : iv?.label === 'cheap' ? 'down' : undefined} />
      <Kpi label="PCR (OI)" value={fmt.n(s.pcrOi, 2)} sub={`PCR vol ${fmt.n(s.pcrVolume, 2)}`} />
      <div className="ov-kpi">
        <span className="ov-kpi-label">Market regime</span>
        <span className="ov-kpi-value"><Tag tone={regimeTone(m?.regime)}>{m?.regime ?? '—'}</Tag></span>
        <span className="ov-kpi-sub">{m?.realisedVol == null ? '' : `realised vol ${m.realisedVol.toFixed(1)}%`}</span>
      </div>
      <div className="ov-kpi ov-kpi-wide">
        <span className="ov-kpi-label">Horizon {view?.label ?? '12h'} {view?.source === 'history' ? '(history)' : view ? '(measured)' : ''}</span>
        {view ? (
          <span className="ov-kpi-trio">
            <span className="ov-up">↑ {fmt.pct(view.pUp)}</span>
            <span className="ov-down">↓ {fmt.pct(view.pDown)}</span>
            <span className="ov-muted">→ {view.source === 'history' ? '—' : fmt.pct(view.pSide)}</span>
          </span>
        ) : <span className="ov-kpi-value ov-muted">—</span>}
        <span className="ov-kpi-sub">{view?.windows ? `${fmt.n(view.windows)} windows` : 'analytics service not answering'}</span>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone, muted }: { label: string; value: string; sub?: string; tone?: 'up' | 'down'; muted?: boolean }) {
  return (
    <div className={`ov-kpi${muted ? ' ov-kpi-muted' : ''}`}>
      <span className="ov-kpi-label">{label}</span>
      <span className={`ov-kpi-value${tone ? ` ov-${tone}` : ''}`}>{value}</span>
      {sub && <span className={`ov-kpi-sub${tone ? ` ov-${tone}` : ''}`}>{sub}</span>}
    </div>
  );
}

const regimeTone = (r: string | undefined) =>
  !r ? 'muted' : /up|bull/i.test(r) ? 'up' : /down|bear/i.test(r) ? 'down' : 'accent';

// -------------------------------------------------------------- price action

export function PriceActionPanel({ market }: { market: MarketRead | null }) {
  const tf = market?.timeframes.find((t) => t.tf === '15m') ?? null;
  const trendTone = tf?.trend === 1 ? 'up' : tf?.trend === -1 ? 'down' : 'muted';
  return (
    <Panel title="Price action (15m)">
      {!tf ? <p className="ov-empty">No 15-minute bars yet.</p> : (
        <>
          <Row label="Trend" value={tf.label} tone={trendTone} />
          <Row label="EMA 9 / 21" value={`${fmt.n(tf.ema9)} / ${fmt.n(tf.ema21)}`} tone={tf.ema9 !== null && tf.ema21 !== null ? (tf.ema9 > tf.ema21 ? 'up' : 'down') : undefined} />
          <Row label="EMA 50" value={fmt.n(tf.ema50)} tone={tf.ema50 !== null ? (tf.close > tf.ema50 ? 'up' : 'down') : undefined} hint="Price above its 50 EMA reads up" />
          <Row label="RSI (14)" value={fmt.n(tf.rsi14, 1)} tone={tf.rsi14 === null ? undefined : tf.rsi14 >= 70 || tf.rsi14 <= 30 ? 'warn' : undefined} />
          <Row label="ATR (15m)" value={tf.atrPct === null ? '—' : `${fmt.n(tf.close * tf.atrPct / 100)} (${tf.atrPct.toFixed(2)}%)`} />
          <Row label="Timeframes (5m…1d)" value={`${fmt.signed(market?.agreement ?? 0)} of ${market?.timeframes.length ?? 0}`}
            tone={(market?.agreement ?? 0) > 0 ? 'up' : (market?.agreement ?? 0) < 0 ? 'down' : 'muted'}
            hint="Each timeframe's trend, +1 up / −1 down, added up" />
        </>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------- key levels

export function KeyLevelsPanel({ data, spot }: { data: ChainResponse; spot: number }) {
  const levels = keyLevels(data.structure, data.market?.high24h ?? null, data.market?.low24h ?? null);
  return (
    <Panel title="Key levels">
      {levels.length === 0 ? <p className="ov-empty">No levels on this board.</p> : levels.map((l) => (
        <Row key={l.label} label={<><i className={`ov-dot ov-bg-${l.kind === 'resistance' ? 'down' : l.kind === 'support' ? 'up' : 'muted'}`} />{l.label}</>}
          value={<>{fmt.n(l.price)} <small className="ov-muted">{fmt.signed(((l.price - spot) / spot) * 100, 2)}%</small></>} />
      ))}
    </Panel>
  );
}

// --------------------------------------------------------------- volatility

export function VolatilityPanel({ data, iv }: { data: ChainResponse; iv: IvRv | null }) {
  const m = data.market;
  const tf5 = m?.timeframes.find((t) => t.tf === '5m');
  const tf1h = m?.timeframes.find((t) => t.tf === '1h');
  return (
    <Panel title="Volatility">
      <Row label="ATM IV" value={data.structure.atmIv === null ? '—' : `${(data.structure.atmIv * 100).toFixed(1)}%`} />
      <Row label="Realised vol (21d)" value={m?.realisedVol == null ? '—' : `${m.realisedVol.toFixed(1)}%`} />
      <Row label="IV − RV" value={iv ? `${fmt.signed(iv.spreadPts, 1)} pts` : '—'} tone={iv ? (iv.spreadPts > 0 ? 'up' : 'down') : undefined}
        hint="What sellers are paid for above what BTC has delivered" />
      <Row label="IV richness" value={iv ? <Tag tone={iv.label === 'rich' ? 'up' : iv.label === 'cheap' ? 'down' : 'muted'}>{iv.label} · {iv.ratio.toFixed(2)}×</Tag> : '—'} />
      <Row label="ATR 5m / 1h" value={`${tf5?.atrPct == null ? '—' : `${tf5.atrPct.toFixed(2)}%`} / ${tf1h?.atrPct == null ? '—' : `${tf1h.atrPct.toFixed(2)}%`}`} />
      <Row label="24h range" value={m?.max24hRangeUsd == null ? '—' : `${fmt.n(m.max24hRangeUsd)} (${m.max24hRangePct?.toFixed(2)}%)`} />
    </Panel>
  );
}

// --------------------------------------------------------------- trade flow

export function TradeFlowPanel() {
  return (
    <Panel title="Trade flow">
      <NotCaptured what="Buy / sell volume, CVD, large trades, liquidations"
        why="The desk does not subscribe to Delta's trades feed (all_trades) yet — docs/Data.md. Nothing here is estimated." />
    </Panel>
  );
}

// ------------------------------------------------------------ term structure

export function IvTermPanel() {
  const [points, setPoints] = useState<TermPoint[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => getTerm().then((r) => { if (live) { setPoints(r.points); setErr(false); } }).catch(() => { if (live) setErr(true); });
    load();
    const id = setInterval(load, 60_000);
    return () => { live = false; clearInterval(id); };
  }, []);
  return (
    <Panel title="IV term structure" right={<small className="ov-muted">now · no history kept</small>}>
      {err ? <p className="ov-empty">Could not read the term structure.</p>
        : !points ? <p className="ov-empty">Loading…</p>
          : points.length === 0 ? <p className="ov-empty">No listed expiry has an IV.</p>
            : <TermChart points={points} />}
    </Panel>
  );
}

function TermChart({ points }: { points: TermPoint[] }) {
  const W = 260, H = 110, P = 22;
  const ivs = points.map((p) => p.atmIv * 100);
  const lo = Math.floor(Math.min(...ivs) - 2), hi = Math.ceil(Math.max(...ivs) + 2);
  // Hours to settlement on a square-root axis: the short end is where the detail is.
  const xs = points.map((p) => Math.sqrt(Math.max(p.hoursAway, 0.1)));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const px = (x: number) => (x1 === x0 ? W / 2 : P + ((x - x0) / (x1 - x0)) * (W - 2 * P));
  const py = (v: number) => H - P + 4 - ((v - lo) / (hi - lo || 1)) * (H - 2 * P);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${px(xs[i]!).toFixed(1)},${py(p.atmIv * 100).toFixed(1)}`).join(' ');
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="ov-svg" role="img" aria-label="ATM implied volatility by expiry">
        <line x1={P} x2={W - P} y1={H - P + 4} y2={H - P + 4} className="ov-axis" />
        <text x={2} y={py(hi) + 4} className="ov-tick">{hi}%</text>
        <text x={2} y={py(lo) + 4} className="ov-tick">{lo}%</text>
        <path d={path} className="ov-line-accent" fill="none" />
        {points.map((p, i) => {
          // A label only where there is room for it: near expiries crowd the short end.
          const x = px(xs[i]!);
          const prev = i > 0 ? px(xs[i - 1]!) : -Infinity;
          return (
            <g key={p.expiry}>
              <circle cx={x} cy={py(p.atmIv * 100)} r={3} className="ov-pt" />
              {x - prev >= 22 && (
                <text x={x} y={H - 4} textAnchor="middle" className="ov-tick">{p.hoursAway < 48 ? `${Math.round(p.hoursAway)}h` : `${Math.round(p.hoursAway / 24)}d`}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="ov-term-list">
        {points.slice(0, 6).map((p) => (
          <span key={p.expiry}><small className="ov-muted">{p.expiry}</small> {(p.atmIv * 100).toFixed(1)}%</span>
        ))}
      </div>
    </>
  );
}

// --------------------------------------------------------------------- skew

export function SkewPanel({ data }: { data: ChainResponse }) {
  const s = skew(data.legs, data.structure.atmIv);
  const iv = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
  return (
    <Panel title={`Skew (${data.snapshot.expiry})`}>
      <Row label={`25Δ put IV${s.put25 ? ` · ${fmt.n(s.put25.strike)}` : ''}`} value={iv(s.put25?.iv)} />
      <Row label="ATM IV" value={iv(s.atmIv)} />
      <Row label={`25Δ call IV${s.call25 ? ` · ${fmt.n(s.call25.strike)}` : ''}`} value={iv(s.call25?.iv)} />
      <Row label="Put − call skew" value={s.putCallPts === null ? '—' : `${fmt.signed(s.putCallPts, 1)} pts`}
        tone={s.putCallPts === null ? undefined : s.putCallPts > 0 ? 'down' : 'up'} hint="Positive: downside protection costs more" />
      <Row label="Skew percentile (1Y)" value="—" tone="muted" hint="Needs a year of recorded skew; recording started 19 Sep 2026" />
    </Panel>
  );
}

export { ivRv };
