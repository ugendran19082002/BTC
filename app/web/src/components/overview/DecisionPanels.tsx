import { useEffect, useMemo, useState } from 'react';
import type { ChainResponse, ExpiryOption, Leg } from '@/types/desk';
import { istLabel } from '@/lib/format';
import type { PremiumMomentum } from '@/api/desk';
import {
  breakeven, candidates, consensus, executionEstimate, expectedMove, ivRv, modelView, odds,
  orderEstimate, payoffPrices, premiumAnalysis, premiumMomentum, shortLossAt, shortPayoff, CONTRACT_BTC,
  type BothAssessment, type ExpectedMove, type IvRv, type Readiness, type SideAssessment, type SideChoice,
} from '@/lib/overview';
import { SideCardsRow } from './RiskPanels';
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

type Tab = 'metrics' | 'probability' | 'payoff';

export function SelectedStrikePanel({ data, leg, em, contracts, ivRank, momentum }: {
  data: ChainResponse; leg: Leg | null; em: ExpectedMove; contracts: number;
  ivRank?: { percentile: number; days: number } | null; momentum?: PremiumMomentum | null;
}) {
  const [tab, setTab] = useState<Tab>('metrics');
  if (!leg) return <Panel title="Selected strike"><p className="ov-empty">Click a strike on the chain.</p></Panel>;
  const side = leg.cp === 'C' ? 'CE' : 'PE';
  const g = (v: number | null | undefined, p: number) => (v === null || v === undefined ? '—' : v.toFixed(p));
  // What each greek means for `contracts` short, in dollars: the sensitivity the seller actually carries, on hover.
  const size = contracts * CONTRACT_BTC;
  const usd = (v: number | null, k = 1) => (v === null ? '—' : fmt.signed(-v * size * k, 2));
  return (
    <Panel title={`Selected strike: ${fmt.n(leg.strike)} ${side}`} right={leg.ev?.signal ? <Tag tone={leg.ev.signal === 'sell' ? 'up' : leg.ev.signal === 'avoid' ? 'down' : 'muted'}>{leg.ev.signal}</Tag> : undefined}>
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
      {tab === 'metrics' && <MetricsTab leg={leg} em={em} ivRank={ivRank ?? null} momentum={momentum ?? null} />}
      {tab === 'probability' && <ProbabilityTab leg={leg} />}
      {tab === 'payoff' && <PayoffTab leg={leg} spot={data.snapshot.spot} step={data.snapshot.step} contracts={contracts} />}
    </Panel>
  );
}

