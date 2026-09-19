import type { ChainResponse, MarketRead } from '@/types/desk';
import type { FlowSummary, PerpResponse, TermHistoryPoint, TermPoint, TermResponse } from '@/api/desk';
import { ivRv, keyLevels, modelView, skew, volRegime, type IvRv } from '@/lib/overview';
import { fmt, NotCaptured, Panel, Row, Tag } from './parts';

// ------------------------------------------------------------------ KPI strip

/** Dollars as the reference screens print them: $1.28B, $524.3M, $81.2K. */
const usdShort = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
};

export function KpiStrip({ data, spot, iv, perp, spark }: {
  data: ChainResponse; spot: number; iv: IvRv | null; perp: PerpResponse | null; spark?: readonly number[];
}) {
  const m = data.market;
  const s = data.structure;
  const t = perp?.ticker ?? null;
  const view = modelView(data.outlook, 720);
  const change = m?.return24h ?? null;
  const perpChange = t?.change24hPct ?? null;
  const funding = t?.fundingRate ?? null;
  return (
    <div className="ov-kpis">
      <Kpi label="BTC spot" value={fmt.n(spot, 1)} sub={change === null ? '24h —' : `${fmt.signed(change, 2)}% 24h`} tone={change === null ? undefined : change >= 0 ? 'up' : 'down'}
        spark={spark} />
      <Kpi label="BTC perp" value={fmt.n(t?.mark ?? null, 1)} sub={perpChange === null ? 'mark · 24h —' : `mark · ${fmt.signed(perpChange, 2)}% 24h`}
        tone={perpChange === null ? undefined : perpChange >= 0 ? 'up' : 'down'} />
      <Kpi label="Perp 24h volume" value={usdShort(t?.turnoverUsd24h)} sub={t?.volume24h == null ? '' : `${fmt.n(t.volume24h)} contracts`} />
      <Kpi label="Open interest (perp)" value={usdShort(t?.oiUsd)} sub={t?.oiContracts == null ? '' : `${fmt.n(t.oiContracts)} contracts`} />
      <Kpi label="Funding rate" value={funding === null ? '—' : `${(funding * 100).toFixed(4)}%`}
        sub={funding === null ? 'not read' : funding > 0 ? 'longs pay shorts' : funding < 0 ? 'shorts pay longs' : 'flat'}
        tone={funding === null ? undefined : funding > 0 ? 'up' : funding < 0 ? 'down' : undefined} />
      <Kpi label="IV (ATM)" value={s.atmIv === null ? '—' : `${(s.atmIv * 100).toFixed(1)}%`}
        sub={iv ? `RV ${iv.rvPct.toFixed(1)}% · ${iv.label}` : 'realised vol —'} tone={iv?.label === 'rich' ? 'up' : iv?.label === 'cheap' ? 'down' : undefined} />
      <Kpi label="PCR (OI)" value={fmt.n(s.pcrOi, 2)} sub={`PCR vol ${fmt.n(s.pcrVolume, 2)}`} />
      <div className="ov-kpi">
        <span className="ov-kpi-label">Market regime</span>
        <span className="ov-kpi-value"><Tag tone={regimeTone(m?.regime)}>{m?.regime ?? '—'}</Tag></span>
        <span className="ov-kpi-sub">{volRegimeText(m)}</span>
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

const volRegimeText = (m: MarketRead | null) => {
  const r = volRegime(m?.realisedVol1h ?? null, m?.realisedVol ?? null);
  return r ? `${r.label} volatility · 1h RV ${r.ratio.toFixed(1)}× the 21d` : m?.realisedVol == null ? '' : `realised vol ${m.realisedVol.toFixed(1)}%`;
};

function Kpi({ label, value, sub, tone, muted, spark }: {
  label: string; value: string; sub?: string; tone?: 'up' | 'down'; muted?: boolean; spark?: readonly number[];
}) {
  return (
    <div className={`ov-kpi${muted ? ' ov-kpi-muted' : ''}`}>
      <span className="ov-kpi-label">{label}</span>
      <span className={`ov-kpi-value${tone ? ` ov-${tone}` : ''}`}>{value}</span>
      {sub && <span className={`ov-kpi-sub${tone ? ` ov-${tone}` : ''}`}>{sub}</span>}
      {spark && spark.length > 2 && <Sparkline values={spark} tone={tone} />}
    </div>
  );
}

/** A small line of the last values, no axes: the shape of the day, not a chart. */
export function Sparkline({ values, tone }: { values: readonly number[]; tone?: 'up' | 'down' }) {
  const W = 72, H = 22;
  const lo = Math.min(...values), hi = Math.max(...values);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`ov-spark${tone ? ` ov-spark-${tone}` : ''}`} aria-hidden>
      <path d={d} fill="none" />
    </svg>
  );
}

