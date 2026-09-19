import { useEffect, useMemo, useState } from 'react';
import type { ChainResponse, Leg } from '@/types/desk';
import type { TradeStatus } from '@/types/trade';
import { getOptionHistory, type OptionHistoryPoint } from '@/api/desk';
import {
  allClear, bothSides, breakeven, candidates, consensus, entryGates, expectedMove, marginPerContract, modelView, odds,
  orderEstimate, payoffPrices, premiumAnalysis, shortPayoff, sideCards, CONTRACT_BTC, type ExpectedMove, type IvRv,
} from '@/lib/overview';
import { fmt, Panel, ProbBar, Row, Tag } from './parts';

export type Selected = { cp: 'C' | 'P'; strike: number };
export const findLeg = (legs: readonly Leg[], s: Selected | null) =>
  s ? legs.find((l) => l.cp === s.cp && l.strike === s.strike) ?? null : null;

// -------------------------------------------------------------- option chain

export function ChainPanel({ data, selected, onSelect, rows = 7, expiries, onExpiry }: {
  data: ChainResponse; selected: Selected | null; onSelect: (s: Selected) => void; rows?: number;
  expiries?: readonly { expiry: string; hoursAway: number }[]; onExpiry?: (expiry: string) => void;
}) {
  const { snapshot: snap, legs } = data;
  const strikes = useMemo(() => {
    const all = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
    const i = all.reduce((best, k, idx) => (Math.abs(k - snap.spot) < Math.abs(all[best]! - snap.spot) ? idx : best), 0);
    return all.slice(Math.max(0, i - rows), i + rows + 1);
  }, [legs, snap.spot, rows]);
  const byKey = useMemo(() => new Map(legs.map((l) => [`${l.cp}${l.strike}`, l])), [legs]);
  const iv = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const cell = (l: Leg | undefined, k: 'oi' | 'bid' | 'ask' | 'mark') =>
    !l ? '—' : k === 'oi' ? fmt.n(l.oi) : fmt.n(l[k], l[k] !== null && l[k]! < 10 ? 1 : 0);
  return (
    <Panel title={`Option chain${snap.live ? '' : ' (past)'}`}
      right={
        <span className="ov-chain-head">
          {expiries && onExpiry && expiries.length > 0 ? (
            <select aria-label="Expiry" className="ov-select" value={snap.expiry} onChange={(e) => onExpiry(e.target.value)}>
              {!expiries.some((e) => e.expiry === snap.expiry) && <option value={snap.expiry}>{snap.expiry}</option>}
              {expiries.map((e) => (
                <option key={e.expiry} value={e.expiry}>{e.expiry} · {e.hoursAway < 48 ? `${Math.round(e.hoursAway)}h` : `${Math.round(e.hoursAway / 24)}d`}</option>
              ))}
            </select>
          ) : <span>{snap.expiry}</span>}
          <span className="ov-muted">ATM {fmt.n(snap.atm)} · {snap.hoursToExpiry.toFixed(1)}h left</span>
        </span>
      }>
      <div className="ov-chain-wrap">
        <table className="ov-chain">
          <thead>
            <tr><th colSpan={5} className="ov-calls">Calls (CE)</th><th /><th colSpan={5} className="ov-puts">Puts (PE)</th></tr>
            <tr><th>OI</th><th>Bid</th><th>Ask</th><th>Mark</th><th>IV</th><th>Strike</th><th>Mark</th><th>Bid</th><th>Ask</th><th>OI</th><th>IV</th></tr>
          </thead>
          <tbody>
            {strikes.map((k) => {
              const c = byKey.get(`C${k}`);
              const p = byKey.get(`P${k}`);
              const atm = k === snap.atm;
              const selC = selected?.cp === 'C' && selected.strike === k;
              const selP = selected?.cp === 'P' && selected.strike === k;
              return (
                <tr key={k} className={atm ? 'ov-atm' : undefined}>
                  <ChainSide leg={c} selected={selC} onClick={() => c && onSelect({ cp: 'C', strike: k })}
                    cells={[cell(c, 'oi'), cell(c, 'bid'), cell(c, 'ask'), cell(c, 'mark'), iv(c?.iv ?? null)]} itm={c?.moneyness === 'ITM'} />
                  <td className="ov-strike">{fmt.n(k)}</td>
                  <ChainSide leg={p} selected={selP} onClick={() => p && onSelect({ cp: 'P', strike: k })}
                    cells={[cell(p, 'mark'), cell(p, 'bid'), cell(p, 'ask'), cell(p, 'oi'), iv(p?.iv ?? null)]} itm={p?.moneyness === 'ITM'} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ov-foot">Click a side to inspect it. Shaded = in the money.</p>
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

type Tab = 'metrics' | 'probability' | 'payoff' | 'momentum';

export function SelectedStrikePanel({ data, leg, em, iv, contracts }: {
  data: ChainResponse; leg: Leg | null; em: ExpectedMove; iv: IvRv | null; contracts: number;
}) {
  const [tab, setTab] = useState<Tab>('metrics');
  if (!leg) return <Panel title="Selected strike"><p className="ov-empty">Click a strike on the chain.</p></Panel>;
  const side = leg.cp === 'C' ? 'CE' : 'PE';
  const g = (v: number | null, p: number) => (v === null ? '—' : v.toFixed(p));
  return (
    <Panel title={`Selected strike: ${fmt.n(leg.strike)} ${side}`} right={leg.ev?.signal ? <Tag tone={leg.ev.signal === 'sell' ? 'up' : leg.ev.signal === 'avoid' ? 'down' : 'muted'}>{leg.ev.signal}</Tag> : undefined}>
      <div className="ov-greeks">
        <Greek label="Delta" value={g(leg.delta, 2)} />
        <Greek label="Gamma" value={leg.gamma === null ? '—' : leg.gamma.toPrecision(2)} />
        <Greek label="Theta" value={g(leg.theta, 1)} />
        <Greek label="Vega" value={g(leg.vega, 1)} />
        <Greek label="IV" value={leg.iv === null ? '—' : `${(leg.iv * 100).toFixed(1)}%`} />
      </div>
      <div className="ov-tabs" role="tablist">
        {(['metrics', 'probability', 'payoff', 'momentum'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'metrics' && <MetricsTab leg={leg} em={em} iv={iv} />}
      {tab === 'probability' && <ProbabilityTab leg={leg} />}
      {tab === 'payoff' && <PayoffTab leg={leg} spot={data.snapshot.spot} step={data.snapshot.step} contracts={contracts} />}
      {tab === 'momentum' && <MomentumTab symbol={`${leg.cp}-BTC-${leg.strike}-${data.snapshot.expiry}`} />}
    </Panel>
  );
}

function Greek({ label, value }: { label: string; value: string }) {
  return <div className="ov-greek"><span>{label}</span><b>{value}</b></div>;
}

function MetricsTab({ leg, em, iv }: { leg: Leg; em: ExpectedMove; iv: IvRv | null }) {
  const p = premiumAnalysis(leg, em);
  if (!p) return <p className="ov-empty">No price on this strike.</p>;
  return (
    <div className="ov-two">
      <div>
        <Row label="Premium (mark)" value={fmt.n(p.premium, 1)} />
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
        <Row label="OI change" value={leg.oiChange ? `${fmt.signed(leg.oiChange.change)} (${leg.oiChange.overMinutes}m)` : '—'} />
        <Row label="Breakeven" value={fmt.n(breakeven(leg.cp, leg.strike, p.premium))} />
      </div>
    </div>
  );
}

function ProbabilityTab({ leg }: { leg: Leg }) {
  const o = odds(leg);
  return (
    <div>
      <ProbBar label="P(OTM at expiry)" value={o.pOtm} tone="up" />
      <ProbBar label="P(ITM at expiry)" value={o.pItm} tone="down" />
      <ProbBar label="P(touch before expiry)" value={o.pTouch} tone="muted" />
      <Row label="|Delta| (rough P(ITM))" value={o.deltaApprox === null ? '—' : o.deltaApprox.toFixed(2)} />
      <Row label="Model P(OTM)" value={fmt.pct(o.modelOtm)} />
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
function MomentumTab({ symbol }: { symbol: string }) {
  const [pts, setPts] = useState<OptionHistoryPoint[] | null>(null);
  useEffect(() => {
    let live = true;
    getOptionHistory(symbol, 2).then((r) => { if (live) setPts(r.points); }).catch(() => { if (live) setPts([]); });
    return () => { live = false; };
  }, [symbol]);
  if (!pts) return <p className="ov-empty">Loading…</p>;
  const last = pts.at(-1);
  if (!last) return <p className="ov-empty">No recorded snapshots for this strike yet — the recorder writes every 5 minutes.</p>;
  const back = (min: number) => pts.filter((p) => p.at <= last.at - min * 60_000).at(-1) ?? null;
  const change = (a: number | null | undefined, b: number | null | undefined, pct = true) =>
    a == null || b == null ? null : pct ? (b === 0 ? null : a / b - 1) : a - b;
  return (
    <table className="ov-mini">
      <thead><tr><th /><th>5m</th><th>15m</th><th>1h</th></tr></thead>
      <tbody>
        {([
          ['Premium', (p: OptionHistoryPoint | null) => fmt.pct(change(last.mark, p?.mark), 1)],
          ['Open interest', (p: OptionHistoryPoint | null) => fmt.pct(change(last.oi, p?.oi), 1)],
          ['IV (pts)', (p: OptionHistoryPoint | null) => { const d = change(last.markIv, p?.markIv, false); return d === null ? '—' : fmt.signed(d * 100, 1); }],
          ['BTC', (p: OptionHistoryPoint | null) => fmt.pct(change(last.spot, p?.spot), 2)],
        ] as const).map(([label, f]) => (
          <tr key={label}><td>{label}</td><td>{f(back(5))}</td><td>{f(back(15))}</td><td>{f(back(60))}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------ model and EM

export function ModelViewPanel({ data, iv }: { data: ChainResponse; iv: IvRv | null }) {
  const v = modelView(data.outlook, 720);
  const c = consensus(data.outlook);
  const em = expectedMove(data.snapshot);
  return (
    <Panel title={`Model view (${v?.label ?? '12h'})`} right={v ? <Tag tone="muted">{v.source === 'measured' ? 'measured' : 'history only'}</Tag> : undefined}>
      <div className="ov-two">
        <div>
          <ProbBar label="Up" value={v?.pUp ?? null} tone="up" />
          <ProbBar label="Down" value={v?.pDown ?? null} tone="down" />
          <ProbBar label="Range" value={v && v.source === 'measured' ? v.pSide : null} tone="muted" />
          <p className="ov-foot">{c.scored ? `Horizons: ${c.up} up · ${c.down} down · ${c.flat} flat${c.agree ? '' : ' — no consensus'}` : 'No horizon readable.'}</p>
        </div>
        <div>
          <Row label="Expected move" value={em ? `±${fmt.n(em.move)}` : '—'} />
          <Row label="Upper / lower" value={em ? `${fmt.n(em.upper)} / ${fmt.n(em.lower)}` : '—'} />
          <Row label="To settlement" value={em ? `${em.hours.toFixed(1)}h` : '—'} />
          <Row label="IV / realised" value={iv ? `${iv.ivPct.toFixed(1)}% / ${iv.rvPct.toFixed(1)}%` : '—'} />
          <Row label="IV − RV" value={iv ? <Tag tone={iv.label === 'rich' ? 'up' : iv.label === 'cheap' ? 'down' : 'muted'}>{iv.label}</Tag> : '—'} />
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------ the decision

export function StrategyDecisionPanel({ data, iv, onSelect }: { data: ChainResponse; iv: IvRv | null; onSelect: (s: Selected) => void }) {
  const cards = sideCards(data, iv);
  const both = data.containment;
  const pair = bothSides(data.legs);
  return (
    <Panel title="Strategy decision">
      <div className="ov-decide">
        {cards.map((c) => (
          <button key={c.side} className={`ov-decide-card ${c.preferred ? 'ov-preferred' : ''}`} disabled={!c.leg}
            onClick={() => c.leg && onSelect({ cp: c.leg.cp, strike: c.leg.strike })}>
            <header>Short {c.side}{c.leg ? ` · ${fmt.n(c.leg.strike)}` : ''}</header>
            <Row label="Score" value={c.score === null ? '—' : `${c.score.toFixed(1)} / 10`} />
            <Row label="P(OTM)" value={fmt.pct(c.pOtm)} />
            <Row label="P(touch)" value={fmt.pct(c.pTouch)} />
            <Row label="Distance / EM" value={c.emDistance === null ? '—' : `${c.emDistance.toFixed(2)}×`} />
            <Row label="IV richness" value={c.ivRich ?? '—'} />
            <Row label="Gamma risk" value={c.gammaRisk ?? '—'} tone={c.gammaRisk === 'high' ? 'down' : c.gammaRisk === 'low' ? 'up' : undefined} />
            <footer><Tag tone={c.preferred ? 'up' : 'muted'}>{c.preferred ? 'Preferred' : 'Not preferred'}</Tag></footer>
          </button>
        ))}
        <div className="ov-decide-card">
          <header>Both sides</header>
          <Row label="Range" value={both ? `${fmt.n(both.low)} – ${fmt.n(both.high)}` : '—'} />
          <Row label="P(stays inside)" value={fmt.pct(both?.probability ?? null)} />
          <Row label="CE safe" value={<Safe ok={pair.ceSafe} />} hint="The call strike at least one expected move away" />
          <Row label="PE safe" value={<Safe ok={pair.peSafe} />} hint="The put strike at least one expected move away" />
          <Row label="Net delta" value={pair.netDelta === null ? '—' : fmt.signed(pair.netDelta, 2)} hint="Short both legs; near zero is balanced" />
          <Row label="Buffers / EM" value={both?.lowBuffer == null || both.highBuffer == null ? '—' : `${both.lowBuffer.toFixed(2)}× / ${both.highBuffer.toFixed(2)}×`} />
          <footer><Tag tone={data.recommendation.sides.length === 2 ? 'up' : 'muted'}>{data.recommendation.sides.length === 2 ? 'Desk sells both' : 'Not recommended'}</Tag></footer>
        </div>
      </div>
      {data.best.why && <p className="ov-foot">{data.best.why}</p>}
    </Panel>
  );
}

function Safe({ ok }: { ok: boolean | null }) {
  return ok === null ? <span className="ov-muted">—</span> : <span className={ok ? 'ov-up' : 'ov-down'}>{ok ? '✓' : '✕'}</span>;
}

export function SellRecommendationPanel({ data, onSelect, onSell, leverage, contracts }: {
  data: ChainResponse; onSelect: (s: Selected) => void; onSell?: (l: Leg) => void; leverage: number; contracts: number;
}) {
  const spot = data.snapshot.spot;
  return (
    <Panel title="Sell recommendation" right={<small className="ov-muted">{contracts} ct at {leverage}x · margin est.</small>}>
      {(['P', 'C'] as const).map((side) => {
        const rows = candidates(data.legs, side, 3);
        return (
          <div key={side} className="ov-reco-side">
            <h4>{side === 'C' ? 'CE side' : 'PE side'}</h4>
            {rows.length === 0 ? <p className="ov-empty">Nothing on this side clears the desk’s rules.</p> : (
              <table className="ov-mini ov-reco">
                <thead><tr><th>Strike</th><th>Premium</th><th>P(OTM)</th><th>P(touch)</th><th>Dist/EM</th><th>EV $</th><th>Margin $</th><th>Credit/margin</th><th>Score</th><th /></tr></thead>
                <tbody>
                  {rows.map((l) => {
                    const o = odds(l);
                    const px = l.sellPrice ?? l.mark;
                    const est = px === null ? null : orderEstimate(l.cp, l.strike, px, spot, leverage, contracts);
                    return (
                      <tr key={l.strike} className="ov-click" onClick={() => onSelect({ cp: l.cp, strike: l.strike })}>
                        <td>{fmt.n(l.strike)}</td>
                        <td>{fmt.n(px, 1)}</td>
                        <td className="ov-up">{fmt.pct(o.pOtm)}</td>
                        <td>{fmt.pct(o.pTouch)}</td>
                        <td>{l.emDistance === null ? '—' : `${l.emDistance.toFixed(2)}×`}</td>
                        <td className={l.ev?.evUsd == null ? '' : l.ev.evUsd >= 0 ? 'ov-up' : 'ov-down'}>{fmt.signed(l.ev?.evUsd ?? null, 2)}</td>
                        <td>{est ? fmt.n(est.marginUsd, 2) : '—'}</td>
                        <td title="Premium after the opening fee, as a share of the margin it ties up">{est ? fmt.pct(est.returnOnMargin, 1) : '—'}</td>
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

export function EntryPanel({ data, leg, iv, trade, onSell, now, contracts, leverage }: {
  data: ChainResponse; leg: Leg | null; iv: IvRv | null; trade: TradeStatus | null; onSell?: (l: Leg) => void; now: number; contracts: number; leverage: number;
}) {
  const heldShort = trade ? trade.open.reduce((a, t) => a + Math.max(0, -t.position), 0) : 0;
  const gates = entryGates({
    data, leg, iv, nowMs: now, maxSpreadPct: trade?.limits.maxSpreadPct ?? null,
    risk: trade ? { contracts, heldShort, maxShortContracts: trade.limits.maxShortContracts, dayNetUsd: trade.today?.netUsd ?? null, maxDailyLossUsd: trade.limits.maxDailyLossUsd } : null,
  });
  const clear = allClear(gates);
  const premium = leg ? (leg.sellPrice ?? leg.mark) : null;
  const est = leg && premium !== null ? orderEstimate(leg.cp, leg.strike, premium, data.snapshot.spot, leverage, contracts) : null;
  return (
    <div className="ov-entry">
      <Panel title="Entry checklist" className="ov-grow">
        <ul className="ov-checks">
          {gates.map((g) => (
            <li key={g.key} className={g.ok === true ? 'ok' : g.ok === false ? 'bad' : 'unknown'}>
              <span aria-hidden>{g.ok === true ? '✓' : g.ok === false ? '✕' : '?'}</span>{g.text}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Place sell order">
        <button className="ov-place" disabled={!leg || !onSell} onClick={() => leg && onSell?.(leg)}
          title={clear ? 'Opens the order ticket — every gate runs again on the server' : 'Some gates are not green; the ticket still opens, and the server decides'}>
          {leg ? `Sell ${fmt.n(leg.strike)} ${leg.cp === 'C' ? 'CE' : 'PE'}` : 'Select a strike'}
        </button>
        <Row label="Premium (bid)" value={fmt.n(premium, 1)} />
        <Row label="Contracts · leverage" value={`${fmt.n(contracts)} · ${leverage}x`} hint="Your size and the ticket's leverage; both can be changed on the ticket" />
        <Row label="Estimated credit" value={est ? `$${est.creditUsd.toFixed(2)}` : '—'} hint="bid × contracts × 0.001 BTC, before fees" />
        <Row label="Fees to open (est.)" value={est ? `$${est.feesUsd.toFixed(2)}` : '—'} hint="min(0.01% of notional, 3.5% of premium) per contract; GST on top" />
        <Row label="Margin required (est.)" value={est ? `$${est.marginUsd.toFixed(2)}` : '—'} hint="spot × 0.001 ÷ leverage + fee, per contract — the ticket, then Delta, is the authority" />
        <Row label="Breakeven (after fees)" value={est ? fmt.n(est.breakevenAfterFees) : leg && premium !== null ? fmt.n(breakeven(leg.cp, leg.strike, premium)) : '—'} />
        <Row label="Gates" value={<Tag tone={clear ? 'up' : 'warn'}>{clear ? 'all green' : 'not all green'}</Tag>} />
      </Panel>
    </div>
  );
}

// --------------------------------------------------------------- status bar

export function StatusBar({ data, trade, now, leverage }: { data: ChainResponse; trade: TradeStatus | null; now: number; leverage: number }) {
  const age = Math.max(0, Math.round((now - data.snapshot.ts * 1000) / 1000));
  const measured = Boolean(data.outlook.model);
  const net = trade?.today?.netUsd ?? null;
  // Margin behind what is short, at the ticket's leverage, against the balance. An estimate: Delta's figure is on the Positions tab.
  const shortCt = trade ? trade.open.reduce((a, t) => a + Math.max(0, -t.position), 0) : 0;
  const marginUsed = trade?.balanceUsd != null && trade.balanceUsd > 0 && shortCt > 0
    ? (shortCt * marginPerContract(data.snapshot.spot, leverage, 0)) / trade.balanceUsd : trade?.balanceUsd != null ? 0 : null;
  return (
    <footer className="ov-status">
      <Tag tone={trade?.mode === 'live' ? 'down' : 'accent'}>{trade?.mode === 'live' ? 'LIVE' : 'Paper'} · short premium</Tag>
      <Tag tone={data.snapshot.live && age <= 30 ? 'up' : 'warn'}>{data.snapshot.live ? `Data ${age}s old` : 'Past snapshot'}</Tag>
      <Tag tone={measured ? 'up' : 'muted'}>{measured ? `Model: ${data.outlook.model!.name}` : 'Model: desk figures only'}</Tag>
      <span className="ov-grow" />
      <span>Day P&amp;L <b className={net === null ? '' : net >= 0 ? 'ov-up' : 'ov-down'}>{net === null ? '—' : `${net >= 0 ? '+' : '−'}$${Math.abs(net).toFixed(2)}`}</b></span>
      <span>Open positions <b>{trade?.open.length ?? '—'}</b></span>
      <span>Balance <b>{trade?.balanceUsd == null ? '—' : `$${trade.balanceUsd.toFixed(2)}`}</b></span>
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
