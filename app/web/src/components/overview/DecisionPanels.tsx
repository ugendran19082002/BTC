import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChainResponse, ExpiryOption, Leg } from '@/types/desk';
import { istLabel } from '@/lib/format';
import type { TradeStatus } from '@/types/trade';
import { getOptionHistory, type OptionHistoryPoint } from '@/api/desk';
import {
  breakeven, candidates, consensus, executionEstimate, expectedMove, ivRv, marginPerContract, modelView, odds,
  orderEstimate, payoffPrices, premiumAnalysis, premiumMomentum, shortLossAt, shortPayoff, CONTRACT_BTC,
  type BothAssessment, type ExpectedMove, type IvRv, type Readiness, type SideAssessment, type SideChoice,
} from '@/lib/overview';
import { SideCardsRow } from './RiskPanels';
import { pOtmBy, probabilityLabel, type ScreenConfig } from '@/lib/screen-config';
import { fmt, Panel, ProbBar, Row, Tag } from './parts';

export type Selected = { cp: 'C' | 'P'; strike: number };
export const findLeg = (legs: readonly Leg[], s: Selected | null) =>
  s ? legs.find((l) => l.cp === s.cp && l.strike === s.strike) ?? null : null;

// -------------------------------------------------------------- option chain

type ChainFilter = 'near' | 'all' | 'walls' | 'recommended';
type ChainCols = 'quotes' | 'greeks';

