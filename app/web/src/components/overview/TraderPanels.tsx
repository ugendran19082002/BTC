import { useEffect, useState } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { ChainResponse, Leg } from '@/types/desk';
import { getChanges, type ChangeRow, type ModelNow, type MovementRow, type PerpResponse, type PremiumMomentum } from '@/api/desk';
import {
  boardRead, candidates, DESK_FILTER, earlyWarning, executionEstimate, filtersChanged, finderDecision, finderRanks, findStrikes, horizonRows, movementVerdict, odds, orderEstimate, premiumAnalysis, sellerImpact, sellerState,
  type EarlyWarning, type ExpectedMove, type FinderFilter, type Impact, type MtfConsensus,
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
    <Panel title="Early warning" right={<Tag tone={tone}>{w.band.toUpperCase()}{w.score === null ? '' : ` · ${(w.score * 100).toFixed(0)}%`}{w.lean ? ` · pressure ${w.lean > 0 ? 'up ↑' : 'down ↓'}` : ''}</Tag>}>
      <p className="ov-summary">{w.action}{shock && shock.score !== null ? ` Measured sudden-move score ${shock.score.toFixed(0)} (${shock.band}).` : ''}</p>
      <ul className="ov-triggers">
        {w.triggers.map((t) => (
          <li key={t.name} className={`ov-trigger-compact${t.state === 'TRIGGERED' ? ' ov-fired' : t.state === 'WATCH' ? ' ov-watching' : ''}`} title={`${t.value} · triggers ${t.threshold} · ${t.formula}`}>
            <span className="ov-trigger-name">{t.name}</span>
            <span className={`ov-trigger-state ov-lamp-${t.state?.toLowerCase() ?? 'none'}`}><i aria-hidden />{t.state ?? 'not read'}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------ movement to expiry

const TYPE_LABEL: Record<string, string> = {
  LONG_BUILDUP: 'Long buildup', SHORT_COVERING: 'Short covering', SHORT_BUILDUP: 'Short buildup', LONG_UNWINDING: 'Long unwinding', MIXED: 'Mixed',
};

/**
 * Multi-timeframe, the one place: a row a horizon with the direction the
 * timeframe votes (EMA trend, RSI momentum, the measured odds together),
 * the character of the move the perpetual's price, OI and tape make of it,
 * the measured odds and where they fell against the implied band, and the
 * implied move. The consensus at the foot is the input the side selection
 * reads; the cards say only whether it passed. Under it, the board read.
 */
export function MovementPanel({ data, em, activeMin, mtf, movement }: { data: ChainResponse; em: ExpectedMove; activeMin: number; mtf: MtfConsensus; movement: MovementRow[] | null }) {
  const rows = horizonRows(data.outlook).filter((r) => r.minutes <= Math.max(60, data.snapshot.hoursToExpiry * 60 + 1));
  const board = boardRead(data, em);
  const v = movementVerdict(rows, board, data.market, data.snapshot.hoursToExpiry);
  const says = (s: string) => (s === 'up' ? 'ov-up' : s === 'down' ? 'ov-down' : 'ov-muted');
  const mins: Record<string, number> = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '3h': 180, '4h': 240, '6h': 360, '12h': 720, '1d': 1440 };
  const labels = [...new Set([...mtf.rows.map((r) => r.tf), ...rows.map((r) => r.label)])].filter((l) => l in mins).sort((a, b) => mins[a]! - mins[b]!);
  const tone = (v: string | null | undefined) => (v === '↑' || v === 'UP' ? 'ov-up' : v === '↓' || v === 'DOWN' ? 'ov-down' : 'ov-muted');
  return (
    <Panel title="Multi-timeframe" right={<Tag tone={mtf.way === 'UP' ? 'up' : mtf.way === 'DOWN' ? 'down' : 'muted'}>MTF consensus {mtf.text}</Tag>}>
      <p className="ov-summary">{v.text}.</p>
      <div className="ov-chain-wrap">
        <table className="ov-mini ov-mtf">
          <thead><tr>
            <th>TF</th><th title="The timeframe's vote: EMA trend, RSI momentum and the measured odds, majority">Direction</th>
            <th title="What the perpetual's price, OI and tape make of the move over this window">Type</th>
            <th title="Measured share of windows over this horizon that closed higher">P(up)</th>
            <th title="Where the measured record fell against the implied band: above · inside · below">Band</th>
            <th title="spot × ATM IV × √t for the horizon">± Move</th>
          </tr></thead>
          <tbody>
            {labels.map((tf) => {
              const m = mtf.rows.find((r) => r.tf === tf) ?? null;
              const h = rows.find((r) => r.label === tf) ?? null;
              const t = movement?.find((r) => r.minutes === mins[tf]) ?? null;
              return (
                <tr key={tf} className={mins[tf] === activeMin ? 'ov-atm' : undefined}>
                  <td>{tf}{mins[tf] === activeMin ? ' ◆' : ''}</td>
                  <td className={tone(m?.signal)}>{m?.signal === '↑' ? 'UP' : m?.signal === '↓' ? 'DOWN' : m?.signal === '→' ? 'SIDE' : '—'}</td>
                  <td className={t?.direction === 'UP' ? 'ov-up' : t?.direction === 'DOWN' ? 'ov-down' : 'ov-muted'} title={t ? `price ${t.pricePct === null ? '—' : `${fmt.signed(t.pricePct, 2)}%`} · OI ${t.oiPct === null ? '—' : `${fmt.signed(t.oiPct, 2)}%`} · volume ${t.volumeRatio === null ? '—' : `${t.volumeRatio.toFixed(1)}×`} · tape ${t.flow?.toLowerCase() ?? '—'}` : undefined}>
                    {t?.type ? TYPE_LABEL[t.type] : '—'}{t?.strength && t.type !== 'MIXED' ? <small className="ov-muted"> · {t.strength.toLowerCase()}</small> : null}{t?.flow === 'CONFIRMS' ? <small className="ov-up"> ✓</small> : t?.flow === 'DIVERGES' ? <small className="ov-down"> ✕</small> : null}
                  </td>
                  <td>{fmt.pct(m?.pUp ?? null)}</td>
                  <td className="ov-muted">{h ? `${fmt.pct(h.pUp)} · ${fmt.pct(h.pRange)} · ${fmt.pct(h.pDown)}` : '—'}</td>
                  <td className="ov-muted">{h?.em == null ? '—' : `±${fmt.n(h.em)}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="ov-foot">Type: price ↑ with OI ↑ is a long buildup, ↑ with OI ↓ short covering, ↓ with OI ↑ a short buildup, ↓ with OI ↓ a long unwinding; ✓ / ✕ is whether the tape's aggressors agree. The three band shares add to 100%.</p>
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

/**
 * What changed, for a seller: one table a strike (the CE and the PE the
 * decision is about), with the premium read the short's way -- up is risk,
 * down is favourable -- beside the OI, the IV and the model's odds and
 * distance then → now, and one word a window: BETTER / NEUTRAL / WORSE. A
 * summary line above says where the last hour is heading. Both chosen
 * strikes, CE then PE. The since-entry row runs from the strategy's entry
 * moment, once a window has passed since.
 */
export function ChangesPanel({ strikes }: { strikes: { leg: Leg | null; changes: Changes | null }[] }) {
  const shown = strikes.filter((x) => x.leg);
  const title = shown.map((x) => `${fmt.n(x.leg!.strike)} ${x.leg!.cp === 'C' ? 'CE' : 'PE'}`).join(' · ');
  return (
    <Panel title={`What changed${title ? ` · ${title}` : ''}`} right={<small className="ov-muted">the chosen strikes, 1m … 12h and since entry</small>}>
      {shown.length === 0 ? <p className="ov-empty">Choose a strike on the chain.</p> : shown.map((x) => <ChangesTable key={`${x.leg!.cp}${x.leg!.strike}`} leg={x.leg!} changes={x.changes} two={shown.length > 1} />)}
      <p className="ov-foot">Premium ↑ = 🔴 risk for a short, ↓ = 🟢 favourable. OI beside it: premium ↑ with OI ↑ is demand, premium ↓ with OI ↑ is writing into it, both ↓ is an unwind. Touch odds and distance by the option model then → now. A dash means no record that far back.</p>
    </Panel>
  );
}

function ChangesTable({ leg, changes, two }: { leg: Leg; changes: Changes | null; two: boolean }) {
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
  const rows = changes?.rows ?? null;
  const model = changes?.model ?? null;
  const impacts = !rows || !model ? [] : rows.filter((r) => !r.sinceEntry).map((r) => ({ minutes: r.minutes, impact: sellerImpact(r, model) }));
  const state = sellerState(impacts);
  return (
    <div className="ov-changes-block">
      {two && <h4 className="ov-subhead"><span>{fmt.n(leg.strike)} {leg.cp === 'C' ? 'CE' : 'PE'}</span></h4>}
      {impacts.length > 0 && (
        <div className="ov-impact-line">
          {impacts.map((x) => <span key={x.minutes}><small className="ov-muted">{x.minutes >= 60 ? `${x.minutes / 60}h` : `${x.minutes}m`}</small> {x.impact === 'BETTER' ? '🟢' : x.impact === 'WORSE' ? '🔴' : x.impact === 'NEUTRAL' ? '🟡' : '·'}</span>)}
          <Tag tone={state.state === 'IMPROVING' ? 'up' : state.state === 'DETERIORATING' ? 'down' : state.state === 'MIXED' ? 'warn' : 'muted'}>{state.state === 'DETERIORATING' ? '⚠ ' : ''}{state.text}</Tag>
        </div>
      )}
      {!rows ? <p className="ov-empty">Loading…</p> : (
        <div className="ov-chain-wrap">
          <table className="ov-mini ov-changes">
            <thead>
              <tr>
                <th>Window</th><th title="BTC over the window">BTC Δ</th>
                <th title="The premium then → now. For a short, up is risk and down is favourable">Premium</th><th>Prem Δ</th>
                <th title="Open interest on this strike: context beside the premium, not a verdict on its own">OI Δ</th><th>IV Δ</th><th>Vol</th>
                <th title="By the option model, then → now">Touch Δ</th><th title="By the model, then → now">Dist/EM Δ</th>
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
                  <td>{thenNow(r.pTouchThen, r.pTouchNow ?? model?.pTouch ?? null, (v) => `${Math.round(v * 100)}%`, false)}</td>
                  <td>{thenNow(r.emDistanceThen, r.emDistanceNow ?? model?.emDistance ?? null, (v) => `${v.toFixed(1)}×`, true)}</td>
                  <td>{lamp(model ? sellerImpact(r, model) : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
  const [chosenMode, setMode] = usePersisted<'desk' | 'filters' | null>('live:finder:mode', null);
  const mode = chosenMode ?? (picks.length > 0 ? 'desk' : 'filters');
  const found = mode === 'desk' ? picks : findStrikes(data.legs, f);
  const ranks = finderRanks(found);
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
                  <td>{fmt.n(l.strike)}{(ranks.get(`${l.cp}${l.strike}`) ?? []).map((r) => <Tag key={r} tone={r === 'BEST SAFE' ? 'up' : r === 'BEST PREMIUM' ? 'warn' : 'accent'}><span className="ov-rank">{r}</span></Tag>)}</td><td>{l.cp === 'C' ? 'CE' : 'PE'}</td>
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
      <p className="ov-foot">Out-of-the-money strikes only, best desk score first. BEST SAFE is the lowest touch odds on its side, BEST BALANCED the desk's score, BEST PREMIUM the most credit. Move a filter and the SELL CE / SELL PE cards carry the best strike that passes it. Click a row to inspect it; Sell opens the ticket, where every gate runs again.</p>
    </Panel>
  );
}
