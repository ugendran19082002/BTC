
import type { ChainResponse, Leg, MarketRead } from '@/types/desk';
import type { FlowSummary, PerpResponse, PriceChange, SideFlow } from '@/api/desk';
import { fundingRead, volRegime, WINDOW_CHOICES, windowLabel, type IvRv, type WindowChoice } from '@/lib/overview';
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
function nextFundingIn(nowMs: number): string {
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
function Sparkline({ values, tone }: { values: readonly number[]; tone?: 'up' | 'down' }) {
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

// --------------------------------------------------------------------- flow

/**
 * Who is crossing the spread, on the perpetual and on the options, in one card
 * (22 Sep 2026): the two were separate cards reading the same tape over the
 * same window, and read together -- is the perp being bought, and are calls
 * or puts. One window picker drives both.
 */
export function FlowPanel({ perp, legs, atm, window: win, onWindow }: {
  perp: PerpResponse | null; legs: readonly Leg[]; atm: number | null;
  window: WindowChoice; onWindow: (w: WindowChoice) => void;
}) {
  return (
    <Panel name="Flow" title="Flow · BTC perpetual & options" right={<WindowSelect value={win} onChange={onWindow} />}>
      <TradeFlowPanel bare perp={perp} />
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
function TradeFlowPanel({ perp, window: win, onWindow, bare = false }: { perp: PerpResponse | null; window?: WindowChoice; onWindow?: (w: WindowChoice) => void; bare?: boolean }) {
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
  // The three volumes on one scale -- the larger side is the full bar -- so the lean is seen before it is read.
  const scale = Math.max(f.buyVolume, f.sellVolume);
  const share = (v: number) => (scale > 0 ? Math.abs(v) / scale : null);
  return (
    <Frame bare={bare} title="BTC flow · perpetual"
      right={<span className="ov-chain-head">{head}<small className={f.minutesCovered < f.windowMin ? 'ov-warn' : 'ov-muted'} title="Minutes in the window with at least one print">{f.minutesCovered} of {f.windowMin} min</small></span>}>
      <Row mark="dot" tone="up" label="Buy volume" bar={share(f.buyVolume)} value={`${kct(f.buyVolume)} ct`} hint="Contracts bought by the aggressor: buys that lifted the offer" />
      <Row mark="dot" tone="down" label="Sell volume" bar={share(f.sellVolume)} value={`${kct(f.sellVolume)} ct`} hint="Contracts sold by the aggressor: sells that hit the bid" />
      <Row mark="dot" tone={delta > 0 ? 'up' : delta < 0 ? 'down' : 'muted'} label="Delta volume" bar={share(delta)} value={`${delta > 0 ? '+' : ''}${kct(delta)} ct`} hint="Buy volume minus sell volume" />
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


// ------------------------------------------------------------ option flow

/**
 * The options' own tape, a side at a time: who crossed the spread on the
 * calls and on the puts over the window, from the desk's record of every
 * print on the two nearest expiries. Book imbalance and spread are the
 * perpetual's -- options have no book capture -- and are said so.
 */
function OptionFlowPanel({ perp, legs = [], atm = null, window: win, onWindow, bare = false }: { perp: PerpResponse | null; legs?: readonly Leg[]; atm?: number | null; window?: WindowChoice; onWindow?: (w: WindowChoice) => void; bare?: boolean }) {
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
function WindowSelect({ value, onChange }: { value: WindowChoice; onChange: (w: WindowChoice) => void }) {
  return (
    <select className="ov-select" aria-label="Window" value={value} onChange={(e) => onChange(e.target.value as WindowChoice)} title="How far back the tape is summed">
      {WINDOW_CHOICES.map((w) => <option key={w} value={w}>{windowLabel(w)}</option>)}
    </select>
  );
}

const IST_HM_PC = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Price change: BTC now against each window back -- the last minute out to half
 * a day -- and against the desk's own marks, the first entry of the open
 * positions and the last 17:30 settlement. One tile a window, side by side
 * across the screen, wrapping on a phone: an arrow and a sign for the way, the
 * points, the percent under them. Back on the Live screen on 4 Oct 2026.
 */
export function PriceChangePanel({ price, spot }: { price: { spot: number | null; rows: PriceChange[] } | null; spot: number | null }) {
  const rows = price?.rows ?? [];
  const label = (r: PriceChange) => r.mark === 'entry' ? `Since entry ${IST_HM_PC.format(new Date(r.at))}` : r.mark === 'dayStart' ? 'Last settlement 17:30' : r.minutes! >= 60 ? `${r.minutes! / 60}h` : `${r.minutes}m`;
  const now = price?.spot ?? spot;
  return (
    <Panel title="Price change" right={<small className="ov-muted">BTC {fmt.n(now)}</small>}>
      {rows.length === 0 ? <p className="ov-empty">No price record yet.</p> : (
        <ul className="ov-pc-strip" aria-label="price change">
          {rows.map((r) => {
            const way = r.pts === null ? 'flat' : r.pts > 0 ? 'up' : r.pts < 0 ? 'down' : 'flat';
            const tone = way === 'up' ? 'ov-up' : way === 'down' ? 'ov-down' : 'ov-muted';
            return (
              <li key={`${r.mark ?? r.minutes}`} className={`ov-pc-tile ov-pc-${way}${r.mark ? ' ov-pc-mark' : ''}`}
                  title={`BTC was ${fmt.n(r.then)} at ${IST_HM_PC.format(new Date(r.at))} IST`}>
                <span className="ov-pc-label">{label(r)}</span>
                <b className={`ov-pc-pts ${tone}`}>
                  {r.pts === null ? '—' : <><i aria-hidden>{way === 'up' ? '▲' : way === 'down' ? '▼' : '■'}</i>{`${r.pts > 0 ? '+' : ''}${fmt.n(Math.round(r.pts))}`}</>}
                </b>
                <small className="ov-pc-pct">{r.pct === null ? '—' : `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(2)}%`}</small>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
