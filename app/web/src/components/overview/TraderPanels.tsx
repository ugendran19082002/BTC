import { useEffect, useState } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import type { ChainResponse, Leg } from '@/types/desk';
import { getChanges, type ChangeRow, type ModelNow, type MovementRow, type PerpResponse, type PremiumMomentum } from '@/api/desk';
import {
  boardRead, candidates, DESK_FILTER, earlyWarning, executionEstimate, filtersChanged, finderDecision, finderRanks, findStrikes, horizonRows, movementVerdict, odds, orderEstimate, premiumAnalysis, sellerImpact, sellerState,
  type EarlyWarning, type ExpectedMove, type ExpiryDirection, type FinderFilter, type Impact, type MtfConsensus,
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
    <Panel
      title="Big move catch"
      right={(
        <Tag tone={tone}>
          {w.band.toUpperCase()}
          {w.pressure === null ? '' : ` · ${w.pressure}/100`}
          {w.lean ? ` · pressure ${w.lean > 0 ? 'up ↑' : 'down ↓'}` : ''}
        </Tag>
      )}
    >
      <p className="ov-summary">{w.action}{shock && shock.score !== null ? ` Measured sudden-move score ${shock.score.toFixed(0)} (${shock.band}).` : ''}</p>
      {/*
        Every reading with how far it has come, not just whether it has gone.
        Nine grey lamps look the same at twenty as at eighty, and eighty is the
        interesting one -- it is the whole reason to have an early warning
        rather than a late one. The bar is the score; the lamp still says
        whether the threshold is actually crossed, because those are different
        claims and the second is the one a position is changed on.
      */}
      <ul className="ov-triggers ov-triggers-scored">
        <li className="ov-trigger-head" aria-hidden>
          <span>Signal</span><span>Score (now)</span><span>State</span>
        </li>
        {w.triggers.map((t) => (
          <li
            key={t.name}
            className={`ov-trigger-compact${t.state === 'TRIGGERED' ? ' ov-fired' : t.state === 'WATCH' ? ' ov-watching' : ''}`}
            title={`${t.value} · triggers ${t.threshold} · ${t.formula}`}
          >
            <span className="ov-trigger-name">{t.name}</span>
            <span className="ov-trigger-score">
              <span className="ov-trigger-bar" aria-hidden>
                <i style={{ width: `${t.score ?? 0}%` }} />
              </span>
              <b>{t.score === null ? '—' : `${t.score}/100`}</b>
            </span>
            <span className={`ov-trigger-state ov-lamp-${t.state?.toLowerCase() ?? 'none'}`}><i aria-hidden />{t.state ?? 'not read'}</span>
          </li>
        ))}
      </ul>
      <p className="ov-note">
        Score is how far each reading has come towards its own trigger, out of 100 — not a chance of a move.
        The band is set by what has actually crossed.
      </p>
    </Panel>
  );
}

// ------------------------------------------------------ movement to expiry

