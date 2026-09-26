import { usePersisted } from '@/hooks/usePersisted';
import type { ChainResponse, Leg, MarketRead } from '@/types/desk';
import type { FlowSummary, PerpResponse, PriceChange, SideFlow, TermResponse } from '@/api/desk';
import { fundingRead, ivRv, skew, skewRichness, srDistances, structureRead, volRegime, WINDOW_CHOICES, windowLabel, type IvRv, type NamedLevel, type OptionBias, type WindowChoice } from '@/lib/overview';
import { fmt, More, NotCaptured, Panel, Row, Tag } from './parts';

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
      <FundingKpi ratePct={funding} nextIn={nextFundingIn(now)} />
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
  const col = (b: OptionBias['ce']) => {
    const statusLabel = b.strength !== 'NEUTRAL' ? b.strength
      : b.score > 0 ? 'MILD (+1)' : b.score < 0 ? 'MILD (−1)' : 'NEUTRAL';
    const tagTone = b.strength === 'STRONG' ? 'down'
      : b.strength === 'WEAK' ? 'up'
        : b.score !== 0 ? 'warn' : 'muted';
    return (
      <div className={`ov-bias-col ov-bias-${b.side.toLowerCase()}`}>
        <b>{b.side}</b>
        <span title="The at-the-money option's mark against an hour ago">Premium {arrow(b.premiumChangePct)}</span>
        <span title="The hour's open-interest change as a share of the side's OI">OI {arrow(b.oiChangePct)}</span>
        <span title="The at-the-money option's implied volatility">IV {b.iv === null ? '—' : `${(b.iv * 100).toFixed(1)}%`}</span>
        <span title="Probability of touch on the desk's pick for this side">Touch {fmt.pct(b.pTouch)}</span>
        <span title="The options' tape on this side over the hour: who crossed the spread">Flow {b.flow === null ? <span className="ov-muted">—</span> : <span className={b.flow === 'BUY' ? 'ov-up' : b.flow === 'SELL' ? 'ov-down' : 'ov-muted'}>{b.flow}</span>}</span>
        <Tag tone={tagTone}>{statusLabel}</Tag>
      </div>
    );
  };
  const isMild = bias.pressureOn && (bias.ce.score === 1 || bias.pe.score === 1);
  return (
    <Panel title="Option bias · CE / PE" className="ov-bias" right={<small className="ov-muted">Pressure → <b>{bias.pressureOn ? `${bias.pressureOn}${isMild ? ' (mild)' : ''}` : 'even'}</b></small>}>
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

/**
 * Funding, in the words a person asks it in: the rate, what a round $10,000
 * pays at the next settlement, and who pays -- which is which way the crowd
 * leans. The decimal and the eight-hour rhythm are on hover.
 */
function FundingKpi({ ratePct, nextIn }: { ratePct: number | null; nextIn: string }) {
  const f = fundingRead(ratePct);
  if (!f) return <Kpi label="Funding rate" value="—" sub="not read" />;
  const tone = f.tone === 'muted' ? undefined : f.tone;
  const money = f.who === 'none' ? 'no payment' : `$10k ${f.who === 'longs' ? 'pays' : 'gets'} $${f.per10k.toFixed(2)} / 8h`;
  return (
    <div className={`ov-kpi ov-kpi-funding ov-kpi-${f.tone}`}
      title={`${ratePct!.toFixed(4)}% = ${f.decimal.toFixed(6)} as a decimal, every 8 hours. ${f.who === 'longs' ? 'Longs pay shorts' : f.who === 'shorts' ? 'Shorts pay longs' : 'Nobody pays'}; next settlement in ${nextIn}.`}>
      <span className="ov-kpi-label">Funding rate</span>
      <span className={`ov-kpi-value${tone ? ` ov-${tone}` : ''}`}>{ratePct!.toFixed(4)}%</span>
      <span className="ov-kpi-sub">{money} · next {nextIn}</span>
      <span className={`ov-funding-chip ov-funding-${f.tone}`}>{f.label}</span>
    </div>
  );
}

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


// --------------------------------------------------------------- volatility

/**
 * Volatility and skew, one card (22 Sep 2026): the level of implied volatility
 * against realised, then how it is spread between puts and calls. They were two
 * cards that are read together -- is the board rich, and which side is.
 */
export function VolatilityPanel({ data, iv, skewRank = null }: { data: ChainResponse; iv: IvRv | null; skewRank?: TermResponse['skew'] | null }) {
  const m = data.market;
  const regime = volRegime(m?.realisedVol1h ?? null, m?.realisedVol ?? null);
  const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);
  return (
    <Panel name="Volatility" title="Volatility & skew" right={<small className="ov-muted">ATM IV {data.structure.atmIv === null ? '—' : `${(data.structure.atmIv * 100).toFixed(1)}%`}</small>}>
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
      <div className="ov-subhead"><span>Skew · {data.snapshot.expiry}</span><small className="ov-muted">puts vs calls</small></div>
      <SkewRows data={data} rank={skewRank} />
    </Panel>
  );
}