export function ChainPanel({ data, selected, onSelect, rows = 7, expiries, onExpiry }: {
  data: ChainResponse; selected: Selected | null; onSelect: (s: Selected) => void; rows?: number;
  expiries?: readonly ExpiryOption[]; onExpiry?: (expiry: string) => void;
}) {
  const { snapshot: snap, legs, structure } = data;
  const [filter, setFilter] = useState<ChainFilter>('near');
  const [cols, setCols] = useState<ChainCols>('quotes');
  const ceWall = (structure.ceOiWallNear ?? structure.ceOiWall)?.strike ?? null;
  const peWall = (structure.peOiWallNear ?? structure.peOiWall)?.strike ?? null;
  const maxPain = structure.maxPain?.strike ?? null;
  const strikes = useMemo(() => {
    const every = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
    if (filter === 'all') return every;
    if (filter === 'walls') {
      const marks = new Set([ceWall, peWall, maxPain, snap.atm].filter((k): k is number => k !== null));
      return every.filter((k) => marks.has(k) || [...marks].some((m) => Math.abs(k - m) <= snap.step));
    }
    if (filter === 'recommended') {
      const rec = new Set(legs.filter((l) => l.ev?.signal === 'sell' || l.ev?.signal === 'watch').map((l) => l.strike));
      return every.filter((k) => rec.has(k) || k === snap.atm);
    }
    const i = every.reduce((best, k, idx) => (Math.abs(k - snap.spot) < Math.abs(every[best]! - snap.spot) ? idx : best), 0);
    return every.slice(Math.max(0, i - rows), i + rows + 1);
  }, [legs, snap.spot, snap.atm, snap.step, rows, filter, ceWall, peWall, maxPain]);
  const byKey = useMemo(() => new Map(legs.map((l) => [`${l.cp}${l.strike}`, l])), [legs]);
  const iv = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const n = (v: number | null | undefined, p = 0) => (v === null || v === undefined ? '—' : fmt.n(v, p));
  const px = (v: number | null | undefined) => (v === null || v === undefined ? '—' : fmt.n(v, v < 10 ? 1 : 0));
  const cells = (l: Leg | undefined): string[] => {
    if (!l) return cols === 'quotes' ? ['—', '—', '—', '—', '—', '—', '—'] : ['—', '—', '—', '—'];
    return cols === 'quotes'
      ? [n(l.oi), l.oiChange ? fmt.signed(l.oiChange.change) : '—', px(l.bid), px(l.ask), px(l.mark), iv(l.iv), n(l.volume)]
      : [l.delta === null ? '—' : l.delta.toFixed(2), l.gamma === null ? '—' : l.gamma.toPrecision(2), l.theta === null ? '—' : l.theta.toFixed(1), l.vega === null ? '—' : l.vega.toFixed(1)];
  };
  const head = cols === 'quotes' ? ['OI', 'ΔOI', 'Bid', 'Ask', 'Mark', 'IV', 'Vol'] : ['Δ', 'Γ', 'Θ', 'V'];
  const mark = (k: number) => [
    k === snap.atm ? 'ATM' : null, k === ceWall ? 'CE wall' : null, k === peWall ? 'PE wall' : null, k === maxPain ? 'Max pain' : null,
  ].filter(Boolean).join(' · ');
  return (
    <Panel title={`Option chain · ${istLabel(snap.expiryTs)} (fixed expiry)`}
      right={
        <span className="ov-chain-head">
          {expiries && onExpiry && expiries.length > 0 ? (
            <select aria-label="Expiry" className="ov-select" value={snap.expiry} onChange={(e) => onExpiry(e.target.value)}>
              {!expiries.some((e) => e.expiry === snap.expiry) && <option value={snap.expiry}>{snap.expiry}</option>}
              {expiries.map((e) => (
                <option key={e.expiry} value={e.expiry}>
                  {e.isDefault ? '★ ' : ''}{e.expiry} · {e.hoursAway < 48 ? `${Math.round(e.hoursAway)}h` : `${Math.round(e.hoursAway / 24)}d`}
                  {e.isNextEntry ? ' · next entry' : e.isDaily ? ' · daily' : ''}
                </option>
              ))}
            </select>
          ) : <span>{snap.expiry}</span>}
          <select aria-label="Strikes shown" className="ov-select" value={filter} onChange={(e) => setFilter(e.target.value as ChainFilter)}>
            <option value="near">Near ATM (±{rows})</option>
            <option value="all">All strikes</option>
            <option value="walls">OI walls</option>
            <option value="recommended">Recommended</option>
          </select>
          <select aria-label="Columns" className="ov-select" value={cols} onChange={(e) => setCols(e.target.value as ChainCols)}>
            <option value="quotes">Quotes</option>
            <option value="greeks">Greeks</option>
          </select>
          <Tag tone="warn">ATM: {fmt.n(snap.atm)}</Tag>
          <Tag tone={snap.live ? 'accent' : 'muted'}>{snap.live ? 'Latest' : 'Past'}</Tag>
        </span>
      }>
      <div className="ov-chain-wrap">
        <table className="ov-chain">
          <thead>
            <tr><th colSpan={head.length} className="ov-calls">Calls (CE)</th><th /><th colSpan={head.length} className="ov-puts">Puts (PE)</th></tr>
            <tr>{head.map((h) => <th key={`c${h}`}>{h}</th>)}<th>Strike</th>{[...head].reverse().map((h) => <th key={`p${h}`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {strikes.map((k) => {
              const c = byKey.get(`C${k}`);
              const p = byKey.get(`P${k}`);
              const selC = selected?.cp === 'C' && selected.strike === k;
              const selP = selected?.cp === 'P' && selected.strike === k;
              const tag = mark(k);
              const cls = [k === snap.atm ? 'ov-atm' : '', k === ceWall ? 'ov-wall-ce' : '', k === peWall ? 'ov-wall-pe' : '', k === maxPain ? 'ov-maxpain' : ''].filter(Boolean).join(' ');
              return (
                <tr key={k} className={cls || undefined}>
                  <ChainSide leg={c} selected={selC} onClick={() => c && onSelect({ cp: 'C', strike: k })} cells={cells(c)} itm={c?.moneyness === 'ITM'} />
                  <td className="ov-strike" title={tag || undefined}>{fmt.n(k)}{tag && <small className="ov-strike-tag">{tag}</small>}</td>
                  <ChainSide leg={p} selected={selP} onClick={() => p && onSelect({ cp: 'P', strike: k })} cells={cells(p).reverse()} itm={p?.moneyness === 'ITM'} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ov-foot">Click a side to inspect it. Shaded = in the money · ATM, the OI walls and max pain are marked. {snap.hoursToExpiry.toFixed(1)}h to settlement. Every column of every strike is on the board below.</p>
    </Panel>
  );
}

function ChainSide({ leg, cells, selected, onClick, itm }: { leg: Leg | undefined; cells: string[]; selected: boolean; onClick: () => void; itm: boolean }) {
  return (
    <>
      {cells.map((v, i) => (
        <td key={i} className={`${selected ? 'ov-sel' : ''}${itm ? ' ov-itm' : ''}${leg ? ' ov-click' : ''}`}
          onClick={onClick} role={leg ? 'button' : undefined} tabIndex={leg && i === 0 ? 0 : undefined}
          onKeyDown={(e) => { if (leg && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}>
          {v}
        </td>
      ))}
    </>
  );
}

// ------------------------------------------------------------ selected strike

type Tab = 'metrics' | 'probability' | 'payoff' | 'scenario' | 'greeks' | 'momentum';

export function SelectedStrikePanel({ data, leg, em, iv, contracts, ivRank, probabilityMode = 'MODEL' }: {
  data: ChainResponse; leg: Leg | null; em: ExpectedMove; iv: IvRv | null; contracts: number;
  ivRank?: { percentile: number; days: number } | null; probabilityMode?: ScreenConfig['probabilityMode'];
}) {
  const [tab, setTab] = useState<Tab>('metrics');
  const symbol = leg ? `${leg.cp}-BTC-${leg.strike}-${data.snapshot.expiry}` : null;
  const history = useOptionHistory(symbol);
  if (!leg) return <Panel title="Selected strike"><p className="ov-empty">Click a strike on the chain.</p></Panel>;
  const side = leg.cp === 'C' ? 'CE' : 'PE';
  const g = (v: number | null | undefined, p: number) => (v === null || v === undefined ? '—' : v.toFixed(p));
  return (
    <Panel title={`Selected strike: ${fmt.n(leg.strike)} ${side}`} right={leg.ev?.signal ? <Tag tone={leg.ev.signal === 'sell' ? 'up' : leg.ev.signal === 'avoid' ? 'down' : 'muted'}>{leg.ev.signal}</Tag> : undefined}>
      <div className="ov-greeks">
        <Greek label="Delta" value={g(leg.delta, 2)} />
        <Greek label="Gamma" value={leg.gamma === null ? '—' : leg.gamma.toPrecision(2)} />
        <Greek label="Theta" value={g(leg.theta, 1)} />
        <Greek label="Vega" value={g(leg.vega, 1)} />
        <Greek label="Rho" value={g(leg.rho, 2)} />
        <Greek label="IV" value={leg.iv === null ? '—' : `${(leg.iv * 100).toFixed(1)}%`} />
      </div>
      <div className="ov-tabs" role="tablist">
        {(['metrics', 'probability', 'payoff', 'scenario', 'greeks', 'momentum'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'metrics' && <MetricsTab leg={leg} em={em} iv={iv} ivRank={ivRank ?? null} history={history} />}
      {tab === 'probability' && <ProbabilityTab leg={leg} mode={probabilityMode} />}
      {tab === 'payoff' && <PayoffTab leg={leg} spot={data.snapshot.spot} step={data.snapshot.step} contracts={contracts} />}
      {tab === 'scenario' && <ScenarioTab leg={leg} data={data} contracts={contracts} />}
      {tab === 'greeks' && <GreeksTab leg={leg} contracts={contracts} />}
      {tab === 'momentum' && <MomentumTab pts={history} />}
    </Panel>
  );
}

function Greek({ label, value }: { label: string; value: string }) {
  return <div className="ov-greek"><span>{label}</span><b>{value}</b></div>;
}

/** What each greek means for `contracts` short, in dollars: the sensitivity the seller actually carries. */
function GreeksTab({ leg, contracts }: { leg: Leg; contracts: number }) {
  const size = contracts * CONTRACT_BTC;
  const usd = (v: number | null, k = 1) => (v === null ? '—' : fmt.signed(-v * size * k, 2));
  return (
    <div>
      <Row label="Delta" value={`${leg.delta === null ? '—' : leg.delta.toFixed(3)} · ${usd(leg.delta)} per $1 of BTC`}
        hint="Short: the position's P&L per $1 move in BTC, in USD, for your size" />
      <Row label="Gamma" value={`${leg.gamma === null ? '—' : leg.gamma.toPrecision(3)} · delta changes ${leg.gamma === null ? '—' : (leg.gamma * 100).toFixed(3)} per $100`}
        hint="How fast delta moves as BTC moves; the seller's enemy near the strike" />
      <Row label="Theta" value={`${leg.theta === null ? '—' : leg.theta.toFixed(2)} / day · ${usd(leg.theta, -1)} a day for your size`}
        hint="Time decay per day per BTC; the seller's income" />
      <Row label="Vega" value={`${leg.vega === null ? '—' : leg.vega.toFixed(2)} · ${usd(leg.vega)} per IV point`}
        hint="P&L per one-point rise in implied volatility, short" />
      <Row label="IV" value={leg.iv === null ? '—' : `${(leg.iv * 100).toFixed(1)}%`} />
      <p className="ov-foot">Per contract is 0.001 BTC; figures are for {contracts} contracts, sign as the short sees it.</p>
    </div>
  );
}

/** The scenario table, in the tab the reference screen has it in as well as the panel below. */
function ScenarioTab({ leg, data, contracts }: { leg: Leg; data: ChainResponse; contracts: number }) {
  const premium = leg.sellPrice ?? leg.mark;
  if (premium === null) return <p className="ov-empty">No price to sell at.</p>;
  const rows = shortPayoff(leg.cp, leg.strike, premium, payoffPrices(leg.strike, data.snapshot.spot, data.snapshot.step, 5), contracts);
  return (
    <table className="ov-mini">
      <thead><tr><th>BTC at settlement</th><th>Move</th><th>P&amp;L ({contracts} ct)</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.price}>
            <td>{fmt.n(r.price)}</td>
            <td className="ov-muted">{fmt.signed(((r.price - data.snapshot.spot) / data.snapshot.spot) * 100, 1)}%</td>
            <td className={r.pnlUsd >= 0 ? 'ov-up' : 'ov-down'}>{fmt.signed(r.pnlUsd, 2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One contract's recorded five-minute history, refetched when the contract changes. Empty until the recorder has written. */
function useOptionHistory(symbol: string | null): OptionHistoryPoint[] | null {
  const [pts, setPts] = useState<OptionHistoryPoint[] | null>(null);
  useEffect(() => {
    let live = true;
    setPts(null);
    if (!symbol) return;
    getOptionHistory(symbol, 2).then((r) => { if (live) setPts(r.points); }).catch(() => { if (live) setPts([]); });
    return () => { live = false; };
  }, [symbol]);
  return pts;
}

function MetricsTab({ leg, em, iv, ivRank, history }: {
  leg: Leg; em: ExpectedMove; iv: IvRv | null; ivRank: { percentile: number; days: number } | null; history: OptionHistoryPoint[] | null;
}) {
  const p = premiumAnalysis(leg, em);
  if (!p) return <p className="ov-empty">No price on this strike.</p>;
  const mom = premiumMomentum(history ?? []);
  return (
    <div className="ov-two">
      <div>
        <Row label="Premium (mark)" value={`${fmt.n(p.premium, 1)}${leg.theoretical != null ? ` · BS ${fmt.n(leg.theoretical, 1)}` : ''}`} hint="Mark, and Black–Scholes at the mark IV" />
        <Row label="Intrinsic" value={fmt.n(p.intrinsic, 1)} />
        <Row label="Extrinsic" value={`${fmt.n(p.extrinsic, 1)} (${fmt.pct(p.extrinsicShare)})`} />
        <Row label="Decay (|θ| per hour)" value={p.thetaPerHour === null ? '—' : `${fmt.n(p.thetaPerHour, 2)} / h`}
          hint="Delta's theta is per day; within a day of settlement the per-hour figure is the one to read" />
        <Row label="Spread" value={p.spreadPct === null ? '—' : fmt.pct(p.spreadPct, 1)} tone={p.spreadPct !== null && p.spreadPct > 0.1 ? 'warn' : undefined} />
      </div>
      <div>
        <Row label="Premium / EM" value={p.premiumPerEm === null ? '—' : fmt.pct(p.premiumPerEm, 1)} />
        <Row label="Distance / EM" value={p.emDistance === null ? '—' : `${p.emDistance.toFixed(2)}×`} tone={p.emDistance !== null && p.emDistance < 1 ? 'warn' : undefined} />
        <Row label="IV − RV" value={iv ? `${fmt.signed(iv.spreadPts, 1)} pts` : '—'} />
        <Row label="IV percentile" value={ivRank ? `${fmt.pct(ivRank.percentile)} (${ivRank.days < 1 ? 'today' : `${Math.round(ivRank.days)}d`})` : '—'} hint="ATM IV among every recorded reading since 17 Sep 2026" />
        <Row label="Premium velocity" value={mom.velocity === null ? '—' : `${fmt.signed(mom.velocity, 1)} / 5m`} tone={mom.velocity === null ? undefined : mom.velocity > 0 ? 'down' : 'up'} hint="Mark change over the last recorded five minutes; rising premium is against a short" />
        <Row label="Premium acceleration" value={mom.acceleration === null ? '—' : fmt.signed(mom.acceleration, 1)} hint="The change of the velocity" />
        <Row label="OI change" value={leg.oiChange ? `${fmt.signed(leg.oiChange.change)} (${leg.oiChange.overMinutes}m)` : '—'} />
        <Row label="Breakeven" value={fmt.n(breakeven(leg.cp, leg.strike, p.premium))} />
      </div>
    </div>
  );
}

function ProbabilityTab({ leg, mode }: { leg: Leg; mode: ScreenConfig['probabilityMode'] }) {
  const o = odds(leg);
  const by = pOtmBy(mode, leg, o.modelOtm);
  const name = probabilityLabel(mode);
  return (
    <div>
      <ProbBar label={`${o.source === 'measured' ? 'Measured' : name} P(expire OTM)`} value={o.source === 'measured' ? o.pOtm : by} tone="up" />
      <ProbBar label={`${o.source === 'measured' ? 'Measured' : name} P(expire beyond strike) = P(ITM)`} value={o.source === 'measured' ? o.pItm : by === null ? null : 1 - by} tone="down" />
      <ProbBar label="P(touch strike before expiry)" value={o.pTouch} tone="muted" />
      <Row label="|Delta| (rough P(ITM))" value={o.deltaApprox === null ? '—' : o.deltaApprox.toFixed(2)} />
      <Row label="Model P(OTM) / P(ITM)" value={`${fmt.pct(o.modelOtm)} / ${o.modelOtm === null ? '—' : fmt.pct(1 - o.modelOtm)}`} />
      <Row label="Delta P(OTM) / P(ITM)" value={o.deltaApprox === null ? '—' : `${fmt.pct(1 - o.deltaApprox)} / ${fmt.pct(o.deltaApprox)}`} />
      <Row label="P(stop breach)" value="not modelled" tone="muted" hint="The odds of the premium reaching a stop are not measured; touching the strike and expiring beyond it are different events from it" />
      <p className="ov-foot">P(OTM) is {o.source === 'measured' ? 'the desk’s measured settlement record, adjusted' : o.source === 'model' ? 'the model — no measured record for this distance' : 'not readable'}.</p>
    </div>
  );
}

function PayoffTab({ leg, spot, step, contracts }: { leg: Leg; spot: number; step: number; contracts: number }) {
  const premium = leg.sellPrice ?? leg.mark;
  if (premium === null) return <p className="ov-empty">No price to sell at.</p>;
  const prices = payoffPrices(leg.strike, spot, step, 3);
  const rows = shortPayoff(leg.cp, leg.strike, premium, prices, contracts);
  return (
    <div className="ov-two">
      <table className="ov-mini">
        <thead><tr><th>BTC at expiry</th><th>P&amp;L (USD)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.price}><td>{fmt.n(r.price)}</td><td className={r.pnlUsd >= 0 ? 'ov-up' : 'ov-down'}>{fmt.signed(r.pnlUsd, 2)}</td></tr>
          ))}
        </tbody>
      </table>
      <PayoffChart rows={rows} strike={leg.strike} />
      <p className="ov-foot">Short {contracts} contracts at {fmt.n(premium, 1)}, held to settlement, before fees. Breakeven {fmt.n(breakeven(leg.cp, leg.strike, premium))}.</p>
    </div>
  );
}

export function PayoffChart({ rows, strike }: { rows: { price: number; pnlUsd: number }[]; strike: number }) {
  const W = 220, H = 110, P = 14;
  if (rows.length < 2) return null;
  const xs = rows.map((r) => r.price), ys = rows.map((r) => r.pnlUsd);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  const px = (x: number) => P + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * P);
  const py = (y: number) => H - P - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * P);
  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${px(r.price).toFixed(1)},${py(r.pnlUsd).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ov-svg" role="img" aria-label="Payoff at expiry">
      <line x1={P} x2={W - P} y1={py(0)} y2={py(0)} className="ov-axis" strokeDasharray="3 3" />
      <line x1={px(strike)} x2={px(strike)} y1={P} y2={H - P} className="ov-axis" />
      <path d={d} fill="none" className="ov-line-payoff" />
    </svg>
  );
}

/**
 * Premium momentum: how this strike's premium, OI and IV moved over the last
 * 5, 15 and 60 minutes, from the recorded five-minute snapshots. Empty until
 * the recorder has written enough -- it never extrapolates.
 */
function MomentumTab({ pts }: { pts: OptionHistoryPoint[] | null }) {
  if (!pts) return <p className="ov-empty">Loading…</p>;
  const last = pts.at(-1);
  if (!last) return <p className="ov-empty">No recorded snapshots for this strike yet — the recorder writes every 5 minutes.</p>;
  const back = (min: number) => pts.filter((p) => p.at <= last.at - min * 60_000).at(-1) ?? null;
  const change = (a: number | null | undefined, b: number | null | undefined, pct = true) =>
    a == null || b == null ? null : pct ? (b === 0 ? null : a / b - 1) : a - b;
  return (
    <table className="ov-mini">
      <thead><tr><th /><th>5m</th><th>15m</th><th>30m</th><th>1h</th></tr></thead>
      <tbody>
        {([
          ['Premium', (p: OptionHistoryPoint | null) => fmt.pct(change(last.mark, p?.mark), 1)],
          ['Open interest', (p: OptionHistoryPoint | null) => fmt.pct(change(last.oi, p?.oi), 1)],
          ['IV (pts)', (p: OptionHistoryPoint | null) => { const d = change(last.markIv, p?.markIv, false); return d === null ? '—' : fmt.signed(d * 100, 1); }],
          ['BTC', (p: OptionHistoryPoint | null) => fmt.pct(change(last.spot, p?.spot), 2)],
        ] as const).map(([label, f]) => (
          <tr key={label}><td>{label}</td><td>{f(back(5))}</td><td>{f(back(15))}</td><td>{f(back(30))}</td><td>{f(back(60))}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------ model and EM

export function ModelViewPanel({ data, iv, horizonMin = 720, em: emIn }: { data: ChainResponse; iv: IvRv | null; horizonMin?: number; em?: (ExpectedMove & { method?: string }) | null }) {
  const v = modelView(data.outlook, horizonMin);
  const c = consensus(data.outlook);
  const em = emIn === undefined ? expectedMove(data.snapshot) : emIn;
  const label = v?.label ?? `${horizonMin >= 60 ? `${horizonMin / 60}h` : `${horizonMin}m`}`;
  return (
    <Panel title={`Model view (${label})`} right={v ? <Tag tone="muted">{v.source === 'measured' ? 'measured' : 'history only'}</Tag> : undefined}>
      <div className="ov-two">
        <div>
          <ProbBar label="Up" value={v?.pUp ?? null} tone="up" />
          <ProbBar label="Down" value={v?.pDown ?? null} tone="down" />
          <ProbBar label="Range" value={v && v.source === 'measured' ? v.pSide : null} tone="muted" />
          <p className="ov-foot">{c.scored ? `Horizons: ${c.up} up · ${c.down} down · ${c.flat} flat${c.agree ? '' : ' — no consensus'}` : 'No horizon readable.'}</p>
        </div>
        <div>
          <Row label={`Expected move (${label})`} value={em ? `±${fmt.n(em.move)}` : '—'} hint={em && 'method' in em ? String(em.method) : undefined} />
          <Row label="Upper / lower" value={em ? `${fmt.n(em.upper)} / ${fmt.n(em.lower)}` : '—'} />
          <Row label="Over" value={em ? `${em.hours.toFixed(1)}h` : '—'} />
          <Row label="IV / realised" value={iv ? `${iv.ivPct.toFixed(1)}% / ${iv.rvPct.toFixed(1)}%` : '—'} />
          <Row label="IV − RV" value={iv ? <Tag tone={iv.label === 'rich' ? 'up' : iv.label === 'cheap' ? 'down' : 'muted'}>{iv.label}</Tag> : '—'} />
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------ the decision

export function StrategyDecisionPanel({ data, sides, both, choice, onSelect }: {
  data: ChainResponse; sides: SideAssessment[]; both: BothAssessment; choice: SideChoice; onSelect: (s: Selected) => void;
}) {
  const tone = choice.side === 'NO_TRADE' ? 'down' : choice.side === 'BOTH' ? 'up' : 'accent';
  return (
    <Panel title="Strategy decision" right={<Tag tone={tone}>Desk side: {choice.side.replace('_', ' ')}</Tag>}>
      <SideCardsRow sides={sides} both={both} onSelect={(cp, strike) => onSelect({ cp, strike })} />
      <p className="ov-foot">{choice.why}. {data.best.why ?? ''} Side from the regime, the horizon consensus and each side's gates — never the score alone.</p>
    </Panel>
  );
}


export function SellRecommendationPanel({ data, onSelect, onSell, leverage, contracts, iv, em, first = 'P' }: {
  data: ChainResponse; onSelect: (s: Selected) => void; onSell?: (l: Leg) => void; leverage: number; contracts: number;
  iv: IvRv | null; em: ExpectedMove; first?: 'C' | 'P';
}) {
  const spot = data.snapshot.spot;
  const order: readonly ('C' | 'P')[] = first === 'P' ? ['P', 'C'] : ['C', 'P'];
  return (
    <Panel title="Sell recommendation" right={<small className="ov-muted">{contracts} ct at {leverage}x · top 3 a side · margin est.</small>}>
      {order.map((side) => {
        const rows = candidates(data.legs, side, 3);
        return (
          <div key={side} className="ov-reco-side">
            <h4>{side === 'C' ? 'CE side' : 'PE side'}</h4>
            {rows.length === 0 ? <p className="ov-empty">Nothing on this side clears the desk’s rules.</p> : (
              <table className="ov-mini ov-reco">
                <thead><tr><th>Strike</th><th>Type</th><th>Premium</th><th>POP</th><th>P(touch)</th><th>Dist/EM</th><th>IV−RV</th><th>θ/prem</th><th>Exp. P&amp;L</th><th>Tail (2×EM)</th><th>Margin</th><th>R/R</th><th>Score</th><th /></tr></thead>
                <tbody>
                  {rows.map((l) => {
                    const o = odds(l);
                    const px = l.sellPrice ?? l.mark;
                    const est = px === null ? null : orderEstimate(l.cp, l.strike, px, spot, leverage, contracts);
                    const pa = premiumAnalysis(l, em);
                    const adverse = em ? (l.cp === 'C' ? spot + 2 * em.move : spot - 2 * em.move) : null;
                    const tail = px !== null && adverse !== null ? shortLossAt(l.cp, l.strike, px, adverse, contracts) : null;
                    const rr = tail !== null && tail > 0 && l.ev?.evUsd != null ? l.ev.evUsd / tail : null;
                    return (
                      <tr key={l.strike} className="ov-click" onClick={() => onSelect({ cp: l.cp, strike: l.strike })}>
                        <td>{fmt.n(l.strike)}</td>
                        <td>{l.cp === 'C' ? 'CE' : 'PE'}</td>
                        <td>{fmt.n(px, 1)}</td>
                        <td className="ov-up">{fmt.pct(o.pOtm)}</td>
                        <td>{fmt.pct(o.pTouch)}</td>
                        <td>{l.emDistance === null ? '—' : `${l.emDistance.toFixed(2)}×`}</td>
                        <td>{iv ? fmt.signed(iv.spreadPts, 0) : '—'}</td>
                        <td>{pa?.thetaPerPremiumDay == null ? '—' : fmt.pct(Math.min(9.99, pa.thetaPerPremiumDay), 0)}</td>
                        <td className={l.ev?.evUsd == null ? '' : l.ev.evUsd >= 0 ? 'ov-up' : 'ov-down'}>{fmt.signed(l.ev?.evUsd ?? null, 2)}</td>
                        <td className="ov-down" title="Loss at an adverse move of two expected moves; a naked short has no bounded worst case">{tail === null ? '—' : `$${tail.toFixed(2)}`}</td>
                        <td>{est ? fmt.n(est.marginUsd, 2) : '—'}</td>
                        <td title="Expected P&L per dollar of tail loss">{rr === null ? '—' : `${(rr * 100).toFixed(0)}¢`}</td>
                        <td>{l.score === null ? '—' : (l.score * 10).toFixed(1)}</td>
                        <td>{onSell && <button className="ov-sell" onClick={(e) => { e.stopPropagation(); onSell(l); }}>Sell</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

// ------------------------------------------------------- checklist and order

export function EntryPanel({ data, leg, other, ready, onSell, contracts, leverage, side, onSide, execution = 'BID', feeMultiplier = 1 }: {
  data: ChainResponse; leg: Leg | null; other: Leg | null; ready: Readiness; onSell?: (l: Leg) => void; contracts: number; leverage: number;
  side: 'CE' | 'PE' | 'BOTH'; onSide: (s: 'CE' | 'PE' | 'BOTH') => void; execution?: ScreenConfig['execution']; feeMultiplier?: number;
}) {
  const spot = data.snapshot.spot;
  // The price the order is judged at: the bid (what a short receives), a tick under it when the bid is thin, or the mark on request -- which is not executable, and says so.
  const exe0 = leg ? executionEstimate(leg, spot, contracts) : null;
  const premium = leg ? (execution === 'MARK' ? leg.mark : execution === 'DEPTH' ? exe0?.expectedFill ?? leg.bid : leg.bid ?? leg.sellPrice) : null;
  const est = leg && premium !== null ? orderEstimate(leg.cp, leg.strike, premium, spot, leverage, contracts) : null;
  const exe = exe0 && est ? { ...exe0, feeUsd: exe0.feeUsd * feeMultiplier, netPremiumUsd: exe0.netPremiumUsd === null ? null : exe0.netPremiumUsd - exe0.feeUsd * (feeMultiplier - 1) } : exe0;
  const legs = side === 'BOTH' ? [leg, other].filter((l): l is Leg => l !== null) : leg ? [leg] : [];
  const label = side === 'BOTH' ? `Sell both (${legs.map((l) => `${fmt.n(l.strike)} ${l.cp === 'C' ? 'CE' : 'PE'}`).join(' + ')})` : leg ? `Place sell order (${fmt.n(leg.strike)} ${leg.cp === 'C' ? 'CE' : 'PE'})` : 'Select a strike';
  return (
    <div className="ov-entry">
      <Panel title={`Entry checklist (${ready.gates.length} gates)`} className="ov-grow"
        right={<Tag tone={ready.ready ? 'up' : 'down'}>{ready.verdict}{ready.ready ? '' : ` · ${ready.failing} failing${ready.unknown ? `, ${ready.unknown} unreadable` : ''}`}</Tag>}>
        <ul className="ov-checks ov-checks-dense">
          {ready.gates.map((g) => (
            <li key={g.key} className={g.ok === true ? 'ok' : g.ok === false ? 'bad' : 'unknown'}>
              <span aria-hidden>{g.ok === true ? '✓' : g.ok === false ? '✕' : '?'}</span>{g.text}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Order panel" right={<small className={execution === 'MARK' ? 'ov-warn' : 'ov-muted'}>{execution === 'MARK' ? 'priced at mark — not executable' : execution === 'DEPTH' ? 'priced at the estimated fill' : 'priced at the bid'}{feeMultiplier !== 1 ? ` · fee ×${feeMultiplier}` : ''}</small>}>
        <div className="ov-tabs ov-side-toggle" role="tablist">
          {(['CE', 'PE', 'BOTH'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} className={side === s ? 'on' : ''} onClick={() => onSide(s)}>
              {s === 'BOTH' ? 'Both' : `Sell ${s}`}
            </button>
          ))}
        </div>
        <button className="ov-place" disabled={legs.length === 0 || !onSell} onClick={() => legs[0] && onSell?.(legs[0])}
          title={legs.length === 0 ? 'Select a strike on the chain' : side === 'BOTH' ? 'Opens the ticket for the first leg; place the second from the other side after it fills' : ready.ready ? 'Opens the order ticket — every gate runs again on the server' : 'Not every gate is green; the ticket still opens, and the server decides'}>
          {label}
        </button>
        <Row label="Selected strike" value={leg ? `${fmt.n(leg.strike)} ${leg.cp === 'C' ? 'CE' : 'PE'}` : '—'} />
        <Row label="Entry bid" value={`${fmt.n(exe?.bid ?? null, 1)}${exe?.bidSize != null ? ` × ${fmt.n(exe.bidSize)}` : ''}`} hint="A short fills at the bid, not the mark" />
        <Row label="Estimated fill" value={fmt.n(exe?.expectedFill ?? null, 1)} tone={exe?.thin ? 'warn' : undefined} hint={exe?.thin ? 'The bid is thinner than your size: a tick under it' : 'The bid is deep enough for your size'} />
        <Row label="Quantity · leverage" value={`${fmt.n(contracts)} ct · ${leverage}x`} />
        <Row label={`Premium (${execution === 'MARK' ? 'mark' : execution === 'DEPTH' ? 'est. fill' : 'bid'})`} value={est ? `$${est.creditUsd.toFixed(2)}` : '—'} hint="price × contracts × 0.001 BTC" />
        <Row label="Fees (est.)" value={exe ? `$${exe.feeUsd.toFixed(2)}` : '—'} hint={feeMultiplier !== 1 ? `Delta's rate × ${feeMultiplier}` : "Delta's taker rate, capped at 3.5% of premium"} />
        <Row label="Slippage (est.)" value={exe?.slippagePerBtc == null ? '—' : `$${(exe.slippagePerBtc * contracts * CONTRACT_BTC).toFixed(2)}`} />
        <Row label="Net premium" value={exe?.netPremiumUsd == null ? '—' : `$${exe.netPremiumUsd.toFixed(2)}`} tone="up" />
        <Row label="Margin required (est.)" value={est ? `$${est.marginUsd.toFixed(2)}` : '—'} />
        <Row label="Break-even (after fees)" value={est ? fmt.n(est.breakevenAfterFees) : '—'} />
        <Row label="Max risk" value={leg?.ev?.maxLossUsd == null ? 'unbounded (naked)' : `$${leg.ev.maxLossUsd.toFixed(2)}`} tone="down" />
        <Row label="Position size" value={`${fmt.n(contracts * (side === 'BOTH' ? 2 : 1))} ct · ${(contracts * CONTRACT_BTC * (side === 'BOTH' ? 2 : 1)).toFixed(3)} BTC`} />
      </Panel>
    </div>
  );
}

// --------------------------------------------------------------- screen bar

const IST_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const istHm = (epochSeconds: number) => IST_HM.format(new Date(epochSeconds * 1000));

/** The top of the reference screens: the desk's name, the IST clock, the mode, and the controls. */
export function ScreenBar({ data, now, controls, error }: { data: ChainResponse; now: number; controls?: ReactNode; error?: string | null }) {
  return (
    <header className="ov-screenbar">
      <div className="ov-brand">
        <span className="btc-logo" aria-hidden>₿</span>
        <span><b>BTC Options Desk</b><small>Delta Exchange (India) · Option selling intelligence</small></span>
      </div>
      <div className="ov-screenbar-right">
        {error && <Tag tone="down">{error}</Tag>}
        <span className="ov-clock">{IST_CLOCK.format(new Date(now)).replace(/,/g, '')} IST</span>
        <Tag tone={data.snapshot.live ? 'up' : 'muted'}>{data.snapshot.live ? '● Live' : 'Past'}</Tag>
        {controls}
      </div>
    </header>
  );
}

/**
 * The contract's day, at the head of the decision column: entry at 05:30,
 * settlement at 17:30, and how long is left -- with the expected move and
 * the volatility it is priced from beside it, as the second reference screen
 * lays them out.
 */
export function ExpiryHeader({ data, now }: { data: ChainResponse; now: number }) {
  const snap = data.snapshot;
  const em = expectedMove(snap);
  const iv = ivRvOf(data);
  const leftMs = Math.max(0, snap.expiryTs * 1000 - now);
  const h = Math.floor(leftMs / 3_600_000), m = Math.floor((leftMs % 3_600_000) / 60_000);
  return (
    <div className="ov-expiry">
      <div className="ov-expiry-head">
        <span>🕒 05:30 → {istHm(snap.expiryTs)} IST ({snap.isDaily || snap.isNextEntry ? 'daily expiry' : 'not the tested contract'})</span>
        <span className="ov-muted">Time to expiry <b>{snap.live ? `${h}h ${String(m).padStart(2, '0')}m` : `${snap.hoursToExpiry.toFixed(1)}h at the snapshot`}</b></span>
      </div>
      <div className="ov-expiry-cards">
        <div className="ov-mini-card">
          <span className="ov-kpi-label">Expected move</span>
          <b className="ov-kpi-value">{em ? `±${fmt.n(em.move)}` : '—'}</b>
          <span className="ov-kpi-sub">{em ? `${fmt.n(em.lower)} – ${fmt.n(em.upper)} · ${em.hours.toFixed(1)}h` : 'no IV'}</span>
        </div>
        <div className="ov-mini-card">
          <span className="ov-kpi-label">Volatility</span>
          <Row label="IV" value={iv ? `${iv.ivPct.toFixed(1)}%` : '—'} />
          <Row label="Realised (21d)" value={iv ? `${iv.rvPct.toFixed(1)}%` : '—'} />
          <Row label="IV − RV" value={iv ? <Tag tone={iv.label === 'rich' ? 'up' : iv.label === 'cheap' ? 'down' : 'muted'}>IV {iv.label}</Tag> : '—'} />
        </div>
      </div>
    </div>
  );
}

const ivRvOf = (data: ChainResponse) => ivRv(data.structure.atmIv, data.market?.realisedVol ?? null);

// --------------------------------------------------------------- status bar

export function StatusBar({ data, trade, now, leverage, refreshEverySec = null, marginUsedPct, freshnessSec = 30 }: {
  data: ChainResponse; trade: TradeStatus | null; now: number; leverage: number; refreshEverySec?: number | null; marginUsedPct?: number | null; freshnessSec?: number;
}) {
  const age = Math.max(0, Math.round((now - data.snapshot.ts * 1000) / 1000));
  const measured = Boolean(data.outlook.model);
  const nextIn = refreshEverySec === null || !data.snapshot.live ? null : Math.max(0, refreshEverySec - (age % refreshEverySec));
  const net = trade?.today?.netUsd ?? null;
  // Margin behind what is short, at the ticket's leverage, against the balance. An estimate: Delta's figure is on the Positions tab.
  const shortCt = trade ? trade.open.reduce((a, t) => a + Math.max(0, -t.position), 0) : 0;
  const marginUsed = marginUsedPct !== undefined ? marginUsedPct : trade?.balanceUsd != null && trade.balanceUsd > 0 && shortCt > 0
    ? (shortCt * marginPerContract(data.snapshot.spot, leverage, 0)) / trade.balanceUsd : trade?.balanceUsd != null ? 0 : null;
  return (
    <footer className="ov-status">
      <Tag tone={trade?.mode === 'live' ? 'down' : 'accent'}>{trade?.mode === 'live' ? 'LIVE' : 'Paper'} · short premium</Tag>
      <Tag tone={data.snapshot.live && age <= freshnessSec ? 'up' : 'warn'}>{data.snapshot.live ? `Live data · ${age}s old` : 'Past snapshot'}</Tag>
      <Tag tone={measured ? 'up' : 'muted'}>{measured ? `Models ready · ${data.outlook.model!.name}${data.outlook.model!.measuredAt ? ` · ${data.outlook.model!.measuredAt.slice(0, 10)}` : ''}` : 'Model: desk figures only'}</Tag>
      <span className="ov-muted">{nextIn === null ? (data.snapshot.live ? 'Auto-refresh off' : `Snapshot ${istLabel(data.snapshot.ts)}`) : `Next update: ${String(Math.floor(nextIn / 60)).padStart(2, '0')}:${String(nextIn % 60).padStart(2, '0')}`}</span>
      <span className="ov-grow" />
      <span>Day P&amp;L <b className={net === null ? '' : net >= 0 ? 'ov-up' : 'ov-down'}>{net === null ? '—' : `${net >= 0 ? '+' : '−'}$${Math.abs(net).toFixed(2)}`}</b></span>
      <span>Open positions <b>{trade?.open.length ?? '—'}</b></span>
      <span>Balance <b>{trade?.balanceUsd == null ? '—' : `$${trade.balanceUsd.toFixed(2)}`}</b></span>
      <span title="The day's loss against the daily loss limit">Risk used <b>{trade?.today && trade.limits.maxDailyLossUsd > 0 ? fmt.pct(Math.max(0, -trade.today.netUsd) / trade.limits.maxDailyLossUsd, 0) : '—'}</b></span>
      <span title="Margin behind the open shorts at the ticket's leverage, as a share of the balance (estimate)">Margin used <b className={marginUsed !== null && marginUsed > 0.5 ? 'ov-warn' : ''}>{marginUsed === null ? '—' : fmt.pct(marginUsed, 1)}</b>
        {marginUsed !== null && <span className="ov-meter" aria-hidden><span style={{ width: `${Math.min(100, marginUsed * 100)}%` }} /></span>}</span>
    </footer>
  );
}

// ------------------------------------------------------------- scenario P&L

/**
 * The selected short held to settlement, across the prices around it: the same
 * arithmetic as the Payoff tab, given its own panel in the bottom row the way
 * the reference screens lay it out.
 */
export function ScenarioPanel({ data, leg, contracts }: { data: ChainResponse; leg: Leg | null; contracts: number }) {
  const premium = leg ? (leg.sellPrice ?? leg.mark) : null;
  if (!leg || premium === null) {
    return <Panel title="Scenario P&amp;L"><p className="ov-empty">Select a strike with a price to see its payoff.</p></Panel>;
  }
  const side = leg.cp === 'C' ? 'CE' : 'PE';
  const rows = shortPayoff(leg.cp, leg.strike, premium, payoffPrices(leg.strike, data.snapshot.spot, data.snapshot.step, 4), contracts);
  return (
    <Panel title={`Scenario P&L (short ${fmt.n(leg.strike)} ${side})`}
      right={<small className="ov-muted">{contracts} contracts · at settlement · before fees</small>}>
      <div className="ov-two">
        <table className="ov-mini">
          <thead><tr><th>BTC price</th><th>P&amp;L (USD)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.price} className={Math.round(data.snapshot.spot / data.snapshot.step) * data.snapshot.step === r.price ? 'ov-atm' : undefined}>
                <td>{fmt.n(r.price)}</td>
                <td className={r.pnlUsd >= 0 ? 'ov-up' : 'ov-down'}>{fmt.signed(r.pnlUsd, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <PayoffChart rows={rows} strike={leg.strike} />
      </div>
      <p className="ov-foot">Breakeven {fmt.n(breakeven(leg.cp, leg.strike, premium))} · premium {fmt.n(premium, 1)} per BTC · max profit ${(premium * contracts * CONTRACT_BTC).toFixed(2)}, loss unbounded without a hedge.</p>
    </Panel>
  );
}
