import { useEffect, useState } from 'react';
import type { ChainResponse, Leg } from '@/types/desk';
import { getChanges, type ChangeRow, type PerpResponse, type PremiumMomentum } from '@/api/desk';
import {
  boardRead, candidates, DESK_FILTER, earlyWarning, executionEstimate, filtersChanged, findStrikes, horizonRows, movementVerdict, odds, orderEstimate, shortLossAt,
  type EarlyWarning, type ExpectedMove, type FinderFilter,
} from '@/lib/overview';
import type { ScreenConfig } from '@/lib/screen-config';
import { fmt, More, Panel, Row, Tag } from './parts';

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
      <p className="ov-foot">🟢 NORMAL under 70% of the threshold · 🟡 WATCH from there · 🔴 TRIGGERED = threshold crossed. A warning level, not a trade signal: the gates decide, this says what is stirring.</p>
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
    <Panel title="Outlook · movement to expiry" right={<Tag tone={v.way === 'up' ? 'up' : v.way === 'down' ? 'down' : 'accent'}>{v.way.toUpperCase()} · {v.confidence} confidence</Tag>}>
      <p className="ov-summary">{v.text}.</p>
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
      <More label="How it is computed">
        <ul className="ov-formulas">
          <li><b>Above / inside / below:</b> where the desk's measured record for each horizon fell against the implied band, from the current market state; the three add to 100%.</li>
          <li><b>Expected move:</b> spot × ATM IV × √(horizon ÷ 1 year); the target range is spot ± that.</li>
          {board.map((b) => <li key={b.name}><b>{b.name}:</b> {b.formula}</li>)}
          <li><b>Verdict:</b> one vote per horizon tilted ten points past the band on one side (inside past a half votes range), one per board reading, one for the timeframes agreeing; the way with most votes, confidence by its share.</li>
        </ul>
      </More>
    </Panel>
  );
}

// -------------------------------------------------------------- what changed

export type Changes = { rows: ChangeRow[]; momentum: PremiumMomentum };

/** One request per strike, every 30 s: what changed by window, and the premium's momentum from the same records. */
export function useChanges(data: ChainResponse, leg: Leg | null, spot: number): Changes | null {
  const [rows, setRows] = useState<Changes | null>(null);
  const symbol = leg ? `${leg.cp}-BTC-${leg.strike}-${data.snapshot.expiry}` : null;
  const s = data.structure;
  useEffect(() => {
    if (!symbol || !leg) { setRows(null); return; }
    let live = true;
    const load = () => getChanges(symbol, {
      spot, mark: leg.mark, oi: leg.oi, iv: leg.iv, volume: leg.volume,
      ceOi: s.ceOi, peOi: s.peOi, callVolume: s.ceVolume, putVolume: s.peVolume, pcr: s.pcrOi, atmIv: s.atmIv,
    }).then((r) => { if (live) setRows({ rows: r.rows, momentum: r.momentum }); }).catch(() => { if (live) setRows({ rows: [], momentum: { velocity: null, acceleration: null } }); });
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

export function StrikeFinder({ data, onSelect, onSell, contracts, leverage, defaultSide, em, execution = 'BID', filter, onFilter }: {
  data: ChainResponse; onSelect: (cp: 'C' | 'P', strike: number) => void; onSell?: (l: Leg) => void; contracts: number; leverage: number;
  defaultSide: 'C' | 'P' | 'both'; em: ExpectedMove; execution?: ScreenConfig['execution'];
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
    <div className="ov-strikes">
      <h4 className="ov-subhead">
        <span>Strikes</span>
        <span className="ov-chain-head">
          <span className="ov-tabs ov-tabs-inline" role="tablist">
            <button role="tab" aria-selected={mode === 'desk'} className={mode === 'desk' ? 'on' : ''} onClick={() => setMode('desk')} title="The desk's top three a side, by its own rules">Desk picks{picks.length === 0 ? ' (none)' : ''}</button>
            <button role="tab" aria-selected={mode === 'filters'} className={mode === 'filters' ? 'on' : ''} onClick={() => setMode('filters')} title="Every out-of-the-money strike, through your filters">Finder</button>
          </span>
          <small className="ov-muted">{found.length} of {otm} OTM · {contracts} ct at {leverage}x</small>
        </span>
      </h4>
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
            <th title="Probability of expiring worthless">POP</th><th title="Probability BTC touches the strike before expiry">Touch</th><th title="Distance from spot in expected moves">Dist/EM</th>
            <th title="Expected P&L for your size, after charges">Exp. P&amp;L</th><th title="Loss at an adverse move of two expected moves">Tail 2×EM</th><th title="Margin estimate at the ticket's leverage">Margin</th>
            <th title="The desk's score, 0–10">Score</th><th>Says</th><th />
          </tr></thead>
          <tbody>
            {found.map((l) => {
              const o = odds(l);
              const px = priceOf(l);
              const est = px === null ? null : orderEstimate(l.cp, l.strike, px, spot, leverage, contracts);
              const adverse = em ? (l.cp === 'C' ? spot + 2 * em.move : spot - 2 * em.move) : null;
              const tail = px !== null && adverse !== null ? shortLossAt(l.cp, l.strike, px, adverse, contracts) : null;
              return (
                <tr key={`${l.cp}${l.strike}`} className="ov-click" onClick={() => onSelect(l.cp, l.strike)}>
                  <td>{fmt.n(l.strike)}</td><td>{l.cp === 'C' ? 'CE' : 'PE'}</td>
                  <td title={`${priceLabel} ${fmt.n(px, 1)} per BTC`}>{est ? `$${est.creditUsd.toFixed(2)}` : '—'}</td>
                  <td className="ov-up">{fmt.pct(o.pOtm)}</td><td>{fmt.pct(o.pTouch)}</td>
                  <td>{l.emDistance === null ? '—' : `${l.emDistance.toFixed(2)}×`}</td>
                  <td className={l.ev?.evUsd == null ? '' : l.ev.evUsd >= 0 ? 'ov-up' : 'ov-down'}>{fmt.signed(l.ev?.evUsd ?? null, 2)}</td>
                  <td className="ov-down">{tail === null ? '—' : `$${tail.toFixed(2)}`}</td>
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
      <p className="ov-foot">Out-of-the-money strikes only, best desk score first. Move a filter and the two cards above carry the best strike that passes it. Click a row to inspect it; Sell opens the ticket, where every gate runs again.</p>
    </div>
  );
}