function Greek({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="ov-greek" title={hint}><span>{label}</span><b>{value}</b></div>;
}

function MetricsTab({ leg, em, ivRank, momentum }: {
  leg: Leg; em: ExpectedMove; ivRank: { percentile: number; days: number } | null; momentum: PremiumMomentum | null;
}) {
  const p = premiumAnalysis(leg, em);
  if (!p) return <p className="ov-empty">No price on this strike.</p>;
  const mom = momentum ?? { velocity: null, acceleration: null };
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
        <Row label="IV percentile" value={ivRank ? `${fmt.pct(ivRank.percentile)} (${ivRank.days < 1 ? 'today' : `${Math.round(ivRank.days)}d`})` : '—'} hint="ATM IV among every recorded reading since 17 Sep 2026" />
        <Row label="Premium velocity" value={mom.velocity === null ? '—' : `${fmt.signed(mom.velocity, 1)} / 5m`} tone={mom.velocity === null ? undefined : mom.velocity > 0 ? 'down' : 'up'} hint="Mark change over the last recorded five minutes; rising premium is against a short" />
        <Row label="Premium acceleration" value={mom.acceleration === null ? '—' : fmt.signed(mom.acceleration, 1)} hint="The change of the velocity" />
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
      <ProbBar label={`${name} P(expire beyond strike) = P(ITM)`} value={o.pItm} tone="down" />
      <ProbBar label="P(touch strike before expiry)" value={o.pTouch} tone="muted" />
      <Row label="Delta baseline P(OTM) / P(ITM)" value={o.deltaApprox === null ? '—' : `${fmt.pct(1 - o.deltaApprox)} / ${fmt.pct(o.deltaApprox)}`} hint="1 − |delta| is the option model's own rough P(OTM); where it and the row above disagree, the measured record is the one the desk trusts" />
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

// ------------------------------------------------------------ the decision

export function StrategyDecisionPanel({ data, sides, both, choice, onSelect }: {
  data: ChainResponse; sides: SideAssessment[]; both: BothAssessment; choice: SideChoice; onSelect: (s: Selected) => void;
}) {
  const tone = choice.side === 'NO_TRADE' ? 'down' : choice.side === 'BOTH' ? 'up' : 'accent';
  // What is in the way, in plain words: the failing gates of the side the desk would take, or of the better side.
  const focus = sides.find((s) => s.side === (choice.side === 'CE' ? 'CE' : choice.side === 'PE' ? 'PE' : null)) ?? [...sides].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0]!;
  const blockers = (focus.gates ?? []).filter((g) => g.ok === false).map((g) => `${g.name} (${g.text})`);
  return (
    <Panel title="Strategy decision" right={<Tag tone={tone}>Desk side: {choice.side.replace('_', ' ')}</Tag>}>
      <p className="ov-summary">
        <b>{choice.side === 'NO_TRADE' ? 'No trade' : choice.side === 'BOTH' ? 'Sell both sides' : `Sell ${choice.side}`}</b> — {choice.why}.
        {blockers.length > 0 && <> In the way on {focus.side}: {blockers.slice(0, 3).join(' · ')}{blockers.length > 3 ? ` · +${blockers.length - 3} more` : ''}.</>}
        {focus.disabledBy && <> {focus.disabledBy}.</>}
      </p>
      <SideCardsRow sides={sides} both={both} onSelect={(cp, strike) => onSelect({ cp, strike })} />
      <p className="ov-foot">{data.best.why ?? ''} Side from the regime, the horizon consensus and each side's gates — never the score alone.</p>
    </Panel>
  );
}

// ------------------------------------------------------- checklist and order

export function ChecklistPanel({ leg, ready, onSell }: { leg: Leg | null; ready: Readiness; onSell?: (l: Leg) => void }) {
  // Failing first, then what could not be read, then what passed: the eye goes to what needs attention.
  const rank = (ok: boolean | null) => (ok === false ? 0 : ok === null ? 1 : 2);
  const gates = [...ready.gates].sort((x, y) => rank(x.ok) - rank(y.ok));
  const side = leg ? (leg.cp === 'C' ? 'CE' : 'PE') : null;
  return (
    <Panel title={`Entry checklist · ${ready.gates.length} gates`}
      right={
        <span className="ov-chain-head">
          <Tag tone={ready.ready ? 'up' : 'down'}>{ready.verdict}{ready.ready ? '' : ` · ${ready.failing} failing${ready.unknown ? `, ${ready.unknown} unreadable` : ''}`}</Tag>
          {leg && onSell && (
            <button className="ov-sell" onClick={() => onSell(leg)} title="Opens the order ticket for this strike — every gate runs again on the server">
              Sell {fmt.n(leg.strike)} {side} via ticket
            </button>
          )}
        </span>
      }>
      <ul className="ov-checks ov-checks-dense">
        {gates.map((g) => (
          <li key={g.key} className={g.ok === true ? 'ok' : g.ok === false ? 'bad' : 'unknown'}>
            <span aria-hidden>{g.ok === true ? '✓' : g.ok === false ? '✕' : '?'}</span>{g.text}
          </li>
        ))}
      </ul>
      <p className="ov-foot">Failing first, then unreadable, then passing. Orders and positions have their own tabs; this screen decides, the ticket places.</p>
    </Panel>
  );
}
