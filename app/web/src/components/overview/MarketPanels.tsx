import { Fragment } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { ChainResponse, Leg, MarketRead } from '@/types/desk';
import type { FlowSummary, PerpResponse, SideFlow, TermHistoryPoint, TermPoint, TermResponse } from '@/api/desk';
import { ivRv, skew, skewRichness, srDistances, structureRead, volRegime, WINDOW_CHOICES, windowLabel, type IvRv, type NamedLevel, type OptionBias, type WindowChoice } from '@/lib/overview';
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

/** CE against PE in one panel: premium pressure, OI build-up, IV, touch odds, the tape -- and where the pressure is. Its own panel, so the KPI row keeps one height. */
export function OptionBiasPanel({ bias }: { bias: OptionBias }) {
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
    <Panel title="Option bias · CE / PE" className="ov-bias" right={<small className="ov-muted">Pressure → <b>{bias.pressureOn ?? 'even'}</b></small>}>
      <div className="ov-bias-grid" title="Premium rising, OI building and takers buying make a side STRONG — under pressure, dangerous to be short. The reverse makes it WEAK — favourable to a seller.">{col(bias.ce)}{col(bias.pe)}</div>
      <p className="ov-foot">{bias.pressureOn ? `The ${bias.pressureOn} side is the one being bought and built.` : 'Neither side is being pushed.'} Premium and OI over the hour from the board's record; the tape from the options' own prints.</p>
    </Panel>
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

const PA_TFS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'] as const;

export function PriceActionPanel({ market, tf: chartTf = '15m', levels = [], spot }: { market: MarketRead | null; tf?: string; levels?: readonly NamedLevel[]; spot?: number }) {
  // Its own timeframe, starting from the chart's; the read has five, and the others borrow the nearest one read.
  const [own, setOwn] = usePersisted<string | null>('live:priceAction:tf', null);
  const wanted = own ?? chartTf;
  const have = market?.timeframes ?? [];
  const nearest: Record<string, string> = { '1m': '5m', '30m': '15m', '2h': '1h', '6h': '4h', '12h': '4h', '24h': '1d' };
  const use = have.some((t) => t.tf === wanted) ? wanted : nearest[wanted] ?? '15m';
  const tf = have.find((t) => t.tf === use) ?? null;
  const trendTone = tf?.trend === 1 ? 'up' : tf?.trend === -1 ? 'down' : 'muted';
  const macd = use === '15m' ? market?.macd15m ?? null : null;
  const atrUsd = tf?.atrPct == null ? null : tf.close * tf.atrPct / 100;
  const sr = srDistances(levels, spot ?? tf?.close ?? 0, atrUsd);
  const swing = tf ? structureRead(tf.structure, tf.trend) : null;
  const dist = (d: typeof sr.support) => (d ? `${fmt.signed(d.usd)} (${fmt.signed(d.pct, 2)}%)${d.atr === null ? '' : ` · ${d.atr.toFixed(1)} ATR`}` : '—');
  return (
    <Panel title="Price action" right={
      <span className="ov-chain-head">
        <select className="ov-select" aria-label="Timeframe" value={wanted} onChange={(e) => setOwn(e.target.value)} title="The bars the read is taken from">
          {PA_TFS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {use !== wanted && <small className="ov-muted">{wanted} not read; {use} shown</small>}
      </span>
    }>
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

/**
 * Key levels by timeframe: each timeframe's own swing highs above and swing
 * lows below spot (15m and 1h to decide by, 4h and 1D to confirm, 5m for the
 * immediate tape only), the previous day's high and low, and -- their own
 * kind of level -- the option walls. Every distance is in dollars and
 * percent, in that timeframe's ATR, and in the horizon's expected move.
 */
export function KeyLevelsPanel({ data, spot, emUsd = null }: { data: ChainResponse; spot: number; emUsd?: number | null }) {
  const m = data.market;
  const tfs = ['5m', '15m', '1h', '4h', '1d'] as const;
  const cell = (price: number, atrUsd: number | null) => (
    <>
      <td>{fmt.n(price)}</td>
      <td className={price >= spot ? 'ov-down' : 'ov-up'} title={`${fmt.signed(((price - spot) / spot) * 100, 2)}%`}>{fmt.signed(price - spot)}</td>
      <td className="ov-muted">{atrUsd && atrUsd > 0 ? `${(Math.abs(price - spot) / atrUsd).toFixed(1)}×` : '—'}</td>
      <td className="ov-muted">{emUsd && emUsd > 0 ? `${(Math.abs(price - spot) / emUsd).toFixed(2)}×` : '—'}</td>
    </>
  );
  const groups: { name: string; hint: string; rows: { label: string; price: number; kind: 'resistance' | 'support' | 'pivot'; atrUsd: number | null }[] }[] = [];
  for (const tf of tfs) {
    const t = m?.timeframes.find((x) => x.tf === tf);
    if (!t) continue;
    const atrUsd = t.atrPct == null ? null : t.close * t.atrPct / 100;
    const rows = [
      ...(t.resistance ?? []).map((p, i) => ({ label: `${tf} R${i + 1}`, price: p, kind: 'resistance' as const, atrUsd })),
      ...(t.support ?? []).map((p, i) => ({ label: `${tf} S${i + 1}`, price: p, kind: 'support' as const, atrUsd })),
    ];
    if (rows.length) groups.push({ name: tf === '1d' ? '1D' : tf, hint: tf === '5m' ? 'Immediate tape only — not a level to sell a strike against' : tf === '15m' ? 'Entry-level key levels' : tf === '1h' ? 'Main intraday structure' : tf === '4h' ? 'Stronger swing levels' : 'Major levels', rows });
  }
  const dayRows = [
    ...(m?.prevDayHigh != null ? [{ label: 'PDH', price: m.prevDayHigh, kind: 'resistance' as const, atrUsd: null }] : []),
    ...(m?.prevDayLow != null ? [{ label: 'PDL', price: m.prevDayLow, kind: 'support' as const, atrUsd: null }] : []),
  ];
  if (dayRows.length) groups.push({ name: 'Prev day', hint: 'Yesterday\'s high and low', rows: dayRows });
  const st = data.structure;
  const optRows = [
    ...(st.ceOiWallNear ?? st.ceOiWall ? [{ label: 'Call OI wall', price: (st.ceOiWallNear ?? st.ceOiWall)!.strike, kind: 'resistance' as const, atrUsd: null }] : []),
    ...(st.peOiWallNear ?? st.peOiWall ? [{ label: 'Put OI wall', price: (st.peOiWallNear ?? st.peOiWall)!.strike, kind: 'support' as const, atrUsd: null }] : []),
    ...(st.maxPain ? [{ label: 'Max pain', price: st.maxPain.strike, kind: 'pivot' as const, atrUsd: null }] : []),
    ...(st.gammaWall ? [{ label: 'Gamma wall', price: st.gammaWall.strike, kind: 'pivot' as const, atrUsd: null }] : []),
  ];
  if (optRows.length) groups.push({ name: 'Options', hint: 'Where option holders are positioned — a different kind of level, and for a seller often the one that matters', rows: optRows });
  const tf15 = m?.timeframes.find((x) => x.tf === '15m');
  const atr15 = tf15?.atrPct == null ? null : tf15.close * tf15.atrPct / 100;
  return (
    <Panel title="Key levels" right={<small className="ov-muted">spot {fmt.n(spot)}{atr15 ? ` · ATR 15m ${fmt.n(atr15)}` : ''}{emUsd ? ` · EM ±${fmt.n(emUsd)}` : ''}</small>}>
      {groups.length === 0 ? <p className="ov-empty">No levels read yet.</p> : (
        <table className="ov-mini ov-levels">
          <thead><tr><th>Level</th><th>Price</th><th title="From spot, dollars and percent">Distance</th><th title="Distance in that timeframe's own average true range; the day's and the options' levels have none">÷ ATR</th><th title="Distance in expected moves to settlement">÷ EM</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.name}>
                <tr className="ov-levels-group"><td colSpan={5} title={g.hint}>{g.name}</td></tr>
                {g.rows.map((r) => (
                  <tr key={r.label}>
                    <td><i className={`ov-dot ov-bg-${r.kind === 'resistance' ? 'down' : r.kind === 'support' ? 'up' : 'muted'}`} />{r.label}</td>
                    {cell(r.price, r.atrUsd)}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <p className="ov-foot">15m and 1h are the levels to decide by; 4h and 1D confirm; 5m is the tape, never a strike's reason. Swing highs and lows are fractals on each timeframe's own bars.</p>
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
export function TradeFlowPanel({ perp, market, window: win, onWindow }: { perp: PerpResponse | null; market: MarketRead | null; window?: WindowChoice; onWindow?: (w: WindowChoice) => void }) {
  const head = win && onWindow ? <WindowSelect value={win} onChange={onWindow} /> : null;
  const f = perp?.flow ?? null;
  const b = perp?.book ?? null;
  if (!perp) return <Panel title="BTC flow · perpetual" right={head}><p className="ov-empty">Loading…</p></Panel>;
  if (!f || f.source === 'none') {
    return (
      <Panel title="BTC flow · perpetual" right={head}>
        <NotCaptured what="No prints in the window" why="The tape recorder has just started, or its socket is down — /api/health shows flowFeed." />
        {b && <BookRows b={b} />}
      </Panel>
    );
  }
  const delta = f.deltaVolume;
  const last = f.cvd.at(-1)?.cvd ?? null;
  const kct = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : fmt.n(v));
  return (
    <Panel title="BTC flow · perpetual"
      right={<span className="ov-chain-head">{head}<small className={f.minutesCovered < f.windowMin ? 'ov-warn' : 'ov-muted'} title="Minutes in the window with at least one print">{f.minutesCovered} of {f.windowMin} min</small></span>}>
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
  const rich = skewRichness(s.putCallPts, rank?.percentile ?? null);
  const tone = (v: 'HIGH' | 'NORMAL' | 'LOW') => (v === 'HIGH' ? 'down' : v === 'LOW' ? 'up' : 'muted');
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
      <Row label="PE richness" value={rich ? <Tag tone={tone(rich.pe)}>{rich.pe}</Tag> : '—'} hint="Relative pricing from the skew: HIGH means the puts are priced up against the calls — richer to sell, and the market is paying for downside" />
      <Row label="CE richness" value={rich ? <Tag tone={tone(rich.ce)}>{rich.ce}</Tag> : '—'} hint="Relative pricing from the skew: HIGH means the calls are priced up against the puts" />
      <p className="ov-foot">{rich ? `${rich.text[0]!.toUpperCase()}${rich.text.slice(1)}.` : ''} Skew is relative pricing only; IV − RV says whether the whole board is rich, and a strike's own odds whether it is safe.</p>
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
export function OptionFlowPanel({ perp, legs = [], atm = null, window: win, onWindow }: { perp: PerpResponse | null; legs?: readonly Leg[]; atm?: number | null; window?: WindowChoice; onWindow?: (w: WindowChoice) => void }) {
  const f = perp?.optionFlow ?? null;
  const head = win && onWindow ? <WindowSelect value={win} onChange={onWindow} /> : null;
  // The side's own book, as far as Delta shows one: the at-the-money option's top of book.
  const atmLeg = (cp: 'C' | 'P') => legs.find((l) => l.cp === cp && l.strike === atm) ?? null;
  const bookOf = (l: Leg | null) => {
    if (!l || l.bidSize == null || l.askSize == null || l.bidSize + l.askSize === 0) return null;
    return (l.bidSize - l.askSize) / (l.bidSize + l.askSize);
  };
  const spreadOf = (l: Leg | null) => (l && l.bid !== null && l.ask !== null && l.bid + l.ask > 0 ? (l.ask - l.bid) / ((l.bid + l.ask) / 2) : null);
  const kct = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : fmt.n(v));
  if (!perp) return <Panel title="Option flow · CE / PE" right={head}><p className="ov-empty">Loading…</p></Panel>;
  if (!f || f.source === 'none') {
    return (
      <Panel title="Option flow · CE / PE" right={head}>
        <NotCaptured what="No option prints in the window" why="The tape recorder subscribes to every strike of the two nearest expiries; recording began 20 Sep 2026, or the socket is down — /api/health shows flowFeed." />
      </Panel>
    );
  }
  const card = (name: string, tag: string, x: SideFlow, l: Leg | null) => (
    <div className={`ov-flow-card ov-flow-${tag.toLowerCase()}`}>
      <header><span>{name}</span><Tag tone={tag === 'CALL' ? 'up' : 'down'}>{tag}</Tag></header>
      <Row label="Buy" value={<span className="ov-up">{kct(x.buyVolume)} ct</span>} hint="Contracts bought by the aggressor: buys that lifted the offer" />
      <Row label="Sell" value={<span className="ov-down">{kct(x.sellVolume)} ct</span>} hint="Contracts sold by the aggressor: sells that hit the bid" />
      <Row label="Delta" value={fmt.signed(x.deltaVolume)} tone={x.deltaVolume > 0 ? 'up' : x.deltaVolume < 0 ? 'down' : 'muted'} hint="Buy minus sell over the window" />
      <Row label="CVD" value={<CvdLine cvd={x.cvd} />} hint="Cumulative volume delta, minute by minute" />
      <Row label="Aggressor %" value={fmt.pct(x.aggressorBuyPct, 1)} hint="Buy volume as a share of the total" />
      <Row label="Trades" value={fmt.n(x.trades)} />
      <Row label={`Book imbalance${l ? ` · ATM ${fmt.n(l.strike)}` : ''}`} value={bookOf(l) === null ? '—' : fmt.signed(bookOf(l)! * 100, 0) + '%'} tone={bookOf(l) === null ? undefined : bookOf(l)! > 0 ? 'up' : 'down'} hint="The at-the-money option's top of book: (bid size − ask size) ÷ (bid + ask)" />
      <Row label="Spread" value={spreadOf(l) === null ? '—' : fmt.pct(spreadOf(l), 1)} hint="The at-the-money option's bid–ask spread as a share of the mid" />
      <Row label="Busiest strikes" value={x.strikes.length ? x.strikes.map((k) => `${fmt.n(k.strike)} (${kct(k.buyVolume + k.sellVolume)})`).join(' · ') : '—'} hint="Most contracts traded, both sides together" />
      <footer><Tag tone={x.pressure === 'BUY PRESSURE' ? 'up' : x.pressure === 'SELL PRESSURE' ? 'down' : 'muted'}>{x.pressure ?? 'no prints'}</Tag></footer>
    </div>
  );
  const biasTone = f.combined.bias === null || f.combined.bias === 'MIXED' ? 'muted' : /CALL BUYING|PUT SELLING/.test(f.combined.bias) ? 'up' : 'down';
  return (
    <Panel title="Option flow · CE / PE"
      right={<span className="ov-chain-head">{head}<small className={f.minutesCovered < f.windowMin ? 'ov-warn' : 'ov-muted'} title="Minutes in the window with at least one option print">{f.minutesCovered} of {f.windowMin} min · {f.expiry}</small></span>}>
      <div className="ov-flow-cards">
        {card('CE flow', 'CALL', f.ce, atmLeg('C'))}
        {card('PE flow', 'PUT', f.pe, atmLeg('P'))}
      </div>
      <div className="ov-flow-combined">
        <Row label="Total" value={`buy ${kct(f.combined.buyVolume)} · sell ${kct(f.combined.sellVolume)} · Δ ${fmt.signed(f.combined.deltaVolume)}`} />
        <Row label="Overall option flow" value={<Tag tone={biasTone}>{f.combined.bias ?? '—'}</Tag>} hint="The heaviest of the four legs names the bias when it is two-fifths of the volume; otherwise mixed. Call buying and put selling lean bullish; call selling and put buying, bearish" />
      </div>
      <p className="ov-foot">Prints from the desk's own tape of every strike on this expiry; book and spread from the at-the-money option's live quote.</p>
    </Panel>
  );
}

/** The window the tape is summed over: the fixed ones, since the desk opened, or since the last settlement. */
export function WindowSelect({ value, onChange }: { value: WindowChoice; onChange: (w: WindowChoice) => void }) {
  return (
    <select className="ov-select" aria-label="Window" value={value} onChange={(e) => onChange(e.target.value as WindowChoice)} title="How far back the tape is summed">
      {WINDOW_CHOICES.map((w) => <option key={w} value={w}>{windowLabel(w)}</option>)}
    </select>
  );
}
