import type { ChainResponse, MarketRead } from '@/types/desk';
import type { FlowSummary, PerpResponse, SideFlow, TermHistoryPoint, TermPoint, TermResponse } from '@/api/desk';
import { ivRv, keyLevels, namedLevels, skew, srDistances, structureRead, volRegime, type IvRv, type NamedLevel, type OptionBias } from '@/lib/overview';
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

export function KpiStrip({ data, spot, iv, perp, spark, now = Date.now(), bias }: {
  data: ChainResponse; spot: number; iv: IvRv | null; perp: PerpResponse | null; spark?: readonly number[]; now?: number; bias?: OptionBias | null;
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
      {bias && <OptionBiasKpi bias={bias} />}
    </div>
  );
}

/** CE against PE in one card: premium pressure, OI build-up, IV, touch odds, the tape -- and where the pressure is. */
function OptionBiasKpi({ bias }: { bias: OptionBias }) {
  const arrow = (v: number | null, up = 'up', down = 'down') => (v === null ? <span className="ov-muted">—</span> : <span className={v > 0 ? `ov-${up}` : v < 0 ? `ov-${down}` : 'ov-muted'}>{v > 0 ? '↑' : v < 0 ? '↓' : '→'} {fmt.signed(v, 1)}%</span>);
  const col = (b: OptionBias['ce']) => (
    <div className={`ov-bias-col ov-bias-${b.side.toLowerCase()}`}>
      <b>{b.side}</b>
      <span title="The at-the-money option's mark against an hour ago">Premium {arrow(b.premiumChangePct)}</span>
      <span title="The hour's open-interest change as a share of the side's OI">OI {arrow(b.oiChangePct)}</span>
      <span title="The at-the-money option's implied volatility">IV {b.iv === null ? '—' : `${(b.iv * 100).toFixed(1)}%`}</span>
      <span title="Probability of touch on the desk's pick for this side">Touch {fmt.pct(b.pTouch)}</span>
      <span title="The options' tape on this side over the hour: who crossed the spread">Flow {b.flow === null ? <span className="ov-muted">—</span> : <span className={b.flow === 'BUY' ? 'ov-up' : b.flow === 'SELL' ? 'ov-down' : 'ov-muted'}>{b.flow}</span>}</span>
      <Tag tone={b.strength === 'STRONG' ? 'down' : b.strength === 'WEAK' ? 'up' : 'muted'}>{b.strength}</Tag>
    </div>
  );
  return (
    <div className="ov-kpi ov-kpi-wide ov-bias" title="Premium rising, OI building and takers buying make a side STRONG — under pressure, dangerous to be short. The reverse makes it WEAK — favourable to a seller.">
      <span className="ov-kpi-label">Option bias · CE / PE</span>
      <div className="ov-bias-grid">{col(bias.ce)}{col(bias.pe)}</div>
      <span className="ov-kpi-sub">Pressure → <b>{bias.pressureOn ?? 'even'}</b>{bias.pressureOn ? ` · the ${bias.pressureOn} side is the one being bought and built` : ''}</span>
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

export function PriceActionPanel({ market, tf: wanted = '15m', levels = [], spot }: { market: MarketRead | null; tf?: string; levels?: readonly NamedLevel[]; spot?: number }) {
  // The chart's timeframe, where the read has it; 1m and 30m are not read, so the nearest read one stands in.
  const have = market?.timeframes ?? [];
  const nearest: Record<string, string> = { '1m': '5m', '30m': '15m' };
  const use = have.some((t) => t.tf === wanted) ? wanted : nearest[wanted] ?? '15m';
  const tf = have.find((t) => t.tf === use) ?? null;
  const trendTone = tf?.trend === 1 ? 'up' : tf?.trend === -1 ? 'down' : 'muted';
  const macd = use === '15m' ? market?.macd15m ?? null : null;
  const atrUsd = tf?.atrPct == null ? null : tf.close * tf.atrPct / 100;
  const sr = srDistances(levels, spot ?? tf?.close ?? 0, atrUsd);
  const swing = tf ? structureRead(tf.structure, tf.trend) : null;
  const dist = (d: typeof sr.support) => (d ? `${fmt.signed(d.usd)} (${fmt.signed(d.pct, 2)}%)${d.atr === null ? '' : ` · ${d.atr.toFixed(1)} ATR`}` : '—');
  return (
    <Panel title={`Price action (${use})`} right={use !== wanted ? <small className="ov-muted">{wanted} not read; {use} shown</small> : undefined}>
      {!tf ? <p className="ov-empty">No {use} bars yet.</p> : (
        <>
          <Row mark="arrow" label="Trend" value={tf.label} tone={trendTone} />
          <Row mark="arrow" label="Structure" value={`${swing!.swings}${swing!.kind ? ` · ${swing!.kind}` : ''}`}
            tone={tf.structure === 1 ? 'up' : tf.structure === -1 ? 'down' : 'muted'} hint="Higher highs and higher lows, or the mirror, on the recent swings. BOS: the swings continue the trend. CHOCH: they have turned against it" />
          <Row mark="arrow" label="RSI (14)" value={fmt.n(tf.rsi14, 1)} tone={tf.rsi14 === null ? 'muted' : tf.rsi14 >= 55 ? 'up' : tf.rsi14 <= 45 ? 'down' : 'muted'}
            hint={tf.rsi14 !== null && (tf.rsi14 >= 70 || tf.rsi14 <= 30) ? 'Stretched: past 70 or under 30' : 'Above 55 leans up, under 45 leans down'} />
          <Row mark="arrow" label="MACD" value={macd ? (macd.hist >= 0 ? 'Bullish' : 'Bearish') : use === '15m' ? '—' : 'read on 15m only'}
            tone={macd ? (macd.hist >= 0 ? 'up' : 'down') : 'muted'} hint={macd ? `MACD(12, 26, 9) histogram ${fmt.signed(macd.hist, 1)} · line ${macd.line.toFixed(1)} · signal ${macd.signal.toFixed(1)}` : undefined} />
          <Row mark="arrow" label="VWAP" value={tf.vwap == null ? '—' : fmt.n(tf.vwap, 1)}
            tone={tf.vwapDistPct == null ? 'muted' : tf.vwapDistPct >= 0 ? 'up' : 'down'} hint={tf.vwapDistPct == null ? undefined : `Price is ${fmt.signed(tf.vwapDistPct, 2)}% from the volume-weighted average of the bars read`} />
          <Row mark="arrow" label="ATR (14)" value={atrUsd === null ? '—' : `${fmt.n(atrUsd, 1)} (${tf.atrPct!.toFixed(2)}%)`} tone="muted" hint="Average true range over 14 bars of this timeframe: the size of a typical bar" />
          <More label="Details">
            <Row label="ADX (14)" value={tf.adx14 == null ? '—' : tf.adx14.toFixed(1)} hint="Trend strength, whichever way; above 25 is a trend" />
            <Row label="EMA 9 / 21 / 50" value={`${fmt.n(tf.ema9)} / ${fmt.n(tf.ema21)} / ${fmt.n(tf.ema50)}`} tone={tf.ema9 !== null && tf.ema21 !== null ? (tf.ema9 > tf.ema21 ? 'up' : 'down') : undefined} />
            <Row label={sr.resistance ? `↑ ${sr.resistance.name}` : 'Resistance'} value={dist(sr.resistance)} tone="down" hint="The nearest level above spot: how far in dollars, percent and ATRs of this timeframe" />
            <Row label={sr.support ? `↓ ${sr.support.name}` : 'Support'} value={dist(sr.support)} tone="up" hint="The nearest level below spot: how far in dollars, percent and ATRs of this timeframe" />
          </More>
        </>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------- key levels

export function KeyLevelsPanel({ data, spot, atrUsd = null }: { data: ChainResponse; spot: number; atrUsd?: number | null }) {
  const m = data.market;
  const all = keyLevels(data.structure, m?.high24h ?? null, m?.low24h ?? null, m?.prevDayHigh ?? null, m?.prevDayLow ?? null);
  const named = namedLevels(all, spot);
  const shown = new Set(named.map((l) => l.price));
  const rest = all.filter((l) => !shown.has(l.price));
  const row = (name: string, price: number, kind: string, source?: string) => (
    <tr key={`${name}${price}`} title={source}>
      <td><i className={`ov-dot ov-bg-${kind === 'resistance' ? 'down' : kind === 'support' ? 'up' : 'muted'}`} />{name}</td>
      <td>{fmt.n(price)}</td>
      <td className={price >= spot ? 'ov-down' : 'ov-up'}>{fmt.signed(price - spot)} <small className="ov-muted">{fmt.signed(((price - spot) / spot) * 100, 2)}%</small></td>
      <td className="ov-muted">{atrUsd && atrUsd > 0 ? `${(Math.abs(price - spot) / atrUsd).toFixed(1)}×` : '—'}</td>
    </tr>
  );
  return (
    <Panel title="Key levels" right={<small className="ov-muted">spot {fmt.n(spot)}{atrUsd ? ` · ATR ${fmt.n(atrUsd)}` : ''}</small>}>
      {all.length === 0 ? <p className="ov-empty">No levels on this board.</p> : (
        <table className="ov-mini ov-levels">
          <thead><tr><th>Level</th><th>Price</th><th title="From spot, dollars and percent">Distance</th><th title="Distance in average true ranges of the chart's timeframe: under 1 is within a bar's reach">÷ ATR</th></tr></thead>
          <tbody>
            {named.map((l) => row(l.name, l.price, l.kind, l.source))}
            {rest.map((l) => row(l.label, l.price, l.kind))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------- volatility

export function VolatilityPanel({ data, iv }: { data: ChainResponse; iv: IvRv | null }) {
  const m = data.market;
  const regime = volRegime(m?.realisedVol1h ?? null, m?.realisedVol ?? null);
  const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);
  return (
    <Panel title="Volatility" right={<small className="ov-muted">ATM IV {data.structure.atmIv === null ? '—' : `${(data.structure.atmIv * 100).toFixed(1)}%`}</small>}>
      <Row mark="dot" tone="up" label="Realized vol (1h)" value={pct(m?.realisedVol1h)} hint="Annualised, from the last hour of 5-minute closes" />
      <Row mark="dot" tone="up" label="Realized vol (6h)" value={pct(m?.realisedVol6h)} hint="Annualised, from the last six hours of 5-minute closes" />
      <Row mark="dot" tone={iv ? (iv.spreadPts > 0 ? 'up' : 'down') : 'muted'} label="IV − RV spread" value={iv ? `${fmt.signed(iv.spreadPts, 1)} pts` : '—'}
        hint="Implied minus realised (21d). Positive: sellers are paid more than BTC has been delivering" />
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

// ------------------------------------------------------------ option flow

/**
 * The options' own tape, a side at a time: who crossed the spread on the
 * calls and on the puts over the window, from the desk's record of every
 * print on the two nearest expiries. Book imbalance and spread are the
 * perpetual's -- options have no book capture -- and are said so.
 */
export function OptionFlowPanel({ perp }: { perp: PerpResponse | null }) {
  const f = perp?.optionFlow ?? null;
  const kct = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : fmt.n(v));
  if (!perp) return <Panel title="Option flow (1h)"><p className="ov-empty">Loading…</p></Panel>;
  if (!f || f.source === 'none') {
    return (
      <Panel title="Option flow (1h)">
        <NotCaptured what="No option prints in the window" why="The tape recorder subscribes to every strike of the two nearest expiries; recording began 20 Sep 2026, or the socket is down — /api/health shows flowFeed." />
      </Panel>
    );
  }
  const card = (name: string, tag: string, x: SideFlow) => (
    <div className={`ov-flow-card ov-flow-${tag.toLowerCase()}`}>
      <header><span>{name}</span><Tag tone={tag === 'CALL' ? 'up' : 'down'}>{tag}</Tag></header>
      <b className="ov-kpi-value">{kct(x.buyVolume)}</b>
      <span className="ov-kpi-sub">buy volume · contracts</span>
      <Row label="Sell volume" value={<span className="ov-down">{kct(x.sellVolume)}</span>} />
      <Row label="Delta volume (CVD)" value={fmt.signed(x.deltaVolume)} tone={x.deltaVolume > 0 ? 'up' : x.deltaVolume < 0 ? 'down' : 'muted'} hint="Buy minus sell over the window: the cumulative volume delta at its end" />
      <Row label="Aggressor buy %" value={fmt.pct(x.aggressorBuyPct, 1)} />
      <Row label="Trades" value={fmt.n(x.trades)} />
      <Row label="Busiest strikes" value={x.strikes.length ? x.strikes.map((k) => `${fmt.n(k.strike)} (${kct(k.buyVolume + k.sellVolume)})`).join(' · ') : '—'} hint="Most contracts traded, both sides together" />
      <footer><Tag tone={x.pressure === 'BUY PRESSURE' ? 'up' : x.pressure === 'SELL PRESSURE' ? 'down' : 'muted'}>{x.pressure ?? 'no prints'}</Tag></footer>
    </div>
  );
  const biasTone = f.combined.bias === null || f.combined.bias === 'MIXED' ? 'muted' : /CALL BUYING|PUT SELLING/.test(f.combined.bias) ? 'up' : 'down';
  return (
    <Panel title={`Option flow (${f.windowMin >= 60 ? `${f.windowMin / 60}h` : `${f.windowMin}m`})`}
      right={<small className={f.minutesCovered < f.windowMin ? 'ov-warn' : 'ov-muted'} title="Minutes in the window with at least one option print">{f.minutesCovered} of {f.windowMin} min · {f.expiry}</small>}>
      <div className="ov-flow-cards">
        {card('CE flow', 'CALL', f.ce)}
        {card('PE flow', 'PUT', f.pe)}
      </div>
      <div className="ov-flow-combined">
        <Row label="Total" value={`buy ${kct(f.combined.buyVolume)} · sell ${kct(f.combined.sellVolume)} · Δ ${fmt.signed(f.combined.deltaVolume)}`} />
        <Row label="Overall option flow" value={<Tag tone={biasTone}>{f.combined.bias ?? '—'}</Tag>} hint="The heaviest of the four legs names the bias when it is two-fifths of the volume; otherwise mixed. Call buying and put selling lean bullish; call selling and put buying, bearish" />
      </div>
      <p className="ov-foot">Book imbalance and spread are the perpetual's (trade flow above); Delta publishes no book history for options.</p>
    </Panel>
  );
}
