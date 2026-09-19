import type { ChainResponse, Leg } from '@/types/desk';
import {
  horizonRows, shockTable, type BothAssessment, type RiskEngine,
  type SideAssessment,
} from '@/lib/overview';
import { fmt, Panel, Row, Tag } from './parts';
import { entryTodayMs } from '@/lib/screen-config';

const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const IST_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const hm = (ms: number) => IST_HM.format(new Date(ms));

/** The desk's configured entry window, IST. The strategy sells at 05:30; the contract settles at 17:30. */
export const ENTRY_WINDOW_IST = '05:30';

/**
 * Entry → expiry, as the third reference screen lays it out. Entry is now --
 * the moment an order placed from this screen would fill -- and expiry is
 * the selected contract's own settlement, never typed in. The bar is how
 * much of the contract's day has gone.
 */
export function EntrySetupPanel({ data, now, entryIst = ENTRY_WINDOW_IST }: { data: ChainResponse; now: number; entryIst?: string }) {
  const snap = data.snapshot;
  const expiryMs = snap.expiryTs * 1000;
  const entryMs = snap.live ? now : snap.ts * 1000;
  const windowMs = entryTodayMs(entryIst, entryMs);
  const sinceWindow = windowMs === null ? null : entryMs - windowMs;
  const inWindow = sinceWindow !== null && sinceWindow >= 0 && sinceWindow <= 30 * 60_000;
  const leftMs = Math.max(0, expiryMs - entryMs);
  const h = Math.floor(leftMs / 3_600_000), m = Math.floor((leftMs % 3_600_000) / 60_000);
  // The contract's day runs from the previous settlement (24h before) to this one.
  const dayMs = 24 * 3_600_000;
  const elapsed = Math.min(1, Math.max(0, 1 - leftMs / dayMs));
  return (
    <Panel title="Entry → expiry setup" className="ov-setup">
      <div className="ov-setup-grid">
        <div className="ov-mini-card">
          <span className="ov-kpi-label">Entry time ({snap.live ? 'dynamic · now' : 'the snapshot'})</span>
          <b className="ov-kpi-value">{hm(entryMs)}</b>
          <span className={`ov-kpi-sub${inWindow ? ' ov-up' : ''}`}>window {entryIst} IST{sinceWindow === null ? '' : sinceWindow >= 0 ? ` · ${Math.floor(sinceWindow / 3_600_000)}h ${String(Math.floor((sinceWindow % 3_600_000) / 60_000)).padStart(2, '0')}m since` : ` · in ${Math.ceil(-sinceWindow / 60_000)}m`}{inWindow ? ' · in window' : ''}</span>
        </div>
        <span className="ov-setup-arrow" aria-hidden>→</span>
        <div className="ov-mini-card">
          <span className="ov-kpi-label">Expiry (fixed · from the contract)</span>
          <b className="ov-kpi-value">{IST_DATE.format(new Date(expiryMs))}</b>
          <span className="ov-kpi-sub">{hm(expiryMs)} IST · {snap.expiry}{snap.isDaily || snap.isNextEntry ? ' · daily' : ''}</span>
        </div>
        <div className="ov-mini-card">
          <span className="ov-kpi-label">Time to expiry</span>
          <b className="ov-kpi-value">{leftMs === 0 ? 'settled' : `${h}h ${String(m).padStart(2, '0')}m`}</b>
          <span className="ov-meter ov-meter-wide" aria-hidden><span style={{ width: `${elapsed * 100}%` }} /></span>
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------- horizons

/** Every horizon, 5m to 24h: the measured odds and the implied move. The expected-move engine, per timeframe. */
export function HorizonsPanel({ data, activeMin = 720 }: { data: ChainResponse; activeMin?: number }) {
  const rows = horizonRows(data.outlook);
  const measured = Boolean(data.outlook.model);
  return (
    <Panel title="Expected move by horizon" right={<Tag tone={measured ? 'up' : 'muted'}>{measured ? 'measured' : 'implied only'}</Tag>}>
      {rows.length === 0 ? <p className="ov-empty">No horizon readable.</p> : (
        <table className="ov-mini ov-horizons">
          <thead><tr><th>Horizon</th><th>Up</th><th>Down</th><th>Range</th><th>EM</th><th>Target range</th><th>Rich</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.minutes === activeMin ? 'ov-atm' : undefined} title={r.minutes === activeMin ? 'The prediction horizon' : undefined}>
                <td>{r.label}{r.minutes === activeMin ? ' ◆' : ''}</td>
                <td className="ov-up">{fmt.pct(r.pUp)}</td>
                <td className="ov-down">{fmt.pct(r.pDown)}</td>
                <td className="ov-muted">{fmt.pct(r.pRange)}</td>
                <td>{r.em === null ? '—' : `±${fmt.n(r.em)}`}</td>
                <td className="ov-muted">{r.low === null || r.high === null ? '—' : `${fmt.n(r.low)} – ${fmt.n(r.high)}`}</td>
                <td className={r.richness === null ? '' : r.richness >= 1 ? 'ov-up' : 'ov-down'}>{r.richness === null ? '—' : `${r.richness.toFixed(2)}×`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="ov-foot">Up / down / range are measured over the desk's history for each horizon; EM is spot × IV × √t. Rich: implied ÷ measured band.</p>
    </Panel>
  );
}

// ----------------------------------------------------------- risk engine

export function RiskEnginePanel({ leg, risk, contracts }: { leg: Leg | null; risk: RiskEngine | null; contracts: number }) {
  if (!leg || !risk) return <Panel title="Sell-side risk engine"><p className="ov-empty">Select a strike with a price.</p></Panel>;
  const side = leg.cp === 'C' ? 'CE' : 'PE';
  const usd = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`);
  return (
    <Panel title={`Sell-side risk engine · ${fmt.n(leg.strike)} ${side}`} right={<small className="ov-muted">{contracts} ct</small>}>
      <div className="ov-two">
        <div>
          <Row label="Intrinsic / extrinsic" value={`${fmt.n(risk.intrinsic, 1)} / ${fmt.n(risk.extrinsic, 1)}`} />
          <Row label="Theoretical (BS at mark IV)" value={fmt.n(risk.theoretical, 1)} />
          <Row label="Market premium richness" value={risk.marketRichness === null ? '—' : fmt.pct(risk.marketRichness, 1)}
            tone={risk.marketRichness === null ? undefined : risk.marketRichness >= 0 ? 'up' : 'down'} hint="Bid against mark: what the market actually pays a seller" />
          <Row label="Probability of touch" value={fmt.pct(risk.pTouch)} />
          <Row label="Theta / gamma" value={risk.thetaGammaRatio === null ? '—' : fmt.n(risk.thetaGammaRatio)} hint="Decay earned per unit of convexity risk; higher is calmer" />
          <Row label="Vega shock (+5 IV pts)" value={usd(risk.vegaShockUsd)} tone={risk.vegaShockUsd === null ? undefined : risk.vegaShockUsd >= 0 ? 'up' : 'down'} />
          <Row label="Gamma shock (1% adverse)" value={usd(risk.gammaShockUsd)} tone={risk.gammaShockUsd === null ? undefined : risk.gammaShockUsd >= 0 ? 'up' : 'down'} hint="Delta and gamma only, for the size" />
        </div>
        <div>
          <Row label="Tail loss (2×EM adverse)" value={risk.tailLossUsd === null ? '—' : `$${risk.tailLossUsd.toFixed(2)}`} tone="down" hint="The loss the desk plans for; a naked short has no bounded worst case" />
          <Row label="Break-even after fees" value={fmt.n(risk.breakevenAfterFees)} />
          <Row label="Slippage (half spread)" value={risk.slippageUsd === null ? '—' : `$${risk.slippageUsd.toFixed(2)}`} />
          <Row label="Margin yield" value={fmt.pct(risk.marginYield, 1)} hint="Credit after fees over the margin it ties up" />
          <Row label="Hedge cost" value={risk.hedge ? `${fmt.n(risk.hedge.strike)} ${side} ask ${fmt.n(risk.hedge.askUsd, 1)} · $${risk.hedge.costUsd.toFixed(2)}` : 'none listed'} />
          <Row label="Protection available" value={<Tag tone={risk.protectionAvailable ? 'up' : 'down'}>{risk.protectionAvailable ? 'yes' : 'no'}</Tag>} />
          <Row label="Premium decay (model)" value={<DecayCurve curve={risk.decayCurve} />} hint="Extrinsic left at each point to settlement: extrinsic × √(time left ÷ time now)" />
        </div>
      </div>
      <div className="ov-shocks" title="Delta and gamma for the BTC moves, vega for the IV moves; instantaneous, for the size, as the short sees it">
        {shockTable(leg, contracts).map((s) => (
          <span key={s.label} className={s.pnlUsd === null ? 'ov-muted' : s.pnlUsd >= 0 ? 'ov-up' : 'ov-down'}>
            <small>{s.label}</small>{s.pnlUsd === null ? '—' : fmt.signed(s.pnlUsd, 2)}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function DecayCurve({ curve }: { curve: RiskEngine['decayCurve'] }) {
  return (
    <span className="ov-decay">
      {curve.map((p) => <span key={p.hours}><small className="ov-muted">{p.hours.toFixed(1)}h</small> {p.extrinsic.toFixed(1)}</span>)}
    </span>
  );
}

// ------------------------------------------------- side cards (extended)

export function SideCardsRow({ sides, both, onSelect }: { sides: SideAssessment[]; both: BothAssessment; onSelect: (cp: 'C' | 'P', strike: number) => void }) {
  const tone = (s: SideAssessment['status']) => (s === 'SELL' ? 'up' : s === 'WATCH' ? 'warn' : 'muted');
  return (
    <div className="ov-decide">
      {sides.map((c) => (
        <button key={c.side} className={`ov-decide-card ${c.status === 'SELL' ? 'ov-preferred' : ''}`} disabled={!c.leg}
          onClick={() => c.leg && onSelect(c.leg.cp, c.leg.strike)}>
          <header>Short {c.side}{c.leg ? ` · ${fmt.n(c.leg.strike)}` : ''}</header>
          <Row label="Score" value={c.score === null ? '—' : `${c.score.toFixed(1)} / 10`} />
          <Row label="POP (OTM)" value={fmt.pct(c.pOtm)} />
          <Row label="P(touch)" value={fmt.pct(c.pTouch)} />
          <Row label="Distance / EM" value={c.emDistance === null ? '—' : `${c.emDistance.toFixed(2)}×`} tone={c.emDistance !== null && c.emDistance < 1 ? 'warn' : undefined} />
          <Row label="IV richness" value={c.ivRich ?? '—'} />
          <Row label="OI wall" value={c.wallStrike === null ? '—' : `${fmt.n(c.wallStrike)} · ${c.wallDistanceStrikes === null ? '' : `${c.wallDistanceStrikes >= 0 ? '+' : ''}${c.wallDistanceStrikes} strikes`}`}
            tone={c.wallDistanceStrikes === null ? undefined : c.wallDistanceStrikes >= 0 ? 'up' : 'down'} hint="Where the wall sits relative to the strike, in strikes; beyond is support" />
          <Row label="Gamma risk" value={c.gammaRisk ?? '—'} tone={c.gammaRisk === 'high' ? 'down' : c.gammaRisk === 'low' ? 'up' : undefined} />
          <Row label="Tail loss (2×EM)" value={c.tailLossUsd === null ? '—' : `$${c.tailLossUsd.toFixed(2)}`} tone="down" />
          <Row label="Expected P&L" value={c.expectedPnlUsd === null ? '—' : fmt.signed(c.expectedPnlUsd, 2)} tone={c.expectedPnlUsd === null ? undefined : c.expectedPnlUsd >= 0 ? 'up' : 'down'} />
          <Row label="Margin (est.)" value={c.marginUsd === null ? '—' : `$${c.marginUsd.toFixed(2)}`} />
          <Row label="Risk / reward" value={c.riskReward === null ? '—' : `${(c.riskReward * 100).toFixed(1)}¢ per $ of tail`} />
          {c.gates && (
            <ul className="ov-gates">
              {c.gates.map((g) => (
                <li key={g.name} className={g.ok === true ? 'ok' : g.ok === false ? 'bad' : 'unknown'} title={g.text}>
                  <span>{g.name}</span><b>{g.ok === true ? 'PASS' : g.ok === false ? 'FAIL' : '?'}</b>
                </li>
              ))}
            </ul>
          )}
          <footer><Tag tone={tone(c.status)}>{c.disabledBy ?? c.status}</Tag></footer>
        </button>
      ))}
      <div className="ov-decide-card">
        <header>Both sides</header>
        <Row label="Range probability" value={fmt.pct(both.rangeProbability)} />
        <Row label="CE safe" value={<Safe ok={both.ceSafe} />} />
        <Row label="PE safe" value={<Safe ok={both.peSafe} />} />
        <Row label="Net delta" value={both.netDelta === null ? '—' : fmt.signed(both.netDelta, 2)} />
        <Row label="Net gamma" value={both.netGamma === null ? '—' : `−${both.netGamma.toPrecision(2)}`} hint="Short both legs" />
        <Row label="Net theta" value={both.netTheta === null ? '—' : fmt.signed(-both.netTheta, 1)} hint="Per day, per BTC, as the short earns it" />
        <Row label="Net vega" value={both.netVega === null ? '—' : fmt.signed(-both.netVega, 1)} />
        <Row label="Combined tail loss" value={both.combinedTailLossUsd === null ? '—' : `$${both.combinedTailLossUsd.toFixed(2)}`} tone="down" />
        <Row label="Combined expected P&L" value={both.combinedExpectedPnlUsd === null ? '—' : fmt.signed(both.combinedExpectedPnlUsd, 2)} />
        <Row label="Margin (est.)" value={both.marginUsd === null ? '—' : `$${both.marginUsd.toFixed(2)}`} />
        <footer><Tag tone={both.status === 'BOTH' ? 'up' : both.status === 'SINGLE SIDE' ? 'warn' : 'muted'}>{both.status}</Tag></footer>
      </div>
    </div>
  );
}

function Safe({ ok }: { ok: boolean | null }) {
  return ok === null ? <span className="ov-muted">—</span> : <span className={ok ? 'ov-up' : 'ov-down'}>{ok ? '✓' : '✕'}</span>;
}
