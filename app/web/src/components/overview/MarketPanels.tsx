import type { ChainResponse, MarketRead } from '@/types/desk';
import type { FlowSummary, PerpResponse, TermHistoryPoint, TermPoint, TermResponse } from '@/api/desk';
import { ivRv, keyLevels, namedLevels, skew, volRegime, type IvRv } from '@/lib/overview';
import { fmt, More, NotCaptured, Panel, Row, Tag, useWidth } from './parts';

// ------------------------------------------------------------------ KPI strip

/** Dollars as the reference screens print them: $1.28B, $524.3M, $81.2K. */
const usdShort = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
};

/**
 * Delta settles funding every eight hours, at 00:00, 08:00 and 16:00 UTC: the
 * product's annualised funding is the rate × 1,095, and 1,095 is three a day.
 */
export function nextFundingIn(nowMs: number): string {
  const period = 8 * 3_600_000;
  const left = period - (nowMs % period);
  const h = Math.floor(left / 3_600_000), m = Math.floor((left % 3_600_000) / 60_000), s = Math.floor((left % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function KpiStrip({ data, spot, iv, perp, spark, now = Date.now() }: {
  data: ChainResponse; spot: number; iv: IvRv | null; perp: PerpResponse | null; spark?: readonly number[]; now?: number;
}) {
  const m = data.market;
  const s = data.structure;
  const t = perp?.ticker ?? null;
  const change = m?.return24h ?? null;
  const perpChange = t?.change24hPct ?? null;
  const funding = t?.fundingRate ?? null;
  return (
    <div className="ov-kpis">
      <Kpi label="BTC spot" value={fmt.n(spot, 1)} sub={change === null ? 'vs prev close —' : `${fmt.signed(change, 2)}% vs prev close`} tone={change === null ? undefined : change >= 0 ? 'up' : 'down'}
        spark={spark} />
      <Kpi label="BTC perp" value={fmt.n(t?.mark ?? null, 1)} sub={perpChange === null ? 'mark · 24h —' : `mark · ${fmt.signed(perpChange, 2)}% 24h`}
        tone={perpChange === null ? undefined : perpChange >= 0 ? 'up' : 'down'} />
      <Kpi label="Perp 24h volume" value={usdShort(t?.turnoverUsd24h)} sub={t?.volume24h == null ? '' : `${fmt.n(t.volume24h)} contracts`} />
      <Kpi label="Open interest (perp)" value={usdShort(t?.oiUsd)} sub={t?.oiContracts == null ? '' : `${fmt.n(t.oiContracts)} contracts`} />
      <Kpi label="Funding rate" value={funding === null ? '—' : `${funding.toFixed(4)}%`}
        sub={funding === null ? 'not read' : `${funding > 0 ? 'longs pay' : funding < 0 ? 'shorts pay' : 'flat'} · next in ${nextFundingIn(now)}`}
        tone={funding === null ? undefined : funding > 0 ? 'up' : funding < 0 ? 'down' : undefined} />
      <Kpi label="IV (ATM)" value={s.atmIv === null ? '—' : `${(s.atmIv * 100).toFixed(1)}%`}
        sub={iv ? `RV ${iv.rvPct.toFixed(1)}% · ${iv.label}` : 'realised vol —'} tone={iv?.label === 'rich' ? 'up' : iv?.label === 'cheap' ? 'down' : undefined} />
      <Kpi label="PCR (OI)" value={fmt.n(s.pcrOi, 2)} sub={`PCR vol ${fmt.n(s.pcrVolume, 2)}`} />
      <div className="ov-kpi">
        <span className="ov-kpi-label">Market regime</span>
        <span className="ov-kpi-value"><Tag tone={regimeTone(m?.regime)}>{m?.regime ?? '—'}</Tag></span>
        <span className="ov-kpi-sub">{volRegimeText(m)}</span>
      </div>
    </div>
  );
}

const volRegimeText = (m: MarketRead | null) => {
  const r = volRegime(m?.realisedVol1h ?? null, m?.realisedVol ?? null);
  return r ? `${r.label} volatility · 1h RV ${r.ratio.toFixed(1)}× the 21d` : m?.realisedVol == null ? '' : `realised vol ${m.realisedVol.toFixed(1)}%`;
};

const KPI_HELP: Record<string, string> = {
  'BTC spot': 'Delta\'s BTC index; the change is against the previous UTC daily close',
  'BTC perp': 'The BTCUSD perpetual\'s mark price and its 24h change',
  'Perp 24h volume': 'Turnover on the perpetual over 24 hours, USD',
  'Open interest (perp)': 'Contracts open on the perpetual, in USD',
  'Funding rate': 'What longs pay shorts (or the reverse) every 8 hours, as Delta publishes it',
  'IV (ATM)': 'Implied volatility at the money, against realised volatility over 21 days',
  'PCR (OI)': 'Put open interest over call open interest; above 1, more puts are held',
};

function Kpi({ label, value, sub, tone, muted, spark }: {
  label: string; value: string; sub?: string; tone?: 'up' | 'down'; muted?: boolean; spark?: readonly number[];
}) {
  return (
    <div className={`ov-kpi${muted ? ' ov-kpi-muted' : ''}`} title={KPI_HELP[label]}>
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

export function PriceActionPanel({ market, tf: wanted = '15m' }: { market: MarketRead | null; tf?: string }) {
  // The chart's timeframe, where the read has it; 1m and 30m are not read, so the nearest read one stands in.
  const have = market?.timeframes ?? [];
  const nearest: Record<string, string> = { '1m': '5m', '30m': '15m' };
  const use = have.some((t) => t.tf === wanted) ? wanted : nearest[wanted] ?? '15m';
  const tf = have.find((t) => t.tf === use) ?? null;
  const trendTone = tf?.trend === 1 ? 'up' : tf?.trend === -1 ? 'down' : 'muted';
  const macd = use === '15m' ? market?.macd15m ?? null : null;
  return (
    <Panel title={`Price action (${use})`} right={use !== wanted ? <small className="ov-muted">{wanted} not read; {use} shown</small> : undefined}>
      {!tf ? <p className="ov-empty">No {use} bars yet.</p> : (
        <>
          <Row mark="arrow" label="Trend" value={tf.label} tone={trendTone} />
          <Row mark="arrow" label="Structure" value={tf.structure === 1 ? 'HH / HL' : tf.structure === -1 ? 'LH / LL' : 'no clear swings'}
            tone={tf.structure === 1 ? 'up' : tf.structure === -1 ? 'down' : 'muted'} hint="Higher highs and higher lows, or the mirror, on the recent swings" />
          <Row mark="arrow" label="RSI (14)" value={fmt.n(tf.rsi14, 1)} tone={tf.rsi14 === null ? 'muted' : tf.rsi14 >= 55 ? 'up' : tf.rsi14 <= 45 ? 'down' : 'muted'}
            hint={tf.rsi14 !== null && (tf.rsi14 >= 70 || tf.rsi14 <= 30) ? 'Stretched: past 70 or under 30' : 'Above 55 leans up, under 45 leans down'} />
          <Row mark="arrow" label="MACD" value={macd ? (macd.hist >= 0 ? 'Bullish' : 'Bearish') : use === '15m' ? '—' : 'read on 15m only'}
            tone={macd ? (macd.hist >= 0 ? 'up' : 'down') : 'muted'} hint={macd ? `MACD(12, 26, 9) histogram ${fmt.signed(macd.hist, 1)} · line ${macd.line.toFixed(1)} · signal ${macd.signal.toFixed(1)}` : undefined} />
          <Row mark="arrow" label="VWAP" value={tf.vwap == null ? '—' : fmt.n(tf.vwap, 1)}
            tone={tf.vwapDistPct == null ? 'muted' : tf.vwapDistPct >= 0 ? 'up' : 'down'} hint={tf.vwapDistPct == null ? undefined : `Price is ${fmt.signed(tf.vwapDistPct, 2)}% from the volume-weighted average of the bars read`} />
          <More>
            <Row label="ADX (14)" value={tf.adx14 == null ? '—' : tf.adx14.toFixed(1)} hint="Trend strength, whichever way; above 25 is a trend" />
            <Row label="EMA 9 / 21 / 50" value={`${fmt.n(tf.ema9)} / ${fmt.n(tf.ema21)} / ${fmt.n(tf.ema50)}`} tone={tf.ema9 !== null && tf.ema21 !== null ? (tf.ema9 > tf.ema21 ? 'up' : 'down') : undefined} />
          </More>
        </>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------- key levels

export function KeyLevelsPanel({ data, spot }: { data: ChainResponse; spot: number }) {
  const m = data.market;
  const all = keyLevels(data.structure, m?.high24h ?? null, m?.low24h ?? null, m?.prevDayHigh ?? null, m?.prevDayLow ?? null);
  const named = namedLevels(all, spot);
  const away = (p: number) => <small className="ov-muted">{fmt.signed(((p - spot) / spot) * 100, 2)}%</small>;
  return (
    <Panel title="Key levels">
      {named.length === 0 ? <p className="ov-empty">No levels on this board.</p> : named.map((l) => (
        <Row key={l.name} mark="dot" tone={l.kind === 'resistance' ? 'down' : l.kind === 'support' ? 'up' : 'muted'}
          label={l.name} value={<>{fmt.n(l.price)} {away(l.price)}</>} hint={`${l.source} · ${fmt.signed(l.price - spot)} from spot`} />
      ))}
      <More label="Every level">
        {all.map((l) => (
          <Row key={l.label} label={l.label} value={<>{fmt.n(l.price)} {away(l.price)}</>} />
        ))}
      </More>
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
  const atrUsd = (t: typeof tf5) => (t?.atrPct == null ? '—' : fmt.n(t.close * t.atrPct / 100, 1));
  return (
    <Panel title="Volatility" right={<small className="ov-muted">ATM IV {data.structure.atmIv === null ? '—' : `${(data.structure.atmIv * 100).toFixed(1)}%`}</small>}>
      <Row mark="dot" tone="up" label="Realized vol (1h)" value={pct(m?.realisedVol1h)} hint="Annualised, from the last hour of 5-minute closes" />
      <Row mark="dot" tone="up" label="Realized vol (6h)" value={pct(m?.realisedVol6h)} hint="Annualised, from the last six hours of 5-minute closes" />
      <Row mark="dot" tone={iv ? (iv.spreadPts > 0 ? 'up' : 'down') : 'muted'} label="IV − RV spread" value={iv ? `${fmt.signed(iv.spreadPts, 1)} pts` : '—'}
        hint="Implied minus realised (21d). Positive: sellers are paid more than BTC has been delivering" />
      <Row mark="dot" tone="muted" label="ATR (5m)" value={atrUsd(tf5)} hint={tf5?.atrPct == null ? undefined : `${tf5.atrPct.toFixed(2)}% of price`} />
      <Row mark="dot" tone="muted" label="ATR (1h)" value={atrUsd(tf1h)} hint={tf1h?.atrPct == null ? undefined : `${tf1h.atrPct.toFixed(2)}% of price`} />
      <Row mark="dot" tone={regime ? (regime.label === 'high' ? 'down' : regime.label === 'low' ? 'muted' : 'up') : 'muted'} label="Vol regime"
        value={regime ? <Tag tone={regime.label === 'high' ? 'down' : regime.label === 'low' ? 'muted' : 'accent'}>{regime.label}</Tag> : '—'}
        hint={regime ? `The last hour's realised volatility is ${regime.ratio.toFixed(1)}× the 21-day figure` : 'Needs an hour of bars and the 21-day figure'} />
      <More>
        <Row label="Realized vol (12h / 21d)" value={`${pct(m?.realisedVol12h)} / ${pct(m?.realisedVol)}`} />
        <Row label="IV richness" value={iv ? `${iv.label} · ${iv.ratio.toFixed(2)}× realised` : '—'} tone={iv?.label === 'rich' ? 'up' : iv?.label === 'cheap' ? 'down' : undefined} />
        <Row label="Biggest day (30d)" value={m?.max24hRangeUsd == null ? '—' : `${fmt.n(m.max24hRangeUsd)} (${m.max24hRangePct?.toFixed(2)}%)`} hint="The largest single-day range of the last 30 days: how wrong the expected move can be" />
      </More>
    </Panel>
  );
}

// --------------------------------------------------------------- trade flow

/**
 * The perpetual's tape over the last hour, by who crossed the spread, and the
 * top of its book. From the desk's own record of every print; a window the
 * socket was away for says how many minutes it actually has.
 */
export function TradeFlowPanel({ perp, market }: { perp: PerpResponse | null; market: MarketRead | null }) {
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
  const last = f.cvd.at(-1)?.cvd ?? null;
  const kct = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : fmt.n(v));
  return (
    <Panel title={`Trade flow (${f.windowMin >= 60 ? `${f.windowMin / 60}h` : `${f.windowMin}m`})`}
      right={<small className={f.minutesCovered < f.windowMin ? 'ov-warn' : 'ov-muted'} title="Minutes in the window with at least one print">{f.minutesCovered} of {f.windowMin} min</small>}>
      <Row mark="dot" tone="up" label="Buy volume" value={`${kct(f.buyVolume)} ct`} hint="Contracts bought by the aggressor: buys that lifted the offer" />
      <Row mark="dot" tone="down" label="Sell volume" value={`${kct(f.sellVolume)} ct`} hint="Contracts sold by the aggressor: sells that hit the bid" />
      <Row mark="dot" tone={delta > 0 ? 'up' : delta < 0 ? 'down' : 'muted'} label="Delta volume" value={`${delta > 0 ? '+' : ''}${kct(delta)} ct`} hint="Buy volume minus sell volume" />
      <Row mark="dot" tone={last === null ? 'muted' : last >= 0 ? 'up' : 'down'} label="CVD" value={<CvdLine cvd={f.cvd} />} hint="Cumulative volume delta over the window, minute by minute" />
      <Row mark="dot" tone={f.largeTrades > 0 ? 'warn' : 'muted'} label="Large trades" value={fmt.n(f.largeTrades)} hint={`Prints of 200 contracts (0.2 BTC) or more: ${fmt.n(f.largeBuyVolume)} ct bought, ${fmt.n(f.largeSellVolume)} ct sold`} />
      <Row mark="dot" tone={f.aggressorBuyPct === null ? 'muted' : f.aggressorBuyPct > 0.55 ? 'up' : f.aggressorBuyPct < 0.45 ? 'down' : 'muted'} label="Aggressor buy %" value={fmt.pct(f.aggressorBuyPct, 1)} hint="Buy volume as a share of the total: above a half, buyers are lifting offers" />
      <More>
        <Row label="Aggressor sell %" value={f.aggressorBuyPct === null ? '—' : fmt.pct(1 - f.aggressorBuyPct, 1)} />
        <Row label="Trades · avg size" value={`${fmt.n(f.trades)} · ${fmt.n(f.avgTradeSize, 1)} ct`} />
        {b && <BookRows b={b} />}
        <p className="ov-foot">Bursts, CVD slope and OI acceleration are read as rules in the early warning. Liquidations are not a public feed on Delta; a burst of large one-sided prints with OI falling is the visible trace.</p>
      </More>
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

/** Contracts per minute over the last fifteen minutes of CVD. */
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
  const [box, W] = useWidth<HTMLDivElement>();
  const H = 150, P = 26;
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
    <div ref={box} className="ov-chart-box">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="ov-svg" role="img" aria-label="ATM implied volatility by expiry">
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
              {x - prev >= 26 && (
                <text x={x} y={H - 6} textAnchor="middle" className="ov-tick">{p.hoursAway < 48 ? `${Math.round(p.hoursAway)}h` : `${Math.round(p.hoursAway / 24)}d`}</text>
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
    </div>
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
