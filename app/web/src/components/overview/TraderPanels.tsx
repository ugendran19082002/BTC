import { useEffect, useState } from 'react';
import type { ChainResponse, Leg } from '@/types/desk';
import { getChanges, type ChangeRow, type ModelNow, type MovementRow, type PerpResponse, type PremiumMomentum } from '@/api/desk';
import {
  boardRead, candidates, DESK_FILTER, earlyWarning, executionEstimate, filtersChanged, finderDecision, findStrikes, horizonRows, movementVerdict, odds, orderEstimate, premiumAnalysis, sellerImpact, sellerState,
  type EarlyWarning, type ExpectedMove, type FinderFilter, type Impact,
} from '@/lib/overview';
import type { ScreenConfig } from '@/lib/screen-config';
import { fmt, Panel, Row, Tag } from './parts';

// ---------------------------------------------------------- early warning

export function EarlyWarningPanel({ data, perp, changes }: { data: ChainResponse; perp: PerpResponse | null; changes: ChangeRow[] | null }) {
  const w15 = changes?.find((r) => r.minutes === 15) ?? null;
  const w: EarlyWarning = earlyWarning({
    flow: perp?.flow ?? null, book: perp?.book ?? null, oi: perp?.oi ?? null, funding: perp?.ticker?.fundingRate ?? null,
    market: data.market, outlook: data.outlook, markChange15mPct: w15?.markChangePct ?? null, atmIvChange15mPts: w15?.atmIvChangePts ?? null,
  });
  const shock = data.shocks?.[0] ?? null;
  const tone = w.band === 'sudden' ? 'down' : w.band === 'high' ? 'warn' : w.band === 'watch' ? 'accent' : 'up';
  return (
    <Panel title="Early warning · big move ahead?" right={<Tag tone={tone}>{w.band.toUpperCase()}{w.score === null ? '' : ` · ${(w.score * 100).toFixed(0)}%`}{w.lean ? ` · pressure ${w.lean > 0 ? 'up ↑' : 'down ↓'}` : ''}</Tag>}>
      <p className="ov-summary">{w.action}{shock && shock.score !== null ? ` Desk's measured sudden-move score: ${shock.score.toFixed(0)} (${shock.band})${shock.odds ? ` — BTC has moved more than ${shock.odds.thresholdPct}% in the next ${shock.odds.overMinutes}m ${fmt.pct(shock.odds.either)} of the time from readings like these` : ''}.` : ''}</p>
      <ul className="ov-triggers">
        {w.triggers.map((t) => (
          <li key={t.name} className={t.state === 'TRIGGERED' ? 'ov-fired' : t.state === 'WATCH' ? 'ov-watching' : undefined} title={`${t.formula} · triggers ${t.threshold}`}>
            <span className="ov-trigger-name">{t.name}</span>
            <span className={`ov-trigger-state ov-lamp-${t.state?.toLowerCase() ?? 'none'}`}><i aria-hidden />{t.state ?? 'not read'}</span>
            <span className="ov-trigger-detail"><b>{t.value}</b> <small className="ov-muted">· triggers {t.threshold}</small></span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------ movement to expiry

export function MovementPanel({ data, em, activeMin, mtf }: { data: ChainResponse; em: ExpectedMove; activeMin: number; mtf?: React.ReactNode }) {
  const rows = horizonRows(data.outlook).filter((r) => r.minutes <= Math.max(60, data.snapshot.hoursToExpiry * 60 + 1));
  const board = boardRead(data, em);
  const v = movementVerdict(rows, board, data.market, data.snapshot.hoursToExpiry);
  const says = (s: string) => (s === 'up' ? 'ov-up' : s === 'down' ? 'ov-down' : 'ov-muted');
  return (
    <Panel title="Horizon / MTF · movement to expiry" right={<Tag tone={v.way === 'up' ? 'up' : v.way === 'down' ? 'down' : 'accent'}>{v.way.toUpperCase()} · {v.confidence} confidence</Tag>}>
      <p className="ov-summary">{v.text}.</p>
      {mtf}
      <table className="ov-mini ov-horizons">
        <thead><tr><th>Next</th><th title="Measured share of windows that closed above the band">Above</th><th title="Measured share that closed inside the band">Inside</th><th title="Measured share that closed below the band">Below</th><th title="Spot ± the expected move for the horizon: the band">Band (spot ± EM)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.minutes === activeMin ? 'ov-atm' : undefined}>
              <td>{r.label}{r.minutes === activeMin ? ' ◆' : ''}</td>
              <td className="ov-up">{fmt.pct(r.pUp)}</td><td className="ov-muted">{fmt.pct(r.pRange)}</td><td className="ov-down">{fmt.pct(r.pDown)}</td>
              <td className="ov-muted" title={r.em === null ? undefined : `±${fmt.n(r.em)}`}>{r.low === null || r.high === null ? '—' : `${fmt.n(r.low)} – ${fmt.n(r.high)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ov-board-read">
        {board.map((b) => (
          <Row key={b.name} mark="arrow" tone={b.says === 'up' ? 'up' : b.says === 'down' ? 'down' : 'muted'} label={b.name} value={<span className={says(b.says)}>{b.text}</span>} hint={b.formula} />
        ))}
      </div>
    </Panel>
  );
}

// -------------------------------------------------------------- what changed

export type Changes = { rows: ChangeRow[]; momentum: PremiumMomentum; model: ModelNow };

/** One request per strike, every 30 s: what changed by window (and since entry), the model's odds then and now, and the premium's momentum. */
export function useChanges(data: ChainResponse, leg: Leg | null, spot: number, entryMs: number | null = null): Changes | null {
  const [rows, setRows] = useState<Changes | null>(null);
  const symbol = leg ? `${leg.cp}-BTC-${leg.strike}-${data.snapshot.expiry}` : null;
  const s = data.structure;
  useEffect(() => {
    if (!symbol || !leg) { setRows(null); return; }
    let live = true;
    const load = () => getChanges(symbol, {
      spot, mark: leg.mark, oi: leg.oi, iv: leg.iv, volume: leg.volume,
      ceOi: s.ceOi, peOi: s.peOi, callVolume: s.ceVolume, putVolume: s.peVolume, pcr: s.pcrOi, atmIv: s.atmIv,
    }, entryMs).then((r) => { if (live) setRows({ rows: r.rows, momentum: r.momentum, model: r.model ?? { pOtm: null, pTouch: null, emDistance: null } }); }).catch(() => { if (live) setRows({ rows: [], momentum: { velocity: null, acceleration: null }, model: { pOtm: null, pTouch: null, emDistance: null } }); });
    load();
    const id = setInterval(load, 30_000);
    return () => { live = false; clearInterval(id); };
    // The strike and the board's headline figures change every refresh; refetching on each would be a request storm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  return rows;
}

export type ChangesTab = 'CE' | 'PE' | 'BOARD';

/**
 * What changed, for a seller: one table a strike (the CE and the PE the
 * decision is about), with the premium read the short's way -- up is risk,
 * down is favourable -- beside the OI, the IV and the model's odds and
 * distance then → now, and one word a window: BETTER / NEUTRAL / WORSE. A
 * summary line above says where the last hour is heading. The BOARD tab is
 * the whole chain's calls against puts. The since-entry row runs from the
 * strategy's entry moment, once a window has passed since.
 */
export function ChangesPanel({ tab, onTab, ce, pe, board, changes }: {
  tab: ChangesTab; onTab: (t: ChangesTab) => void;
  ce: Leg | null; pe: Leg | null;
  /** The board's changes: the rows of whichever strike is loaded. */
  board: ChangeRow[] | null;
  /** The active strike's changes. */
  changes: Changes | null;
}) {
  const sgn = (v: number | null, p = 0, unit = '') => (v === null ? '—' : `${fmt.signed(v, p)}${unit}`);
  const cls = (v: number | null, invert = false) => (v === null ? 'ov-muted' : (invert ? -v : v) > 0 ? 'ov-up' : (invert ? -v : v) < 0 ? 'ov-down' : '');
  const label = (r: { minutes: number; sinceEntry?: boolean }) => (r.sinceEntry ? `entry · ${r.minutes >= 60 ? `${Math.floor(r.minutes / 60)}h ${String(r.minutes % 60).padStart(2, '0')}m` : `${r.minutes}m`}` : r.minutes >= 60 ? `${r.minutes / 60}h` : `${r.minutes}m`);
  const lamp = (i: Impact) => (i === 'BETTER' ? <span className="ov-up">🟢 Better</span> : i === 'WORSE' ? <span className="ov-down">🔴 Worse</span> : i === 'NEUTRAL' ? <span className="ov-warn">🟡 Neutral</span> : <span className="ov-muted">—</span>);
  const thenNow = (then: number | null, now: number | null, f: (v: number) => string, betterWhenUp: boolean) => {
    if (then === null || now === null) return <span className="ov-muted">{now === null ? '—' : f(now)}</span>;
    const d = now - then;
    const tone = Math.abs(d) < 1e-9 ? '' : (betterWhenUp ? d > 0 : d < 0) ? 'ov-up' : 'ov-down';
    return <span><span className="ov-muted">{f(then)} → </span><b className={tone}>{f(now)}</b></span>;
  };
  const strikeLabel = (l: Leg | null, side: 'CE' | 'PE') => (l ? `${side} ${fmt.n(l.strike)}` : side);
  const rows = tab === 'BOARD' ? board : changes?.rows ?? null;
  const model = changes?.model ?? null;
  const impacts = tab === 'BOARD' || !rows || !model ? [] : rows.filter((r) => !r.sinceEntry).map((r) => ({ minutes: r.minutes, impact: sellerImpact(r, model) }));
  const state = sellerState(impacts);
  return (
    <Panel title="What changed"
      right={
        <span className="ov-chain-head">
          <span className="ov-tabs ov-tabs-inline" role="tablist">
            {(['CE', 'PE', 'BOARD'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => onTab(t)}>
                {t === 'BOARD' ? 'Board' : strikeLabel(t === 'CE' ? ce : pe, t)}
              </button>
            ))}
          </span>
        </span>
      }>
      {tab !== 'BOARD' && impacts.length > 0 && (
        <div className="ov-impact-line">
          {impacts.map((x) => <span key={x.minutes}><small className="ov-muted">{x.minutes >= 60 ? `${x.minutes / 60}h` : `${x.minutes}m`}</small> {x.impact === 'BETTER' ? '🟢' : x.impact === 'WORSE' ? '🔴' : x.impact === 'NEUTRAL' ? '🟡' : '·'}</span>)}
          <Tag tone={state.state === 'IMPROVING' ? 'up' : state.state === 'DETERIORATING' ? 'down' : state.state === 'MIXED' ? 'warn' : 'muted'}>{state.state === 'DETERIORATING' ? '⚠ ' : ''}{state.text}</Tag>
        </div>
      )}
      {!rows ? <p className="ov-empty">{tab === 'BOARD' || (tab === 'CE' ? ce : pe) ? 'Loading…' : `No ${tab} strike on the cards.`}</p> : tab === 'BOARD' ? (
        <div className="ov-chain-wrap">
          <table className="ov-mini ov-changes">
            <thead><tr><th>Window</th><th>BTC</th><th>BTC %</th><th>CE OI Δ</th><th>PE OI Δ</th><th>Call vol Δ</th><th>Put vol Δ</th><th>PCR Δ</th><th>ATM IV Δ</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.minutes}${r.sinceEntry ? 'e' : ''}`} className={r.sinceEntry ? 'ov-atm' : undefined}>
                  <td>{label(r)}</td>
                  <td className={cls(r.spotChange)}>{sgn(r.spotChange)}</td>
                  <td className={cls(r.spotChangePct)}>{sgn(r.spotChangePct, 2, '%')}</td>
                  <td className={cls(r.ceOiChange)}>{sgn(r.ceOiChange)}</td>
                  <td className={cls(r.peOiChange)}>{sgn(r.peOiChange)}</td>
                  <td>{sgn(r.callVolumeChange)}</td>
                  <td>{sgn(r.putVolumeChange)}</td>
                  <td className={cls(r.pcrChange)}>{sgn(r.pcrChange, 2)}</td>
                  <td className={cls(r.atmIvChangePts, true)}>{sgn(r.atmIvChangePts, 1, ' pts')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ov-chain-wrap">
          <table className="ov-mini ov-changes">
            <thead>
              <tr>
                <th>Window</th><th>BTC %</th>
                <th title="The premium then → now. For a short, up is risk and down is favourable">Premium</th><th>Prem Δ</th>
                <th title="Open interest on this strike: context beside the premium, not a verdict on its own">OI Δ</th><th>IV Δ</th><th>Vol Δ</th>
                <th title="By the option model, then → now">P(OTM)</th><th title="By the option model, then → now">Touch</th><th title="By the model, then → now">Dist/EM</th>
                <th title="Premium, touch odds, distance and IV together, for the seller of this strike">Impact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.minutes}${r.sinceEntry ? 'e' : ''}`} className={r.sinceEntry ? 'ov-atm' : undefined}>
                  <td>{label(r)}</td>
                  <td className={cls(r.spotChangePct)}>{sgn(r.spotChangePct, 2, '%')}</td>
                  <td>{r.markThen === null || r.markChange === null ? '—' : <><span className="ov-muted">{fmt.n(r.markThen, 1)} → </span>{fmt.n(r.markThen + r.markChange, 1)}</>}</td>
                  <td className={cls(r.markChangePct, true)} title="For a short: up is risk, down is favourable">{r.markChangePct === null ? '—' : `${fmt.signed(r.markChangePct, 0)}% ${r.markChangePct >= 5 ? '🔴' : r.markChangePct <= -5 ? '🟢' : '🟡'}`}</td>
                  <td className={cls(r.oiChange)}>{sgn(r.oiChange)}</td>
                  <td className={cls(r.ivChangePts, true)}>{sgn(r.ivChangePts, 1)}</td>
                  <td>{sgn(r.volumeChange)}</td>
                  <td>{thenNow(r.pOtmThen, r.pOtmNow ?? model?.pOtm ?? null, (v) => `${Math.round(v * 100)}%`, true)}</td>
                  <td>{thenNow(r.pTouchThen, r.pTouchNow ?? model?.pTouch ?? null, (v) => `${Math.round(v * 100)}%`, false)}</td>
                  <td>{thenNow(r.emDistanceThen, r.emDistanceNow ?? model?.emDistance ?? null, (v) => `${v.toFixed(1)}×`, true)}</td>
                  <td>{lamp(model ? sellerImpact(r, model) : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ov-foot">{tab === 'BOARD' ? 'The whole chain: calls against puts by window.' : 'Premium ↑ = 🔴 risk for a short, ↓ = 🟢 favourable. OI beside it: premium ↑ with OI ↑ is demand, premium ↓ with OI ↑ is writing into it, both ↓ is an unwind. Odds and distance by the option model then and now.'} A dash means no record that far back.</p>
    </Panel>
  );
}

// ------------------------------------------------------------ strike finder

export function StrikeFinder({ data, onSelect, onSell, contracts, leverage, defaultSide, em, execution = 'BID', filter, onFilter, rvPct = null }: {
  data: ChainResponse; onSelect: (cp: 'C' | 'P', strike: number) => void; onSell?: (l: Leg) => void; contracts: number; leverage: number;
  defaultSide: 'C' | 'P' | 'both'; em: ExpectedMove; execution?: ScreenConfig['execution']; rvPct?: number | null;
  /** The filters, owned by the screen: the side cards above read them too. */
  filter: FinderFilter; onFilter: (f: FinderFilter) => void;
}) {
  const f = filter, setF = onFilter;
  // The side follows the desk's lean until the person picks one.
  const [sideTouched, setSideTouched] = useState(false);
  useEffect(() => { if (!sideTouched && f.side !== defaultSide) onFilter({ ...f, side: defaultSide }); }, [defaultSide]); // eslint-disable-line react-hooks/exhaustive-deps
  const spot = data.snapshot.spot;
  // The desk's own picks: its top three a side by its rules, the side it leans to first. Otherwise the operator's filters.
  const order: readonly ('C' | 'P')[] = defaultSide === 'C' ? ['C', 'P'] : ['P', 'C'];
  const picks = order.flatMap((cp) => candidates(data.legs, cp, 3));
  // Opens on the desk's picks when it has any; on the finder when nothing clears its rules, rather than on an empty table.
  const [chosenMode, setMode] = useState<'desk' | 'filters' | null>(null);
  const mode = chosenMode ?? (picks.length > 0 ? 'desk' : 'filters');
  const found = mode === 'desk' ? picks : findStrikes(data.legs, f);
  // The premium a candidate is judged at follows the execution setting: the bid a seller receives, a tick under it when thin, or the mark for comparison.
  const priceOf = (l: Leg) => (execution === 'MARK' ? l.mark : execution === 'DEPTH' ? executionEstimate(l, spot, contracts).expectedFill : l.bid ?? l.sellPrice);
  const priceLabel = execution === 'MARK' ? 'Mark' : execution === 'DEPTH' ? 'Est. fill' : 'Bid';
  const otm = data.legs.filter((l) => l.moneyness !== 'ITM').length;
  return (
    <Panel title="Strike finder" right={
        <span className="ov-chain-head">
          <span className="ov-tabs ov-tabs-inline" role="tablist">
            <button role="tab" aria-selected={mode === 'desk'} className={mode === 'desk' ? 'on' : ''} onClick={() => setMode('desk')} title="The desk's top three a side, by its own rules">Desk picks{picks.length === 0 ? ' (none)' : ''}</button>
            <button role="tab" aria-selected={mode === 'filters'} className={mode === 'filters' ? 'on' : ''} onClick={() => setMode('filters')} title="Every out-of-the-money strike, through your filters">Finder</button>
          </span>
          <small className="ov-muted">{found.length} of {otm} OTM · {contracts} ct at {leverage}x</small>
        </span>
      }>
      {mode === 'filters' && (
        <div className="ov-finder">
          {filtersChanged(f) && <button className="ov-chip" onClick={() => setF({ ...DESK_FILTER, side: f.side })} title="Back to the desk's own filters">Desk filters</button>}
          <label>Side <select className="ov-select" value={f.side} onChange={(e) => { setSideTouched(true); setF({ ...f, side: e.target.value as FinderFilter['side'] }); }}><option value="P">PE</option><option value="C">CE</option><option value="both">Both</option></select></label>
          <label>Premium ≥ <input type="number" className="ov-ctx-input" min={0} step={5} value={f.minPremium} onChange={(e) => setF({ ...f, minPremium: Number(e.target.value) || 0 })} /> <small className="ov-muted">$/BTC</small></label>
          <label>Touch ≤ <select className="ov-select" value={f.maxPot} onChange={(e) => setF({ ...f, maxPot: Number(e.target.value) })}>{[0.2, 0.25, 0.3, 0.35, 0.45, 0.6, 1].map((v) => <option key={v} value={v}>{(v * 100).toFixed(0)}%</option>)}</select></label>
          <label>Distance ≥ <select className="ov-select" value={f.minEm} onChange={(e) => setF({ ...f, minEm: Number(e.target.value) })}>{[0, 0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => <option key={v} value={v}>{v}× EM</option>)}</select></label>
          <label>Top <select className="ov-select" value={f.top} onChange={(e) => setF({ ...f, top: Number(e.target.value) })}>{[3, 5, 8, 12].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
        </div>
      )}
      {found.length === 0 ? <p className="ov-empty">{mode === 'desk' ? 'Nothing clears the desk’s rules on either side.' : 'Nothing passes these filters. Loosen one.'}</p> : (
        <table className="ov-mini ov-reco">
          <thead><tr>
            <th>Strike</th><th>Side</th><th title={`Credit for ${contracts} ct at the ${priceLabel.toLowerCase()}`}>Credit</th>
            <th title="Probability of expiring worthless">P(OTM)</th><th title="Probability BTC touches the strike before expiry">Touch</th>
            <th title="Distance from spot in expected moves">Dist/EM</th><th title="This strike's implied volatility less realised (21d), points">IV−RV</th><th title="Bid–ask spread as a share of the mid">Spread</th>
            <th title="The desk's score, 0–10">Score</th><th>Decision</th><th />
          </tr></thead>
          <tbody>
            {found.map((l) => {
              const o = odds(l);
              const px = priceOf(l);
              const est = px === null ? null : orderEstimate(l.cp, l.strike, px, spot, leverage, contracts);
              const pa = premiumAnalysis(l, em);
              const ivRvPts = l.iv !== null && rvPct !== null ? l.iv * 100 - rvPct : null;
              const decision = finderDecision(l);
              return (
                <tr key={`${l.cp}${l.strike}`} className="ov-click" onClick={() => onSelect(l.cp, l.strike)}>
                  <td>{fmt.n(l.strike)}</td><td>{l.cp === 'C' ? 'CE' : 'PE'}</td>
                  <td title={`${priceLabel} ${fmt.n(px, 1)} per BTC · margin ${est ? `$${est.marginUsd.toFixed(2)}` : '—'}`}>{est ? `$${est.creditUsd.toFixed(2)}` : '—'}</td>
                  <td className="ov-up">{fmt.pct(o.pOtm)}</td><td>{fmt.pct(o.pTouch)}</td>
                  <td>{l.emDistance === null ? '—' : `${l.emDistance.toFixed(2)}×`}</td>
                  <td className={ivRvPts === null ? '' : ivRvPts >= 0 ? 'ov-up' : 'ov-down'}>{ivRvPts === null ? '—' : `${fmt.signed(ivRvPts, 1)}`}</td>
                  <td className={pa?.spreadPct != null && pa.spreadPct > 0.1 ? 'ov-warn' : ''}>{pa?.spreadPct == null ? '—' : fmt.pct(pa.spreadPct, 1)}</td>
                  <td>{l.score === null ? '—' : (l.score * 10).toFixed(1)}</td>
                  <td><Tag tone={decision === 'RECOMMENDED' ? 'up' : decision === 'AVOID' ? 'down' : decision === 'WATCH' ? 'warn' : 'muted'}>{decision}</Tag></td>
                  <td>{onSell && data.snapshot.live && <button className="ov-sell" onClick={(e) => { e.stopPropagation(); onSell(l); }}>Sell</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="ov-foot">Out-of-the-money strikes only, best desk score first. Move a filter and the SELL CE / SELL PE cards carry the best strike that passes it. Click a row to inspect it; Sell opens the ticket, where every gate runs again.</p>
    </Panel>
  );
}

// ----------------------------------------------------------- movement type

const TYPE_LABEL: Record<string, string> = {
  LONG_BUILDUP: 'Long buildup', SHORT_COVERING: 'Short covering', SHORT_BUILDUP: 'Short buildup', LONG_UNWINDING: 'Long unwinding', MIXED: 'Mixed',
};

/**
 * The character of the move, a window at a time: which of the four types
 * price and OI make, how much volume is behind it, whether the tape's
 * aggressors agree -- and beside it the measured odds and implied move for
 * the same horizon, from the outlook. Direction is one thing; what kind of
 * move it is, another; this says both.
 */
export function MovementTypePanel({ rows, outlook }: { rows: MovementRow[] | null; outlook: ChainResponse['outlook'] }) {
  const label = (m: number) => (m >= 60 ? `${m / 60}h` : `${m}m`);
  const lamp = (r: MovementRow) => (r.type === null ? '·' : r.direction === 'UP' ? '🟢' : r.direction === 'DOWN' ? '🔴' : '⚪');
  const strengthTone = (v: MovementRow['strength']) => (v === 'EXTREME' ? 'ov-down' : v === 'STRONG' ? 'ov-warn' : v === 'WEAK' ? 'ov-muted' : '');
  return (
    <Panel title="Movement type" right={<small className="ov-muted">price · OI · volume · tape, by window</small>}>
      {!rows ? <p className="ov-empty">Loading…</p> : (
        <div className="ov-chain-wrap">
          <table className="ov-mini ov-movement">
            <thead><tr>
              <th>Window</th><th>Type</th><th title="BTC over the window">Price</th><th title="The perpetual's open interest over the window">OI</th>
              <th title="The window's volume per minute against the median minute of the last day">Vol</th><th title="Who crossed the spread: does the tape agree with the type?">Tape</th>
              <th title="Measured share of windows over this horizon that closed higher, from the current market state">P(up)</th><th title="spot × ATM IV × √t for the horizon">± EM</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const h = outlook.rows.find((o) => o.minutes === r.minutes) ?? null;
                return (
                  <tr key={r.minutes}>
                    <td>{label(r.minutes)}</td>
                    <td className={r.direction === 'UP' ? 'ov-up' : r.direction === 'DOWN' ? 'ov-down' : 'ov-muted'} title={`price ≥ ±${r.thresholds.pricePct.toFixed(2)}% and OI ≥ ±${r.thresholds.oiPct.toFixed(2)}% name a type`}>
                      {lamp(r)} {r.type ? TYPE_LABEL[r.type] : '—'}{r.strength && r.type !== 'MIXED' ? <small className={strengthTone(r.strength)}> · {r.strength.toLowerCase()}</small> : null}
                    </td>
                    <td className={r.pricePct === null ? 'ov-muted' : r.pricePct > 0 ? 'ov-up' : r.pricePct < 0 ? 'ov-down' : ''}>{r.pricePct === null ? '—' : `${fmt.signed(r.pricePct, 2)}%`}</td>
                    <td className={r.oiPct === null ? 'ov-muted' : r.oiPct > 0 ? 'ov-up' : r.oiPct < 0 ? 'ov-down' : ''}>{r.oiPct === null ? '—' : `${fmt.signed(r.oiPct, 2)}%`}</td>
                    <td className={strengthTone(r.strength)}>{r.volumeRatio === null ? '—' : `${r.volumeRatio.toFixed(1)}×`}</td>
                    <td className={r.flow === 'CONFIRMS' ? 'ov-up' : r.flow === 'DIVERGES' ? 'ov-down' : 'ov-muted'} title={r.aggressorBuyPct === null ? undefined : `${(r.aggressorBuyPct * 100).toFixed(0)}% of the volume was buys`}>
                      {r.flow === null ? '—' : r.flow === 'CONFIRMS' ? '✓ confirms' : r.flow === 'DIVERGES' ? '✕ diverges' : 'flat'}
                    </td>
                    <td>{fmt.pct(h?.pUp ?? null)}</td>
                    <td className="ov-muted">{h?.impliedUsd == null ? '—' : `±${fmt.n(h.impliedUsd)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="ov-foot">Price ↑ with OI ↑ is a long buildup, ↑ with OI ↓ short covering, ↓ with OI ↑ a short buildup, ↓ with OI ↓ a long unwinding. Price and OI cannot say who started the trade; the tape column is that check. Thresholds are the desk's starting point, not a backtested truth.</p>
    </Panel>
  );
}
