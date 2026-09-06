import { useState } from 'react';
import { runBacktest, runByYear } from '../api';
import type { BacktestResponse, ByYearResponse, Params } from '../types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const PRESETS: { name: string; ce: Params['ce']; pe: Params['pe'] }[] = [
  { name: "A · CE 0-15 + PE 0-15", ce: { min: 0, max: 15 }, pe: { min: 0, max: 15 } },
  { name: "B · CE 0-15 + PE 15-30", ce: { min: 0, max: 15 }, pe: { min: 15, max: 30 } },
  { name: "C · CE 0-15 + PE 15-40", ce: { min: 0, max: 15 }, pe: { min: 15, max: 40 } },
  { name: "D' · CE 0-20 + PE 0-20", ce: { min: 0, max: 20 }, pe: { min: 0, max: 20 } },
  { name: "≥$15 both sides", ce: { min: 15, max: 60 }, pe: { min: 15, max: 60 } },
];

const money = (v: number) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2);
const inr = (v: number) => (v >= 0 ? '+' : '−') + '₹' + Math.abs(v).toFixed(0);

export function BacktestPanel({ usdinr }: { usdinr: number }) {
  const [p, setP] = useState<Params>({
    ce: { min: 0, max: 15 },
    pe: { min: 0, max: 15 },
    priceSource: 'mark',
    maxAgeMin: 30,
    pick: 'highest',
    lots: 10,
    slippage: 0.05,
    skipWeekdays: [],
    hedgeGap: 0,
  });
  const [res, setRes] = useState<BacktestResponse | null>(null);
  const [years, setYears] = useState<ByYearResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const band = (side: 'ce' | 'pe', field: 'min' | 'max', v: string) =>
    setP((s) => ({ ...s, [side]: { ...(s[side] ?? { min: 0, max: 15 }), [field]: Number(v) } }));

  const toggleDay = (d: number) =>
    setP((s) => ({
      ...s,
      skipWeekdays: s.skipWeekdays.includes(d)
        ? s.skipWeekdays.filter((x) => x !== d)
        : [...s.skipWeekdays, d],
    }));

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const [r, y] = await Promise.all([runBacktest(p), runByYear(p)]);
      setRes(r);
      setYears(y);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = res?.summary;

  return (
    <>
      <div className="bar">
        <div className="field">
          <label>preset</label>
          <select
            onChange={(e) => {
              const q = PRESETS[Number(e.target.value)];
              if (q) setP((v) => ({ ...v, ce: q.ce, pe: q.pe }));
            }}
            defaultValue=""
          >
            <option value="" disabled>choose…</option>
            {PRESETS.map((q, i) => <option key={q.name} value={i}>{q.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>CE band $</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <input type="number" style={{ width: 62, minWidth: 0 }} value={p.ce?.min ?? 0}
              onChange={(e) => band('ce', 'min', e.target.value)} />
            <input type="number" style={{ width: 62, minWidth: 0 }} value={p.ce?.max ?? 0}
              onChange={(e) => band('ce', 'max', e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>PE band $</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <input type="number" style={{ width: 62, minWidth: 0 }} value={p.pe?.min ?? 0}
              onChange={(e) => band('pe', 'min', e.target.value)} />
            <input type="number" style={{ width: 62, minWidth: 0 }} value={p.pe?.max ?? 0}
              onChange={(e) => band('pe', 'max', e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>entry price</label>
          <select value={p.priceSource}
            onChange={(e) => setP((v) => ({ ...v, priceSource: e.target.value as 'ltp' | 'mark' }))}>
            <option value="mark">mark</option>
            <option value="ltp">traded (LTP)</option>
          </select>
        </div>
        <div className="field">
          <label>max LTP age</label>
          <input type="number" value={p.maxAgeMin}
            onChange={(e) => setP((v) => ({ ...v, maxAgeMin: Number(e.target.value) }))} />
        </div>
        <div className="field">
          <label>lots</label>
          <input type="number" value={p.lots}
            onChange={(e) => setP((v) => ({ ...v, lots: Number(e.target.value) }))} />
        </div>
        <div className="field">
          <label>slippage</label>
          <input type="number" step="0.01" value={p.slippage}
            onChange={(e) => setP((v) => ({ ...v, slippage: Number(e.target.value) }))} />
        </div>
        <div className="field">
          <label>hedge gap</label>
          <input type="number" value={p.hedgeGap}
            onChange={(e) => setP((v) => ({ ...v, hedgeGap: Number(e.target.value) }))} />
        </div>
        <div className="field">
          <label>skip days</label>
          <div style={{ display: 'flex', gap: 3 }}>
            {DAY_NAMES.map((d, i) => (
              <button key={d} type="button"
                className={p.skipWeekdays.includes(i) ? 'go' : 'ghost'}
                style={{ padding: '5px 7px', fontSize: 11 }}
                onClick={() => toggleDay(i)}>{d}</button>
            ))}
          </div>
        </div>
        <button className="go" onClick={go} disabled={busy}>{busy ? 'running…' : 'Run'}</button>
      </div>

      {err && <div className="err">{err}</div>}

      {s && (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <div className="card">
              <h2>Result · {s.days} days</h2>
              <div className={`big ${s.totalUsd >= 0 ? 'up' : 'down'}`}>{money(s.totalUsd)}</div>
              <div className="kv"><span>in rupees</span><span>{inr(s.totalInr)}</span></div>
              <div className="kv"><span>per day</span><span>{money(s.avgUsd)}</span></div>
              <div className="kv"><span>win rate</span><span>{s.winPct.toFixed(1)}% ({s.wins}/{s.days})</span></div>
            </div>
            <div className="card">
              <h2>Risk</h2>
              <div className="big down">{money(s.worstDayUsd)}</div>
              <div className="kv"><span>worst day</span><span>{s.worstDate ?? '·'}</span></div>
              <div className="kv"><span>max drawdown</span><span className="down">−${s.maxDrawdownUsd.toFixed(2)}</span></div>
              <div className="kv"><span>return / drawdown</span>
                <span>{Number.isFinite(s.returnOverMdd) ? s.returnOverMdd.toFixed(2) : '∞'}</span></div>
              <div className="kv"><span>profit factor</span>
                <span>{Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}</span></div>
            </div>
            <div className="card">
              <h2>Year by year</h2>
              {years?.years.map((y) => (
                <div className="kv" key={y.year}>
                  <span>{y.year} <span className="dim">{y.days}d</span></span>
                  <span className={y.totalUsd >= 0 ? 'up' : 'down'}>
                    {money(y.totalUsd)} <span className="dim">{y.winPct.toFixed(0)}%</span>
                  </span>
                </div>
              ))}
              <div className="note">
                A rule that only works in one of these years has not been shown to work.
              </div>
            </div>
          </div>

          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th className="left">Date</th><th>Day</th><th>Spot</th><th>Settle</th>
                  <th>CE</th><th>entry</th><th>exit</th>
                  <th>PE</th><th>entry</th><th>exit</th>
                  <th>P&amp;L $</th><th>P&amp;L ₹</th><th>cum $</th>
                </tr>
              </thead>
              <tbody>
                {res.trades.map((t) => {
                  const ce = t.legs.find((l) => l.side === 'CE');
                  const pe = t.legs.find((l) => l.side === 'PE');
                  return (
                    <tr key={t.date}>
                      <td className="left">{t.date}</td>
                      <td className="muted">{DAY_NAMES[t.weekday]}</td>
                      <td>{t.spot.toFixed(0)}</td>
                      <td>{t.settle.toFixed(0)}</td>
                      <td className="ce">{ce?.strike ?? '·'}</td>
                      <td>{ce ? ce.entry.toFixed(2) : '·'}</td>
                      <td>{ce ? ce.exit.toFixed(2) : '·'}</td>
                      <td className="pe">{pe?.strike ?? '·'}</td>
                      <td>{pe ? pe.entry.toFixed(2) : '·'}</td>
                      <td>{pe ? pe.exit.toFixed(2) : '·'}</td>
                      <td className={t.pnlUsd >= 0 ? 'up' : 'down'}>{t.pnlUsd.toFixed(3)}</td>
                      <td className={t.pnlUsd >= 0 ? 'up' : 'down'}>{(t.pnlUsd * usdinr).toFixed(0)}</td>
                      <td className="muted">{t.cum.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {res.truncated && (
            <div className="note">
              Showing the most recent {res.trades.length} of {res.totalDays} days.
            </div>
          )}
          <div className="note">
            Entry is taken at 05:30 IST and every position is held to the 12:00 UTC
            settlement, so the exit is the option's intrinsic value at settlement —
            exact, with no exit-quote guesswork. Slippage is applied to the entry
            credit only, because a cash settlement has no spread to cross.
          </div>
        </>
      )}
    </>
  );
}
