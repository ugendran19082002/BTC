import { useEffect, useState } from 'react';
import type { ChainResponse, Leg } from '@/types/desk';
import { getChanges, type ChangeRow, type ModelNow, type PerpResponse, type PremiumMomentum } from '@/api/desk';
import { earlyWarning, type EarlyWarning } from '@/lib/overview';
import { Panel, Tag } from './parts';

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