const TYPE_LABEL: Record<string, string> = {
  LONG_BUILDUP: 'Long buildup', SHORT_COVERING: 'Short covering', SHORT_BUILDUP: 'Short buildup', LONG_UNWINDING: 'Long unwinding', MIXED: 'Mixed',
};
/** What each type means for the price: new positions are pressure, positions closing are only potential. */
const TYPE_PRESSURE: Record<string, { text: string; tone: 'ov-up' | 'ov-down' }> = {
  LONG_BUILDUP: { text: 'Bullish pressure', tone: 'ov-up' }, SHORT_BUILDUP: { text: 'Bearish pressure', tone: 'ov-down' },
  SHORT_COVERING: { text: 'Potential bullish', tone: 'ov-up' }, LONG_UNWINDING: { text: 'Potential bearish', tone: 'ov-down' },
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
            <th title="spot × ATM IV × √t for the horizon, signed by the direction: + UP, − DOWN, ± SIDE">Expected move</th>
          </tr></thead>
          <tbody>
            {labels.map((tf) => {
              const m = mtf.rows.find((r) => r.tf === tf) ?? null;
              const h = rows.find((r) => r.label === tf) ?? null;
              const t = movement?.find((r) => r.minutes === mins[tf]) ?? null;
              const pressure = t?.type ? TYPE_PRESSURE[t.type] ?? null : null;
              return (
                <tr key={tf} className={mins[tf] === activeMin ? 'ov-atm' : undefined}>
                  <td>{tf}{mins[tf] === activeMin ? ' ◆' : ''}</td>
                  <td className={tone(m?.signal)}>{m?.signal === '↑' ? 'UP' : m?.signal === '↓' ? 'DOWN' : m?.signal === '→' ? 'SIDE' : '—'}</td>
                  <td className={t?.direction === 'UP' ? 'ov-up' : t?.direction === 'DOWN' ? 'ov-down' : 'ov-muted'} title={t ? `price ${t.pricePct === null ? '—' : `${fmt.signed(t.pricePct, 2)}%`} · OI ${t.oiPct === null ? '—' : `${fmt.signed(t.oiPct, 2)}%`} · volume ${t.volumeRatio === null ? '—' : `${t.volumeRatio.toFixed(1)}×`} · tape ${t.flow?.toLowerCase() ?? '—'}` : undefined}>
                    {t?.type ? TYPE_LABEL[t.type] : '—'}{t?.strength && t.type !== 'MIXED' ? <small className="ov-muted"> · {t.strength.toLowerCase()}</small> : null}{t?.flow === 'CONFIRMS' ? <small className="ov-up"> ✓</small> : t?.flow === 'DIVERGES' ? <small className="ov-down"> ✕</small> : null}
                    {pressure ? <small className={`ov-mtf-pressure ${pressure.tone}`}>{pressure.text}</small> : null}
                  </td>
                  <td>{fmt.pct(m?.pUp ?? null)}</td>
                  <td className="ov-muted">{h ? `${fmt.pct(h.pUp)} · ${fmt.pct(h.pRange)} · ${fmt.pct(h.pDown)}` : '—'}</td>
                  <td className={tone(m?.signal)} title="The expected move for the horizon, signed by the timeframe's direction: + for UP, − for DOWN, ± for SIDE">
                    {h?.em == null ? '—' : `${m?.signal === '↑' ? '+' : m?.signal === '↓' ? '−' : '±'}${fmt.n(h.em)} pts`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
    /*
     * The previous strike's numbers are not this strike's.
     *
     * Cleared the moment the strike changes, because the card's title changes
     * at once and the table did not: it went on showing 89,600 CE's figures
     * under "What changed · 83,800 PE" until the next read landed, which reads
     * as the screen lagging and is worse -- it is the wrong strike's record
     * under the right strike's name.
     */
    setRows(null);
    if (!symbol || !leg) return;
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
    <Panel name="What changed" title={`What changed${title ? ` · ${title}` : ''}`} right={<small className="ov-muted">the chosen strikes, 1m … 12h and since entry</small>}>
      {shown.length === 0 ? <p className="ov-empty">Choose a strike on the chain.</p> : shown.map((x) => <ChangesTable key={`${x.leg!.cp}${x.leg!.strike}`} leg={x.leg!} changes={x.changes} two={shown.length > 1} />)}
      <p className="ov-foot">Premium ↑ = 🔴 risk for a short, ↓ = 🟢 favourable. OI beside it: premium ↑ with OI ↑ is demand, premium ↓ with OI ↑ is writing into it, both ↓ is an unwind. Touch odds and distance by the option model then → now. A dash means no record that far back.</p>
    </Panel>
  );
}

function ChangesTable({ leg, changes, two }: { leg: Leg; changes: Changes | null; two: boolean }) {
  // Nothing read yet for this strike: said, rather than drawn as a table of dashes.
  if (!changes) {
    return (
      <>
        {two && <h4 className="ov-subhead"><span>{fmt.n(leg.strike)} {leg.cp === 'C' ? 'CE' : 'PE'}</span></h4>}
        <p className="ov-empty">Reading the record for {fmt.n(leg.strike)} {leg.cp === 'C' ? 'CE' : 'PE'}…</p>
      </>
    );
  }
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


// ---------------------------------------------------------- expiry direction

const plus = (score: number) => (score >= 0.6 ? '+++' : score >= 0.3 ? '++' : score > 0.05 ? '+' : score <= -0.6 ? '−−−' : score <= -0.3 ? '−−' : score < -0.05 ? '−' : '·');

/**
 * Expiry direction: from the price now, does this expiry settle above,
 * below, or near it? The option market's own distribution (spot × ATM IV ×
 * √T), its centre tilted by the state of the market -- the trace below
 * says by what -- with the measured record's own split beside it. Then the
 * expected settlement, the 80% range, and the odds of finishing past half
 * and one expected move each way, which is what a strike is chosen by.
 */
export function ExpiryDirectionPanel({ d, hoursLeftText }: { d: ExpiryDirection | null; hoursLeftText: string }) {
  if (!d) return <Panel title="Expiry direction"><p className="ov-empty">No ATM IV or no time left on this contract.</p></Panel>;
  const tone = d.bias === 'UP' ? 'up' : d.bias === 'DOWN' ? 'down' : 'accent';
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Panel title="Expiry direction" right={<span className="ov-chain-head"><Tag tone={tone}>{d.bias === 'UP' ? '↑ UP' : d.bias === 'DOWN' ? '↓ DOWN' : '↔ RANGE'}</Tag><Tag tone={d.confidence === 'HIGH' ? 'up' : d.confidence === 'MEDIUM' ? 'warn' : 'muted'}>{d.confidence} confidence</Tag></span>}>
      <div className="ov-dir-head">
        <div><span className="ov-kpi-label">BTC now</span><b className="ov-kpi-value">{fmt.n(d.spot, 1)}</b></div>
        <div><span className="ov-kpi-label">Expiry in</span><b className="ov-kpi-value">{hoursLeftText}</b></div>
      </div>
      <div className="ov-dir-odds">
        <div className="ov-dir-odd ov-up"><span>▲ ABOVE</span><b>{pct(d.pUp)}</b><small className="ov-muted" title="The measured record: how often settlement finished above the implied 1σ band from states like this one">{d.measured ? `measured above band ${pct(d.measured.above)}` : ''}</small></div>
        <div className="ov-dir-odd ov-down"><span>▼ BELOW</span><b>{pct(d.pDown)}</b><small className="ov-muted" title="The measured record: how often settlement finished below the implied 1σ band">{d.measured ? `measured below band ${pct(d.measured.below)}` : ''}</small></div>
        <div className="ov-dir-odd ov-muted"><span>↔ NEAR</span><b>{pct(d.pRange)}</b><small className="ov-muted" title="The measured record: how often settlement stayed inside the implied 1σ band">{d.measured ? `measured inside band ${pct(d.measured.inside)}` : ''}</small></div>
      </div>
      <div className="ov-two">
        <div>
          <Row label="Expected settlement" value={<b>{fmt.n(d.expectedExpiry)}</b>} hint={`Spot ${fmt.n(d.spot)} tilted ${fmt.signed(d.tiltUsd)} by the market's state (capped at ±0.35 EM)`} />
          <Row label="Expected move (1σ)" value={`±${fmt.n(d.em)}`} hint="spot × ATM IV × √(time to settlement ÷ 1 year) — a volatility range, not a forecast" />
          <Row label="80% range" value={`${fmt.n(d.range80.low)} – ${fmt.n(d.range80.high)}`} />
          {d.measured?.low != null && d.measured.high != null && <Row label="Measured 68% band" value={`${fmt.n(d.measured.low)} – ${fmt.n(d.measured.high)}`} hint={`Where settlement fell two thirds of the time from states like this one${d.measured.windows ? `, over ${fmt.n(d.measured.windows)} windows` : ''}`} />}
        </div>
        <div>
          {d.distance.map((x) => (
            <Row key={x.label} label={`P(${x.label}) · ${fmt.n(x.price)}`} value={pct(x.p)} tone={x.label.startsWith('>') ? 'up' : 'down'} hint="The odds settlement finishes past that distance; the number a short strike on that side is chosen by" />
          ))}
        </div>
      </div>
      <div className="ov-dir-why">
        <div className="ov-final-sub">Why</div>
        {d.why.map((w) => (
          <Row key={w.name} label={w.name} value={<span className={w.score > 0.05 ? 'ov-up' : w.score < -0.05 ? 'ov-down' : 'ov-muted'}>{plus(w.score)}</span>} hint={`${w.text} · weight ${Math.round(w.weight * 100)}%`} />
        ))}
      </div>
    </Panel>
  );
}