const regimeTone = (r: string | undefined) =>
  !r ? 'muted' : /up|bull/i.test(r) ? 'up' : /down|bear/i.test(r) ? 'down' : 'accent';

// -------------------------------------------------------------- price action

export function PriceActionPanel({ market }: { market: MarketRead | null }) {
  const tf = market?.timeframes.find((t) => t.tf === '15m') ?? null;
  const trendTone = tf?.trend === 1 ? 'up' : tf?.trend === -1 ? 'down' : 'muted';
  const macd = market?.macd15m ?? null;
  return (
    <Panel title="Price action (15m)">
      {!tf ? <p className="ov-empty">No 15-minute bars yet.</p> : (
        <>
          <Row label="Trend" value={tf.label} tone={trendTone} />
          <Row label="Structure" value={tf.structure === 1 ? 'HH / HL' : tf.structure === -1 ? 'LH / LL' : 'no clear swings'}
            tone={tf.structure === 1 ? 'up' : tf.structure === -1 ? 'down' : 'muted'} hint="Higher highs and higher lows, or the mirror, on the recent swings" />
          <Row label="RSI (14)" value={fmt.n(tf.rsi14, 1)} tone={tf.rsi14 === null ? undefined : tf.rsi14 >= 70 || tf.rsi14 <= 30 ? 'warn' : undefined} />
          <Row label="MACD (12, 26, 9)" value={macd ? `${macd.hist >= 0 ? 'bullish' : 'bearish'} · ${fmt.signed(macd.hist, 1)}` : '—'}
            tone={macd ? (macd.hist >= 0 ? 'up' : 'down') : undefined} hint={macd ? `line ${macd.line.toFixed(1)} · signal ${macd.signal.toFixed(1)}` : undefined} />
          <Row label="VWAP" value={tf.vwap == null ? '—' : `${fmt.n(tf.vwap, 1)} (${fmt.signed(tf.vwapDistPct, 2)}%)`}
            tone={tf.vwapDistPct == null ? undefined : tf.vwapDistPct >= 0 ? 'up' : 'down'} hint="Price against the volume-weighted average of the bars read" />
          <Row label="EMA 9 / 21 / 50" value={`${fmt.n(tf.ema9)} / ${fmt.n(tf.ema21)} / ${fmt.n(tf.ema50)}`} tone={tf.ema9 !== null && tf.ema21 !== null ? (tf.ema9 > tf.ema21 ? 'up' : 'down') : undefined} />
          <Row label="ATR (14)" value={tf.atrPct === null ? '—' : `${fmt.n(tf.close * tf.atrPct / 100)} (${tf.atrPct.toFixed(2)}%)`} />
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
  const m = data.market;
  const levels = keyLevels(data.structure, m?.high24h ?? null, m?.low24h ?? null, m?.prevDayHigh ?? null, m?.prevDayLow ?? null);
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
  const regime = volRegime(m?.realisedVol1h ?? null, m?.realisedVol ?? null);
  const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);
  return (
    <Panel title="Volatility">
      <Row label="ATM IV" value={data.structure.atmIv === null ? '—' : `${(data.structure.atmIv * 100).toFixed(1)}%`} />
      <Row label="Realised 1h / 6h / 12h" value={`${pct(m?.realisedVol1h)} / ${pct(m?.realisedVol6h)} / ${pct(m?.realisedVol12h)}`}
        hint="Annualised, from 5-minute closes: what BTC is delivering right now" />
      <Row label="Realised 21d" value={pct(m?.realisedVol)} hint="Annualised, from daily closes: what it usually delivers" />
      <Row label="IV − RV" value={iv ? `${fmt.signed(iv.spreadPts, 1)} pts` : '—'} tone={iv ? (iv.spreadPts > 0 ? 'up' : 'down') : undefined}
        hint="What sellers are paid for above what BTC has delivered (21d)" />
      <Row label="IV richness" value={iv ? <Tag tone={iv.label === 'rich' ? 'up' : iv.label === 'cheap' ? 'down' : 'muted'}>{iv.label} · {iv.ratio.toFixed(2)}×</Tag> : '—'} />
      <Row label="ATR 5m / 1h" value={`${tf5?.atrPct == null ? '—' : `${tf5.atrPct.toFixed(2)}%`} / ${tf1h?.atrPct == null ? '—' : `${tf1h.atrPct.toFixed(2)}%`}`} />
      <Row label="Vol regime" value={regime ? <Tag tone={regime.label === 'high' ? 'down' : regime.label === 'low' ? 'muted' : 'accent'}>{regime.label} · {regime.ratio.toFixed(1)}×</Tag> : '—'}
        hint="The last hour's realised volatility against the 21-day figure" />
      <Row label="24h range" value={m?.max24hRangeUsd == null ? '—' : `${fmt.n(m.max24hRangeUsd)} (${m.max24hRangePct?.toFixed(2)}%)`} hint="The largest single day of the last 30" />
    </Panel>
  );
}

// --------------------------------------------------------------- trade flow

/**
 * The perpetual's tape over the last hour, by who crossed the spread, and the
 * top of its book. From the desk's own record of every print; a window the
 * socket was away for says how many minutes it actually has.
 */
export function TradeFlowPanel({ perp }: { perp: PerpResponse | null }) {
  const f = perp?.flow ?? null;
  const b = perp?.book ?? null;
  if (!perp) return <Panel title="Trade flow (1h)"><p className="ov-empty">Loading…</p></Panel>;
  if (!f || f.source === 'none') {
    return (
      <Panel title="Trade flow (1h)">
        <NotCaptured what="No prints in the window" why="The tape recorder has just started, or its socket is down — /api/health shows flowFeed." />
        {b && <BookRows b={b} />}
      </Panel>
    );
  }
  const delta = f.deltaVolume;
  const large = f.largeBuyVolume + f.largeSellVolume;
  return (
    <Panel title={`Trade flow (${f.windowMin}m)`}
      right={<small className={f.minutesCovered < f.windowMin ? 'ov-warn' : 'ov-muted'}>{f.minutesCovered} of {f.windowMin} min</small>}>
      <Row label="Buy volume" value={`${fmt.n(f.buyVolume)} ct`} tone="up" hint="Contracts bought by the aggressor: buys that lifted the offer" />
      <Row label="Sell volume" value={`${fmt.n(f.sellVolume)} ct`} tone="down" hint="Contracts sold by the aggressor: sells that hit the bid" />
      <Row label="Delta volume" value={`${fmt.signed(delta)} ct`} tone={delta > 0 ? 'up' : delta < 0 ? 'down' : 'muted'} />
      <Row label="CVD" value={<CvdLine cvd={f.cvd} />} hint="Cumulative volume delta over the window, minute by minute" />
      <Row label="Aggressor buy %" value={fmt.pct(f.aggressorBuyPct, 1)} tone={f.aggressorBuyPct === null ? undefined : f.aggressorBuyPct > 0.55 ? 'up' : f.aggressorBuyPct < 0.45 ? 'down' : undefined} />
      <Row label="Trades · avg size" value={`${fmt.n(f.trades)} · ${fmt.n(f.avgTradeSize, 1)} ct`} />
      <Row label="Large prints (≥200 ct)" value={large === 0 ? 'none' : `${fmt.n(f.largeBuyVolume)} bought · ${fmt.n(f.largeSellVolume)} sold`}
        tone={large === 0 ? 'muted' : f.largeBuyVolume > f.largeSellVolume ? 'up' : f.largeBuyVolume < f.largeSellVolume ? 'down' : undefined} />
      {b && <BookRows b={b} />}
      <p className="ov-foot">Liquidations are not a public feed on Delta; a burst of large one-sided prints with OI falling is the visible trace.</p>
    </Panel>
  );
}

function BookRows({ b }: { b: NonNullable<PerpResponse['book']> }) {
  const imb = b.imbalance;
  return (
    <>
      <Row label="Book depth (20 levels)" value={`${fmt.n(b.bidDepth)} bid · ${fmt.n(b.askDepth)} ask`} hint="Contracts resting within twenty levels of the touch" />
      <Row label="Book imbalance" value={imb === null ? '—' : fmt.signed(imb * 100, 1) + '%'} tone={imb === null ? undefined : imb > 0.15 ? 'up' : imb < -0.15 ? 'down' : 'muted'}
        hint="(bid − ask) ÷ (bid + ask): positive, more resting to buy" />
      <Row label="Spread" value={b.spreadUsd === null ? '—' : `$${b.spreadUsd.toFixed(1)} (${fmt.pct(b.spreadPct, 3)})`} />
    </>
  );
}

function CvdLine({ cvd }: { cvd: FlowSummary['cvd'] }) {
  const last = cvd.at(-1)?.cvd ?? null;
  return (
    <span className="ov-inline-spark">
      {cvd.length > 2 && <Sparkline values={cvd.map((c) => c.cvd)} tone={last !== null && last >= 0 ? 'up' : 'down'} />}
      <b className={last === null ? '' : last >= 0 ? 'ov-up' : 'ov-down'}>{fmt.signed(last)}</b>
    </span>
  );
}

// ------------------------------------------------------------ term structure

export function IvTermPanel({ term, error }: { term: TermResponse | null; error?: boolean }) {
  const points = term?.points ?? null;
  return (
    <Panel title="IV term structure" right={<TermLegend term={term} />}>
      {error ? <p className="ov-empty">Could not read the term structure.</p>
        : !points ? <p className="ov-empty">Loading…</p>
          : points.length === 0 ? <p className="ov-empty">No listed expiry has an IV.</p>
            : <TermChart points={points} weekAgo={term?.weekAgo?.points ?? null} monthAgo={term?.monthAgo?.points ?? null} />}
    </Panel>
  );
}

function TermLegend({ term }: { term: TermResponse | null }) {
  return (
    <span className="ov-legend">
      <i className="ov-legend-now" /> now
      <i className="ov-legend-week" /> 1W ago{term && !term.weekAgo && <small className="ov-muted"> (no record yet)</small>}
      <i className="ov-legend-month" /> 1M ago{term && !term.monthAgo && <small className="ov-muted"> (no record yet)</small>}
    </span>
  );
}

function TermChart({ points, weekAgo, monthAgo }: { points: TermPoint[]; weekAgo: TermHistoryPoint[] | null; monthAgo: TermHistoryPoint[] | null }) {
  const W = 260, H = 110, P = 22;
  const series = [points, weekAgo ?? [], monthAgo ?? []];
  const ivs = series.flat().map((p) => p.atmIv * 100);
  const lo = Math.floor(Math.min(...ivs) - 2), hi = Math.ceil(Math.max(...ivs) + 2);
  // Hours to settlement on a square-root axis: the short end is where the detail is.
  const sx = (h: number) => Math.sqrt(Math.max(h, 0.1));
  const xs = series.flat().map((p) => sx(p.hoursAway));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const px = (h: number) => (x1 === x0 ? W / 2 : P + ((sx(h) - x0) / (x1 - x0)) * (W - 2 * P));
  const py = (v: number) => H - P + 4 - ((v - lo) / (hi - lo || 1)) * (H - 2 * P);
  const path = (ps: readonly TermHistoryPoint[]) => ps.map((p, i) => `${i ? 'L' : 'M'}${px(p.hoursAway).toFixed(1)},${py(p.atmIv * 100).toFixed(1)}`).join(' ');
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="ov-svg" role="img" aria-label="ATM implied volatility by expiry">
        <line x1={P} x2={W - P} y1={H - P + 4} y2={H - P + 4} className="ov-axis" />
        <text x={2} y={py(hi) + 4} className="ov-tick">{hi}%</text>
        <text x={2} y={py(lo) + 4} className="ov-tick">{lo}%</text>
        {monthAgo && monthAgo.length > 1 && <path d={path(monthAgo)} className="ov-line-month" fill="none" />}
        {weekAgo && weekAgo.length > 1 && <path d={path(weekAgo)} className="ov-line-week" fill="none" />}
        <path d={path(points)} className="ov-line-accent" fill="none" />
        {points.map((p, i) => {
          // A label only where there is room for it: near expiries crowd the short end.
          const x = px(p.hoursAway);
          const prev = i > 0 ? px(points[i - 1]!.hoursAway) : -Infinity;
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

export function SkewPanel({ data, rank }: { data: ChainResponse; rank: TermResponse['skew'] | null }) {
  const s = skew(data.legs, data.structure.atmIv);
  const iv = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
  return (
    <Panel title={`Skew (${data.snapshot.expiry})`}>
      <Row label={`25Δ put IV${s.put25 ? ` · ${fmt.n(s.put25.strike)}` : ''}`} value={iv(s.put25?.iv)} />
      <Row label="ATM IV" value={iv(s.atmIv)} />
      <Row label={`25Δ call IV${s.call25 ? ` · ${fmt.n(s.call25.strike)}` : ''}`} value={iv(s.call25?.iv)} />
      <Row label="Put − call skew" value={s.putCallPts === null ? '—' : `${fmt.signed(s.putCallPts, 1)} pts`}
        tone={s.putCallPts === null ? undefined : s.putCallPts > 0 ? 'down' : 'up'} hint="Positive: downside protection costs more" />
      <Row label={`Skew percentile${rank ? ` (${rank.days < 1 ? 'today' : `${Math.round(rank.days)}d`})` : ''}`}
        value={rank ? fmt.pct(rank.percentile) : '—'} tone={rank ? (rank.percentile >= 0.8 ? 'down' : rank.percentile <= 0.2 ? 'up' : undefined) : 'muted'}
        hint={rank ? `Among ${rank.samples} recorded readings since 17 Sep 2026; the reference screens want a year` : 'Needs recorded skew readings; recording started 17 Sep 2026'} />
    </Panel>
  );
}

export { ivRv };
