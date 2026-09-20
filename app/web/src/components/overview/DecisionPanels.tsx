import { useEffect, useMemo, useRef } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { ChainResponse, Leg } from '@/types/desk';
import { istLabel } from '@/lib/format';
import {
  breakeven, executionRead, odds, payoffPrices, premiumAnalysis, shortPayoff, strikeSignals, CONTRACT_BTC,
  type IvRv,
} from '@/lib/overview';
import { fmt, Panel, ProbBar, Row, Tag, useWidth } from './parts';

export type Selected = { cp: 'C' | 'P'; strike: number };
export const findLeg = (legs: readonly Leg[], s: Selected | null) =>
  s ? legs.find((l) => l.cp === s.cp && l.strike === s.strike) ?? null : null;

// -------------------------------------------------------------- option chain

type ChainFilter = 'near' | 'all' | 'walls' | 'recommended';
type ChainCols = 'quotes' | 'greeks' | 'odds';

export function ChainPanel({ data, selected, onSelect, rows = 7, pair = null }: {
  data: ChainResponse; selected: Selected | null; onSelect: (s: Selected) => void; rows?: number;
  /** The CE and the PE chosen, one a side, both lit. */
  pair?: { C: number | null; P: number | null } | null;
}) {
  const { snapshot: snap, legs, structure } = data;
  const [filter, setFilter] = usePersisted<ChainFilter>('live:chain:filter', 'all');
  const [cols, setCols] = usePersisted<ChainCols>('live:chain:cols', 'quotes');
  const ceWall = (structure.ceOiWallNear ?? structure.ceOiWall)?.strike ?? null;
  const peWall = (structure.peOiWallNear ?? structure.peOiWall)?.strike ?? null;
  const maxPain = structure.maxPain?.strike ?? null;
  // The board scrolls inside a fixed height, and opens with the money in the middle: every strike is a wheel away, the ATM never off screen.
  const box = useRef<HTMLDivElement>(null);
  const atmRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const b = box.current, r = atmRow.current;
    if (!b || !r) return;
    b.scrollTop = Math.max(0, r.offsetTop - b.clientHeight / 2 + r.offsetHeight / 2);
    // Wider than its box, the strike column sits in the middle: calls to the left, puts to the right, both a small scroll away.
    b.scrollLeft = Math.max(0, (b.scrollWidth - b.clientWidth) / 2);
  }, [snap.expiry, filter, snap.atm, cols]);
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
  // Contracts in thousands past ten thousand, signed where a change: the board must fit its column.
  const k = (v: number | null | undefined, signed = false) => (v === null || v === undefined ? '—' : Math.abs(v) >= 10_000 ? `${signed && v > 0 ? '+' : ''}${(v / 1000).toFixed(1)}K` : signed ? fmt.signed(v) : fmt.n(v));
  const px = (v: number | null | undefined) => (v === null || v === undefined ? '—' : fmt.n(v, v < 10 ? 1 : 0));
  const cells = (l: Leg | undefined): string[] => {
    if (!l) return cols === 'quotes' ? ['—', '—', '—', '—', '—', '—', '—'] : cols === 'greeks' ? ['—', '—', '—', '—'] : ['—', '—', '—', '—', '—'];
    if (cols === 'odds') { const o = odds(l); return [px(l.bid), fmt.pct(o.pOtm), fmt.pct(o.pTouch), l.emDistance === null ? '—' : `${l.emDistance.toFixed(1)}×`, l.score === null ? '—' : (l.score * 10).toFixed(1)]; }
    return cols === 'quotes'
      ? [k(l.oi), l.oiChange ? k(l.oiChange.change, true) : '—', px(l.bid), px(l.ask), px(l.mark), iv(l.iv), k(l.volume)]
      : [l.delta === null ? '—' : l.delta.toFixed(2), l.gamma === null ? '—' : l.gamma.toPrecision(2), l.theta === null ? '—' : l.theta.toFixed(1), l.vega === null ? '—' : l.vega.toFixed(1)];
  };
  const head = cols === 'quotes' ? ['OI', 'ΔOI', 'Bid', 'Ask', 'Mark', 'IV', 'Vol'] : cols === 'greeks' ? ['Δ', 'Γ', 'Θ', 'V'] : ['Bid', 'P(OTM)', 'Touch', 'EM×', 'Score'];
  const mark = (k: number) => [
    k === snap.atm ? 'ATM' : null, k === ceWall ? 'CE wall' : null, k === peWall ? 'PE wall' : null, k === maxPain ? 'Max pain' : null,
  ].filter(Boolean).join(' · ');
  return (
    <Panel title="Option chain"
      right={
        <span className="ov-chain-head">
          <span className="ov-muted">{istLabel(snap.expiryTs)}</span>
          <select aria-label="Strikes shown" className="ov-select" value={filter} onChange={(e) => setFilter(e.target.value as ChainFilter)}>
            <option value="near">Near ATM (±{rows})</option>
            <option value="all">All strikes</option>
            <option value="walls">OI walls</option>
            <option value="recommended">Recommended</option>
          </select>
          <select aria-label="Columns" className="ov-select" value={cols} onChange={(e) => setCols(e.target.value as ChainCols)}>
            <option value="quotes">Quotes</option>
            <option value="greeks">Greeks</option>
            <option value="odds">Seller's odds</option>
          </select>
          <Tag tone="warn">ATM: {fmt.n(snap.atm)}</Tag>
          <Tag tone={snap.live ? 'accent' : 'muted'}>{snap.live ? 'Latest' : 'Past'}</Tag>
        </span>
      }>
      <div className="ov-chain-wrap ov-chain-scroll" ref={box}>
        <table className="ov-chain">
          <thead>
            <tr><th colSpan={head.length} className="ov-calls">Calls (CE)</th><th /><th colSpan={head.length} className="ov-puts">Puts (PE)</th></tr>
            <tr>{head.map((h) => <th key={`c${h}`}>{h}</th>)}<th>Strike</th>{[...head].reverse().map((h) => <th key={`p${h}`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {strikes.map((k) => {
              const c = byKey.get(`C${k}`);
              const p = byKey.get(`P${k}`);
              const selC = (selected?.cp === 'C' && selected.strike === k) || pair?.C === k;
              const selP = (selected?.cp === 'P' && selected.strike === k) || pair?.P === k;
              const tag = mark(k);
              const cls = [k === snap.atm ? 'ov-atm' : '', k === ceWall ? 'ov-wall-ce' : '', k === peWall ? 'ov-wall-pe' : '', k === maxPain ? 'ov-maxpain' : ''].filter(Boolean).join(' ');
              return (
                <tr key={k} className={cls || undefined} ref={k === snap.atm ? atmRow : undefined}>
                  <ChainSide leg={c} selected={selC} onClick={() => c && onSelect({ cp: 'C', strike: k })} cells={cells(c)} itm={c?.moneyness === 'ITM'} />
                  <td className="ov-strike" title={tag || undefined}>{fmt.n(k)}{tag && <small className="ov-strike-tag">{tag}</small>}</td>
                  <ChainSide leg={p} selected={selP} onClick={() => p && onSelect({ cp: 'P', strike: k })} cells={cells(p).reverse()} itm={p?.moneyness === 'ITM'} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ov-foot">Click the call half to choose the CE, the put half to choose the PE; both stay lit, the last click is inspected below. Shaded = in the money · ATM, the OI walls and max pain are marked. {snap.hoursToExpiry.toFixed(1)}h to settlement. Every column of every strike is on the Option Chain tab.</p>
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

type Tab = 'metrics' | 'probability' | 'payoff';

export function SelectedStrikePanel({ data, leg, contracts, changed = null, iv = null, options, onChoose }: {
  data: ChainResponse; leg: Leg | null; contracts: number;
  /** The strikes the panels below can be pointed at (the desk's picks, the finder's top, the board's click), and the choice. */
  options?: { key: string; cp: 'C' | 'P'; strike: number; label: string }[]; onChoose?: (cp: 'C' | 'P', strike: number) => void;
  /** The strike's hour: OI then and its change, IV change, for the signal tags. */
  changed?: { oiChange: number | null; oiThen: number | null; ivChangePts: number | null } | null; iv?: IvRv | null;
}) {
  const [tab, setTab] = usePersisted<Tab>('live:strike:tab', 'metrics');
  const chooser = options && onChoose && options.length > 0 ? (
    <select className="ov-select" aria-label="Strike to inspect" value={leg ? `${leg.cp}${leg.strike}` : ''} onChange={(e) => { const o = options.find((x) => `${x.cp}${x.strike}` === e.target.value); if (o) onChoose(o.cp, o.strike); }}
      title="Which strike the panels below are about: the desk's picks, the finder's top strikes, or the one clicked on the board">
      {leg && !options.some((x) => x.cp === leg.cp && x.strike === leg.strike) && <option value={`${leg.cp}${leg.strike}`}>Board · {fmt.n(leg.strike)} {leg.cp === 'C' ? 'CE' : 'PE'}</option>}
      {options.map((o) => <option key={o.key} value={`${o.cp}${o.strike}`}>{o.label}</option>)}
    </select>
  ) : null;
  if (!leg) return <Panel title="Selected strike" right={chooser}><p className="ov-empty">Click a strike on the chain.</p></Panel>;
  const side = leg.cp === 'C' ? 'CE' : 'PE';
  const g = (v: number | null | undefined, p: number) => (v === null || v === undefined ? '—' : v.toFixed(p));
  // What each greek means for `contracts` short, in dollars: the sensitivity the seller actually carries, on hover.
  const size = contracts * CONTRACT_BTC;
  const usd = (v: number | null, k = 1) => (v === null ? '—' : fmt.signed(-v * size * k, 2));
  return (
    <Panel title={`Selected strike: ${fmt.n(leg.strike)} ${side}`} right={<span className="ov-signals">{chooser}{strikeSignals(leg, changed, iv).map((x) => <Tag key={x} tone={/SAFE|RICH|FAVORABLE|UNWIND|CRUSH/.test(x) ? 'up' : /RISK|NO TRADE|WEAK|BUILDUP|EXPANSION/.test(x) ? 'down' : 'warn'}>{x}</Tag>)}</span>}>
      <div className="ov-greeks">
        <Greek label="Delta" value={g(leg.delta, 2)} hint={`Short ${contracts} ct: ${usd(leg.delta)} per $1 move in BTC`} />
        <Greek label="Gamma" value={leg.gamma === null ? '—' : leg.gamma.toPrecision(2)} hint={`Delta changes ${leg.gamma === null ? '—' : (leg.gamma * 100).toFixed(3)} per $100 of BTC; the seller's enemy near the strike`} />
        <Greek label="Theta" value={g(leg.theta, 1)} hint={`Per day per BTC; ${usd(leg.theta, -1)} a day for ${contracts} ct — the seller's income`} />
        <Greek label="Vega" value={g(leg.vega, 1)} hint={`Short ${contracts} ct: ${usd(leg.vega)} per one-point rise in IV`} />
        <Greek label="Rho" value={g(leg.rho, 2)} hint="Per one-point rise in the rate; negligible on a one-day contract" />
        <Greek label="IV" value={leg.iv === null ? '—' : `${(leg.iv * 100).toFixed(1)}%`} hint="This strike's mark implied volatility" />
      </div>
      <div className="ov-tabs" role="tablist">
        {(['metrics', 'probability', 'payoff'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'metrics' && <MetricsTab leg={leg} spot={data.snapshot.spot} contracts={contracts} changed={changed} />}
      {tab === 'probability' && <ProbabilityTab leg={leg} />}
      {tab === 'payoff' && <PayoffTab leg={leg} spot={data.snapshot.spot} step={data.snapshot.step} contracts={contracts} />}
    </Panel>
  );
}

function Greek({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="ov-greek" title={hint}><span>{label}</span><b>{value}</b></div>;
}

function MetricsTab({ leg, spot, contracts, changed }: { leg: Leg; spot: number; contracts: number; changed: { oiChange: number | null; oiThen: number | null; ivChangePts: number | null } | null }) {
  const p = premiumAnalysis(leg, null);
  if (!p) return <p className="ov-empty">No price on this strike.</p>;
  const x = executionRead(leg, spot, contracts);
  const dOi = changed?.oiChange ?? (leg.oiChange?.change ?? null);
  return (
    <div className="ov-two">
      <div>
        <Row label="Premium (mark)" value={`${fmt.n(p.premium, 1)}${leg.theoretical != null ? ` · BS ${fmt.n(leg.theoretical, 1)}` : ''}`} hint="Mark, and Black–Scholes at the mark IV" />
        <Row label="Intrinsic" value={fmt.n(p.intrinsic, 1)} />
        <Row label="Extrinsic" value={`${fmt.n(p.extrinsic, 1)} (${fmt.pct(p.extrinsicShare)})`} />
        <Row label="IV" value={leg.iv === null ? '—' : `${(leg.iv * 100).toFixed(1)}%`} />
        <Row label="OI" value={fmt.n(leg.oi)} />
        <Row label="ΔOI (1h)" value={dOi === null ? '—' : fmt.signed(dOi)} tone={dOi === null ? undefined : dOi > 0 ? 'up' : dOi < 0 ? 'down' : undefined} />
        <Row label="Volume (today)" value={leg.volume === null ? '—' : `${fmt.n(leg.volume)} ct`} />
      </div>
      <div>
        <Row label="Bid / mid / ask" value={`${fmt.n(leg.bid, 1)} / ${fmt.n(x.mid, 1)} / ${fmt.n(leg.ask, 1)}`} />
        <Row label="Spread" value={x.spread === null ? '—' : `${fmt.n(x.spread, 1)} (${x.spreadPct!.toFixed(1)}%)`} tone={x.spreadPct !== null && x.spreadPct > 10 ? 'warn' : undefined} />
        <Row label="Mark / bid" value={x.markToBid === null ? '—' : `${x.markToBid.toFixed(2)}×`} hint="Mark against what a seller is actually bid; far above 1, the mark flatters" />
        <Row label={`Est. fill (${contracts} ct)`} value={fmt.n(x.expectedFill, 1)} hint="The bid, or a tick under it when the bid is thinner than the size" />
        <Row label="Bid size / ask size" value={`${fmt.n(leg.bidSize ?? null)} / ${fmt.n(leg.askSize ?? null)}`} hint="Contracts resting at the best bid and ask" />
      </div>
    </div>
  );
}

function ProbabilityTab({ leg }: { leg: Leg }) {
  const o = odds(leg);
  const name = o.source === 'measured' ? 'Measured' : 'Model';
  return (
    <div>
      <ProbBar label={`${name} P(expire OTM)`} value={o.pOtm} tone="up" />
      <ProbBar label="P(touch strike before expiry)" value={o.pTouch} tone="muted" />
      <ProbBar label={`${name} P(breach) = expire beyond the strike`} value={o.pItm} tone="down" />
      <Row label="P(premium < 10% at expiry)" value={o.pOtm === null ? '—' : `≈ ${fmt.pct(o.pOtm)}`} hint="At settlement the premium is its intrinsic value alone, so under a tenth of today's premium means settling within a few dollars of the strike or beyond it on the safe side — the same event as expiring OTM, to the nearest percent" />
      <Row label="P(premium < 5% before expiry)" value="not measured yet" tone="muted" hint="The path the premium takes before settlement is being recorded (every strike, every five minutes, since 19 Sep 2026); a measured figure needs weeks of that record" />
      <Row label="Delta baseline P(OTM) / P(ITM)" value={o.deltaApprox === null ? '—' : `${fmt.pct(1 - o.deltaApprox)} / ${fmt.pct(o.deltaApprox)}`} hint="1 − |delta| is the option model's own rough P(OTM); where it and the row above disagree, the measured record is the one the desk trusts" />
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
  const [box, W] = useWidth<HTMLDivElement>(220);
  const H = 120, P = 14;
  if (rows.length < 2) return null;
  const xs = rows.map((r) => r.price), ys = rows.map((r) => r.pnlUsd);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  const px = (x: number) => P + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * P);
  const py = (y: number) => H - P - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * P);
  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${px(r.price).toFixed(1)},${py(r.pnlUsd).toFixed(1)}`).join(' ');
  return (
    <div ref={box} className="ov-chart-box">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="ov-svg" role="img" aria-label="Payoff at expiry">
        <line x1={P} x2={W - P} y1={py(0)} y2={py(0)} className="ov-axis" strokeDasharray="3 3" />
        <line x1={px(strike)} x2={px(strike)} y1={P} y2={H - P} className="ov-axis" />
        <path d={d} fill="none" className="ov-line-payoff" />
      </svg>
    </div>
  );
}

// ------------------------------------------------------------ the decision

