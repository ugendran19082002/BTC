import { useEffect, useState } from 'react';
import { runFloors } from '../api';
import type { FloorRow } from '../types';

const money = (v: number) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2);

/**
 * Answers "how much premium should I insist on?" by sweeping the floor and
 * showing what each one costs in win rate and in distance from the money.
 */
export function FloorPanel({ usdinr }: { usdinr: number }) {
  const [rows, setRows] = useState<FloorRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [skipSat, setSkipSat] = useState(false);
  const [lots, setLots] = useState(10);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setErr(null);
    runFloors({ lots, slippage: 0.05, priceSource: 'mark', skipWeekdays: skipSat ? [6] : [] })
      .then((r) => { if (!cancelled) setRows(r.rows); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [skipSat, lots]);

  const best = rows?.reduce((a, b) => (b.summary.totalUsd > a.summary.totalUsd ? b : a));

  return (
    <>
      <div className="bar">
        <div className="field">
          <label>lots</label>
          <input type="number" value={lots} onChange={(e) => setLots(Number(e.target.value))} />
        </div>
        <div className="field">
          <label>Saturday</label>
          <button className={skipSat ? 'go' : 'ghost'} style={{ padding: '6px 12px' }}
            onClick={() => setSkipSat((v) => !v)}>
            {skipSat ? 'skipped' : 'traded'}
          </button>
        </div>
        {busy && <span className="muted" style={{ alignSelf: 'center' }}>running…</span>}
      </div>

      {err && <div className="err">{err}</div>}

      {rows && (
        <>
          <div className="scroll" style={{ maxHeight: 'none' }}>
            <table>
              <thead>
                <tr>
                  <th className="left">Min premium</th>
                  <th>Days</th><th>Win %</th><th>Total $</th><th>Total ₹</th>
                  <th>Profit factor</th><th>Worst day</th><th>Max drawdown</th>
                  <th>Strike distance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.floor} className={r.floor === best?.floor ? 'atm' : undefined}>
                    <td className="left">${r.floor}</td>
                    <td>{r.summary.days}</td>
                    <td className={r.summary.winPct >= 95 ? 'up' : r.summary.winPct >= 90 ? '' : 'warn'}>
                      {r.summary.winPct.toFixed(1)}%
                    </td>
                    <td className={r.summary.totalUsd >= 0 ? 'up' : 'down'}>{money(r.summary.totalUsd)}</td>
                    <td className={r.summary.totalUsd >= 0 ? 'up' : 'down'}>
                      {(r.summary.totalUsd * usdinr).toFixed(0)}
                    </td>
                    <td>{Number.isFinite(r.summary.profitFactor) ? r.summary.profitFactor.toFixed(2) : '∞'}</td>
                    <td className="down">{r.summary.worstDayUsd.toFixed(2)}</td>
                    <td className="down">−{r.summary.maxDrawdownUsd.toFixed(2)}</td>
                    <td>{r.medianOtmPct !== null ? r.medianOtmPct.toFixed(2) + '%' : '·'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="note">
            For each floor, both legs are sold at the furthest out-of-the-money strike
            that still pays at least that much — the most distance the market will give
            you at that price. The last column is how far that strike sat from spot.
            <br /><br />
            Notice what the floor buys and what it costs: asking for more premium walks
            the strike toward the money, and the win rate falls with it. No floor reaches
            100%. The remaining losses are the days BTC travelled further in twelve hours
            than the strike was away — and no choice of strike removes those, it only
            changes how often they happen and how much they take.
          </div>
        </>
      )}
    </>
  );
}
