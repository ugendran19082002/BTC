import { useEffect, useState } from 'react';
import type { ChainResponse, Leg } from '@/types/desk';
import { getChanges, type ChangeRow, type PerpResponse } from '@/api/desk';
import {
  boardRead, earlyWarning, findStrikes, horizonRows, movementVerdict, odds, orderEstimate,
  type EarlyWarning, type ExpectedMove, type FinderFilter, type Readiness, type SideAssessment, type SideChoice,
} from '@/lib/overview';
import { fmt, More, Panel, Row, Tag } from './parts';

const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

// ------------------------------------------------------------ the decision

/**
 * The one answer a seller wants at the moment of entry, whichever moment that
 * is: SELL CE, SELL PE, SELL BOTH or NO TRADE -- with the strike, what it
 * pays, its odds, and what is in the way. Everything below this card is the
 * working.
 */
export function DecisionHero({ data, now, choice, sides, ready, leg, contracts, leverage, onSell }: {
  data: ChainResponse; now: number; choice: SideChoice; sides: SideAssessment[]; ready: Readiness; leg: Leg | null;
  contracts: number; leverage: number; onSell?: (l: Leg) => void;
}) {
  const snap = data.snapshot;
  const legs = choice.side === 'BOTH' ? sides.map((s) => s.leg).filter((l): l is Leg => l !== null) : choice.side === 'NO_TRADE' ? [] : [sides.find((s) => s.side === choice.side)?.leg ?? null].filter((l): l is Leg => l !== null);
  const tone = choice.side === 'NO_TRADE' ? 'down' : choice.side === 'BOTH' ? 'up' : 'accent';
  const focus = sides.find((s) => s.side === (choice.side === 'CE' ? 'CE' : choice.side === 'PE' ? 'PE' : leg?.cp === 'C' ? 'CE' : 'PE'));
  const blockers = ready.gates.filter((g) => g.ok === false).slice(0, 4);
  return (
    <section className={`ov-hero ov-hero-${tone}`} aria-label="Decision">
      <div className="ov-hero-main">
        <span className="ov-hero-when">Entry now · {IST_HM.format(new Date(snap.live ? now : snap.ts * 1000))} IST → expiry {IST_HM.format(new Date(snap.expiryTs * 1000))} · {snap.hoursToExpiry.toFixed(1)}h left</span>
        <h2 className="ov-hero-verdict">
          {choice.side === 'NO_TRADE' ? 'NO TRADE' : choice.side === 'BOTH' ? 'SELL BOTH' : `SELL ${choice.side}`}
          {legs.length > 0 && <small> {legs.map((l) => `${fmt.n(l.strike)} ${l.cp === 'C' ? 'CE' : 'PE'}`).join(' + ')}</small>}
        </h2>
        <p className="ov-hero-why">{choice.why}. {ready.ready ? 'Every gate is green.' : `${ready.failing} gate${ready.failing === 1 ? '' : 's'} failing${ready.unknown ? `, ${ready.unknown} unreadable` : ''}.`}</p>
        {blockers.length > 0 && (
          <ul className="ov-hero-blockers">{blockers.map((b) => <li key={b.key}>✕ {b.text}</li>)}</ul>
        )}
      </div>
      <div className="ov-hero-side">
        {legs.map((l) => {
          const o = odds(l);
          const px = l.bid ?? l.sellPrice ?? l.mark;
          const est = px === null ? null : orderEstimate(l.cp, l.strike, px, snap.spot, leverage, contracts);
          return (
            <div key={l.strike + l.cp} className="ov-hero-leg">
              <b>{fmt.n(l.strike)} {l.cp === 'C' ? 'CE' : 'PE'}</b>
              <span>bid {fmt.n(px, 1)} · credit {est ? `$${est.creditUsd.toFixed(2)}` : '—'} for {contracts} ct</span>
              <span>POP {fmt.pct(o.pOtm)} · touch {fmt.pct(o.pTouch)} · {l.emDistance === null ? '—' : `${l.emDistance.toFixed(2)}× EM`}</span>
              <span>margin {est ? `$${est.marginUsd.toFixed(2)}` : '—'} · break-even {est ? fmt.n(est.breakevenAfterFees) : '—'}</span>
              {onSell && snap.live && <button className="ov-sell" onClick={() => onSell(l)}>Sell {fmt.n(l.strike)} {l.cp === 'C' ? 'CE' : 'PE'} via ticket</button>}
            </div>
          );
        })}
        {legs.length === 0 && focus?.leg && (
          <div className="ov-hero-leg ov-muted">
            <b>Closest: {fmt.n(focus.leg.strike)} {focus.side}</b>
            <span>{focus.status} · score {focus.score === null ? '—' : focus.score.toFixed(1)} / 10</span>
          </div>
        )}
        <Tag tone={ready.ready ? 'up' : 'down'}>{ready.verdict}</Tag>
      </div>
    </section>
  );
}

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
      <table className="ov-mini ov-triggers">
        <thead><tr><th>Trigger</th><th>Now</th><th>Fires at</th><th /></tr></thead>
        <tbody>
          {w.triggers.map((t) => (
            <tr key={t.name} className={t.fired ? 'ov-fired' : undefined} title={t.formula}>
              <td>{t.name}</td><td>{t.value}</td><td className="ov-muted">{t.threshold}</td>
              <td className={t.fired === null ? 'ov-muted' : t.fired ? 'ov-down' : 'ov-up'}>{t.fired === null ? '?' : t.fired ? 'FIRED' : 'quiet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <More label="Formulas and the reference case">
        <ul className="ov-formulas">{w.triggers.map((t) => <li key={t.name}><b>{t.name}:</b> {t.formula}</li>)}</ul>
        <p className="ov-foot">
          Score = fired weight ÷ readable weight: watch ≥ 20%, high ≥ 40%, sudden ≥ 60%. Reference, 28 Aug 2025 (chain.db): entry 111,191, settle 112,920;
          the 114,000 CE sold at 22.7 fell to 5.6 by hour 4, then printed 101.9 in hour 5 and 116 at its high — 5.1× the entry premium. A move like that
          shows first as volume, one-sided aggressors and the wing's premium jumping; this panel watches for exactly those.
        </p>
      </More>
    </Panel>
  );
}

// ------------------------------------------------------ movement to expiry

export function MovementPanel({ data, em, activeMin }: { data: ChainResponse; em: ExpectedMove; activeMin: number }) {
  const rows = horizonRows(data.outlook).filter((r) => r.minutes <= Math.max(60, data.snapshot.hoursToExpiry * 60 + 1));
  const board = boardRead(data, em);
  const v = movementVerdict(rows, board, data.market, data.snapshot.hoursToExpiry);
  const says = (s: string) => (s === 'up' ? 'ov-up' : s === 'down' ? 'ov-down' : 'ov-muted');
  return (
    <Panel title="Movement to expiry" right={<Tag tone={v.way === 'up' ? 'up' : v.way === 'down' ? 'down' : 'accent'}>{v.way.toUpperCase()} · {v.confidence} confidence</Tag>}>
      <p className="ov-summary">{v.text}.</p>
      <table className="ov-mini ov-horizons">
        <thead><tr><th>Next</th><th>Up</th><th>Down</th><th>Range</th><th>Expected move</th><th>Target range</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r.minutes === activeMin ? 'ov-atm' : undefined}>
              <td>{r.label}{r.minutes === activeMin ? ' ◆' : ''}</td>
              <td className="ov-up">{fmt.pct(r.pUp)}</td><td className="ov-down">{fmt.pct(r.pDown)}</td><td className="ov-muted">{fmt.pct(r.pRange)}</td>
              <td>{r.em === null ? '—' : `±${fmt.n(r.em)}`}</td>
              <td className="ov-muted">{r.low === null || r.high === null ? '—' : `${fmt.n(r.low)} – ${fmt.n(r.high)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ov-board-read">
        {board.map((b) => (
          <Row key={b.name} mark="arrow" tone={b.says === 'up' ? 'up' : b.says === 'down' ? 'down' : 'muted'} label={b.name} value={<span className={says(b.says)}>{b.text}</span>} hint={b.formula} />
        ))}
      </div>
      <More label="How it is computed">
        <ul className="ov-formulas">
          <li><b>Up / down / range:</b> measured over the desk's history for each horizon from the current market state; never a coin flip dressed up.</li>
          <li><b>Expected move:</b> spot × ATM IV × √(horizon ÷ 1 year); the target range is spot ± that.</li>
          {board.map((b) => <li key={b.name}><b>{b.name}:</b> {b.formula}</li>)}
          <li><b>Verdict:</b> one vote per horizon leaning past 55 / 45, one per board reading, one for the timeframes agreeing; the way with most votes, confidence by its share.</li>
        </ul>
      </More>
    </Panel>
  );
}

// -------------------------------------------------------------- what changed

export function useChanges(data: ChainResponse, leg: Leg | null, spot: number): ChangeRow[] | null {
  const [rows, setRows] = useState<ChangeRow[] | null>(null);
  const symbol = leg ? `${leg.cp}-BTC-${leg.strike}-${data.snapshot.expiry}` : null;
  const s = data.structure;
  useEffect(() => {
    if (!symbol || !leg) { setRows(null); return; }
    let live = true;
    const load = () => getChanges(symbol, {
      spot, mark: leg.mark, oi: leg.oi, iv: leg.iv, volume: leg.volume,
      ceOi: s.ceOi, peOi: s.peOi, callVolume: s.ceVolume, putVolume: s.peVolume, pcr: s.pcrOi, atmIv: s.atmIv,
    }).then((r) => { if (live) setRows(r.rows); }).catch(() => { if (live) setRows([]); });
    load();
    const id = setInterval(load, 30_000);
    return () => { live = false; clearInterval(id); };
    // The strike and the board's headline figures change every refresh; refetching on each would be a request storm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);
  return rows;
}

export function ChangesPanel({ leg, rows }: { leg: Leg | null; rows: ChangeRow[] | null }) {
  const sgn = (v: number | null, p = 0, unit = '') => (v === null ? '—' : `${fmt.signed(v, p)}${unit}`);
  const cls = (v: number | null, invert = false) => (v === null ? 'ov-muted' : (invert ? -v : v) > 0 ? 'ov-up' : (invert ? -v : v) < 0 ? 'ov-down' : '');
  const label = (m: number) => (m >= 60 ? `${m / 60}h` : `${m}m`);
  return (
    <Panel title={`What changed · last 1m … 12h${leg ? ` · ${fmt.n(leg.strike)} ${leg.cp === 'C' ? 'CE' : 'PE'}` : ''}`}
      right={<small className="ov-muted">BTC by the minute · strike and board by the 5-minute record</small>}>
      {!rows ? <p className="ov-empty">{leg ? 'Loading…' : 'Select a strike.'}</p> : (
        <div className="ov-chain-wrap">
          <table className="ov-mini ov-changes">
            <thead>
              <tr><th>Window</th><th>BTC</th><th>BTC %</th><th>Premium</th><th>Premium %</th><th>Strike OI</th><th>Strike IV</th><th>Strike vol</th><th>CE OI</th><th>PE OI</th><th>Call vol</th><th>Put vol</th><th>PCR</th><th>ATM IV</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.minutes}>
                  <td>{label(r.minutes)}</td>
                  <td className={cls(r.spotChange)}>{sgn(r.spotChange)}</td>
                  <td className={cls(r.spotChangePct)}>{sgn(r.spotChangePct, 2, '%')}</td>
                  <td className={cls(r.markChange, true)} title="Rising premium is against a short">{sgn(r.markChange, 1)}</td>
                  <td className={cls(r.markChangePct, true)}>{sgn(r.markChangePct, 0, '%')}</td>
                  <td className={cls(r.oiChange)}>{sgn(r.oiChange)}</td>
                  <td className={cls(r.ivChangePts, true)}>{sgn(r.ivChangePts, 1, ' pts')}</td>
                  <td>{sgn(r.volumeChange)}</td>
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
      )}
      <p className="ov-foot">Green helps a short, red hurts it. A dash means the desk has no record that far back — the records began 17–19 Sep 2026 and fill in from here.</p>
    </Panel>
  );
}

// ------------------------------------------------------------ strike finder

export function StrikeFinderPanel({ data, onSelect, onSell, contracts, leverage, defaultSide }: {
  data: ChainResponse; onSelect: (cp: 'C' | 'P', strike: number) => void; onSell?: (l: Leg) => void; contracts: number; leverage: number; defaultSide: 'C' | 'P' | 'both';
}) {
  const [f, setF] = useState<FinderFilter>({ side: defaultSide, minPremium: 15, maxPot: 0.35, minEm: 1, top: 5 });
  useEffect(() => { setF((x) => ({ ...x, side: defaultSide })); }, [defaultSide]);
  const found = findStrikes(data.legs, f);
  const spot = data.snapshot.spot;
  return (
    <Panel title="Strike finder" right={<small className="ov-muted">{found.length} of {data.legs.filter((l) => l.moneyness !== 'ITM').length} OTM strikes pass</small>}>
      <div className="ov-finder">
        <label>Side <select className="ov-select" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value as FinderFilter['side'] })}><option value="P">PE</option><option value="C">CE</option><option value="both">Both</option></select></label>
        <label>Premium ≥ <input type="number" className="ov-ctx-input" min={0} step={5} value={f.minPremium} onChange={(e) => setF({ ...f, minPremium: Number(e.target.value) || 0 })} /> <small className="ov-muted">$/BTC</small></label>
        <label>Touch ≤ <select className="ov-select" value={f.maxPot} onChange={(e) => setF({ ...f, maxPot: Number(e.target.value) })}>{[0.2, 0.25, 0.3, 0.35, 0.45, 0.6, 1].map((v) => <option key={v} value={v}>{(v * 100).toFixed(0)}%</option>)}</select></label>
        <label>Distance ≥ <select className="ov-select" value={f.minEm} onChange={(e) => setF({ ...f, minEm: Number(e.target.value) })}>{[0, 0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => <option key={v} value={v}>{v}× EM</option>)}</select></label>
        <label>Top <select className="ov-select" value={f.top} onChange={(e) => setF({ ...f, top: Number(e.target.value) })}>{[3, 5, 8, 12].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
      </div>
      {found.length === 0 ? <p className="ov-empty">Nothing passes these filters. Loosen one.</p> : (
        <table className="ov-mini ov-reco">
          <thead><tr><th>Strike</th><th>Side</th><th>Bid</th><th>Credit</th><th>POP</th><th>Touch</th><th>Dist/EM</th><th>Margin</th><th>Score</th><th>Says</th><th /></tr></thead>
          <tbody>
            {found.map((l) => {
              const o = odds(l);
              const px = l.bid ?? l.sellPrice ?? l.mark;
              const est = px === null ? null : orderEstimate(l.cp, l.strike, px, spot, leverage, contracts);
              return (
                <tr key={`${l.cp}${l.strike}`} className="ov-click" onClick={() => onSelect(l.cp, l.strike)}>
                  <td>{fmt.n(l.strike)}</td><td>{l.cp === 'C' ? 'CE' : 'PE'}</td><td>{fmt.n(px, 1)}</td>
                  <td>{est ? `$${est.creditUsd.toFixed(2)}` : '—'}</td>
                  <td className="ov-up">{fmt.pct(o.pOtm)}</td><td>{fmt.pct(o.pTouch)}</td>
                  <td>{l.emDistance === null ? '—' : `${l.emDistance.toFixed(2)}×`}</td>
                  <td>{est ? `$${est.marginUsd.toFixed(2)}` : '—'}</td>
                  <td>{l.score === null ? '—' : (l.score * 10).toFixed(1)}</td>
                  <td><Tag tone={l.ev?.signal === 'sell' ? 'up' : l.ev?.signal === 'avoid' ? 'down' : 'muted'}>{l.ev?.signal ?? '—'}</Tag></td>
                  <td>{onSell && data.snapshot.live && <button className="ov-sell" onClick={(e) => { e.stopPropagation(); onSell(l); }}>Sell</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="ov-foot">Out-of-the-money strikes only, best desk score first, after your filters. Click a row to inspect it; Sell opens the ticket.</p>
    </Panel>
  );
}