// --------------------------------------------------------------------- flow

/**
 * Who is crossing the spread, on the perpetual and on the options, in one card
 * (22 Sep 2026): the two were separate cards reading the same tape over the
 * same window, and read together -- is the perp being bought, and are calls
 * or puts. One window picker drives both.
 */
export function FlowPanel({ perp, market, legs, atm, window: win, onWindow }: {
  perp: PerpResponse | null; market: MarketRead | null; legs: readonly Leg[]; atm: number | null;
  window: WindowChoice; onWindow: (w: WindowChoice) => void;
}) {
  return (
    <Panel name="Flow" title="Flow · BTC perpetual & options" right={<WindowSelect value={win} onChange={onWindow} />}>
      <TradeFlowPanel bare perp={perp} market={market} />
      <OptionFlowPanel bare perp={perp} legs={legs} atm={atm} />
    </Panel>
  );
}

/** A card of its own, or -- `bare` -- a titled section inside another card. */
function Frame({ bare, title, right, children }: { bare: boolean; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  if (!bare) return <Panel title={title} right={right}>{children}</Panel>;
  return (
    <>
      <div className="ov-subhead"><span>{title.replace('BTC flow · perpetual', 'BTC perpetual').replace('Option flow · CE / PE', 'Options · CE / PE')}</span>{right}</div>
      {children}
    </>
  );
}

// --------------------------------------------------------------- trade flow

/**
 * The perpetual's tape over the last hour, by who crossed the spread, and the
 * top of its book. From the desk's own record of every print; a window the
 * socket was away for says how many minutes it actually has.
 */
export function TradeFlowPanel({ perp, market, window: win, onWindow, bare = false }: { perp: PerpResponse | null; market: MarketRead | null; window?: WindowChoice; onWindow?: (w: WindowChoice) => void; bare?: boolean }) {
  const head = !bare && win && onWindow ? <WindowSelect value={win} onChange={onWindow} /> : null;
  const f = perp?.flow ?? null;
  const b = perp?.book ?? null;
  if (!perp) return <Frame bare={bare} title="BTC flow · perpetual" right={head}><p className="ov-empty">Loading…</p></Frame>;
  if (!f || f.source === 'none') {
    return (
      <Frame bare={bare} title="BTC flow · perpetual" right={head}>
        <NotCaptured what="No prints in the window" why="The tape recorder has just started, or its socket is down — /api/health shows flowFeed." />
        {b && <BookRows b={b} />}
      </Frame>
    );
  }
  const delta = f.deltaVolume;
  const last = f.cvd.at(-1)?.cvd ?? null;
  const kct = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : fmt.n(v));
  return (
    <Frame bare={bare} title="BTC flow · perpetual"
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
      </More>
    </Frame>
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

// --------------------------------------------------------------------- skew

/** The skew section of the volatility card. */
function SkewRows({ data, rank }: { data: ChainResponse; rank: TermResponse['skew'] | null }) {
  const s = skew(data.legs, data.structure.atmIv);
  const rich = skewRichness(s.putCallPts, rank?.percentile ?? null);
  const tone = (v: 'HIGH' | 'NORMAL' | 'LOW') => (v === 'HIGH' ? 'down' : v === 'LOW' ? 'up' : 'muted');
  const iv = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
  return (
    <>
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
    </>
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
export function OptionFlowPanel({ perp, legs = [], atm = null, window: win, onWindow, bare = false }: { perp: PerpResponse | null; legs?: readonly Leg[]; atm?: number | null; window?: WindowChoice; onWindow?: (w: WindowChoice) => void; bare?: boolean }) {
  const f = perp?.optionFlow ?? null;
  const head = !bare && win && onWindow ? <WindowSelect value={win} onChange={onWindow} /> : null;
  // The side's own book, as far as Delta shows one: the at-the-money option's top of book.
  const atmLeg = (cp: 'C' | 'P') => legs.find((l) => l.cp === cp && l.strike === atm) ?? null;
  const bookOf = (l: Leg | null) => {
    if (!l || l.bidSize == null || l.askSize == null || l.bidSize + l.askSize === 0) return null;
    return (l.bidSize - l.askSize) / (l.bidSize + l.askSize);
  };
  const spreadOf = (l: Leg | null) => (l && l.bid !== null && l.ask !== null && l.bid + l.ask > 0 ? (l.ask - l.bid) / ((l.bid + l.ask) / 2) : null);
  const kct = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : fmt.n(v));
  if (!perp) return <Frame bare={bare} title="Option flow · CE / PE" right={head}><p className="ov-empty">Loading…</p></Frame>;
  if (!f || f.source === 'none') {
    return (
      <Frame bare={bare} title="Option flow · CE / PE" right={head}>
        <NotCaptured what="No option prints in the window" why="The tape recorder subscribes to every strike of the two nearest expiries; recording began 20 Sep 2026, or the socket is down — /api/health shows flowFeed." />
      </Frame>
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
    <Frame bare={bare} title="Option flow · CE / PE"
      right={<span className="ov-chain-head">{head}<small className={f.minutesCovered < f.windowMin ? 'ov-warn' : 'ov-muted'} title="Minutes in the window with at least one option print">{f.minutesCovered} of {f.windowMin} min · {f.expiry}</small></span>}>
      <div className="ov-flow-cards">
        {card('CE flow', 'CALL', f.ce, atmLeg('C'))}
        {card('PE flow', 'PUT', f.pe, atmLeg('P'))}
      </div>
      <div className="ov-flow-combined">
        <Row label="Total" value={`buy ${kct(f.combined.buyVolume)} · sell ${kct(f.combined.sellVolume)} · Δ ${fmt.signed(f.combined.deltaVolume)}`} />
        <Row label="Overall option flow" value={<Tag tone={biasTone}>{f.combined.bias ?? '—'}</Tag>} hint="The heaviest of the four legs names the bias when it is two-fifths of the volume; otherwise mixed. Call buying and put selling lean bullish; call selling and put buying, bearish" />
      </div>
    </Frame>
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

// ------------------------------------------------------------ price change

const IST_HM_PC = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * BTC now against then: the last minute out to half a day, since a held
 * position's entry (its first fill) when there is one, since the contract's day began (the previous 17:30 IST
 * settlement). Points and percent, from the server's cached candles.
 */
export function PriceChangePanel({ price, spot }: { price: { spot: number | null; rows: PriceChange[] } | null; spot: number | null }) {
  const rows = price?.rows ?? [];
  const label = (r: PriceChange) => r.mark === 'entry' ? `Since  entry ${IST_HM_PC.format(new Date(r.at))}` : r.mark === 'dayStart' ? 'last settlement 17:30' : r.minutes! >= 60 ? `${r.minutes! / 60}h` : `${r.minutes}m`;
  const now = price?.spot ?? spot;
  return (
    <Panel title="Price change" right={<small className="ov-muted">BTC {fmt.n(now)}</small>}>
      {rows.length === 0 ? <p className="ov-empty">No price record yet.</p> : (
        <table className="ov-mini ov-pchange">
          <thead><tr><th>Window</th><th>Then</th><th>Δ pts</th><th>Δ %</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const tone = r.pts === null ? 'ov-muted' : r.pts > 0 ? 'ov-up' : r.pts < 0 ? 'ov-down' : 'ov-muted';
              return (
                <tr key={`${r.mark ?? r.minutes}`} className={r.mark ? 'ov-pchange-mark' : undefined}>
                  <td title={`${IST_HM_PC.format(new Date(r.at))} IST`}>{label(r)}</td>
                  <td>{fmt.n(r.then)}</td>
                  <td className={tone}>{r.pts === null ? '—' : `${r.pts > 0 ? '+' : ''}${fmt.n(Math.round(r.pts))}`}</td>
                  <td className={tone}>{r.pct === null ? '—' : `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(2)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
