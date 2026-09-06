import { useCallback, useEffect, useRef, useState } from 'react';
import { getChain, getExpiries, getHealth } from './api';
import type { ChainResponse, ExpiryOption } from './types';
import { ChainTable } from './components/ChainTable';
import { BiasPanel } from './components/BiasPanel';
import { PicksPanel } from './components/PicksPanel';
import { BacktestPanel } from './components/BacktestPanel';
import { FloorPanel } from './components/FloorPanel';
import { VerdictPanel } from './components/VerdictPanel';
import { DateTimePicker, istToEpoch, type IstMoment } from './components/DateTimePicker';
import { AccountPanel } from './components/AccountPanel';
import { Metric, Formula } from './components/Explain';

type Tab = 'desk' | 'backtest' | 'floors';

const REFRESH_SECONDS = 5;

/** Yesterday at the entry minute — a sensible historical default. */
function defaultPast(): IstMoment {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 - 86400_000);
  return { date: d.toISOString().slice(0, 10), time: '05:30' };
}

export default function App() {
  const [tab, setTab] = useState<Tab>('desk');
  const [live, setLive] = useState(true);
  const [when, setWhen] = useState<IstMoment>(defaultPast);
  const [expiry, setExpiry] = useState<string>('');
  const [expiries, setExpiries] = useState<ExpiryOption[]>([]);
  const [width, setWidth] = useState(10);
  const [minPremium, setMinPremium] = useState(15);
  const [hedgeGap, setHedgeGap] = useState(3);
  const [lots, setLots] = useState(10);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const [data, setData] = useState<ChainResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true);
    setErr(null);
    try {
      const at = live ? 'now' : new Date(istToEpoch(when) * 1000).toISOString();
      const r = await getChain(at, width, minPremium, hedgeGap, lots, expiry || undefined);
      // a slow earlier request must not overwrite a newer one
      if (my === seq.current) setData(r);
    } catch (e) {
      if (my === seq.current) {
        setErr((e as Error).message);
        setData(null);
      }
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, [live, when, width, minPremium, hedgeGap, lots, expiry]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { getHealth().then((h) => setDays(h.days)).catch(() => setDays(null)); }, []);
  useEffect(() => { getExpiries().then((r) => setExpiries(r.expiries)).catch(() => setExpiries([])); }, []);

  useEffect(() => {
    if (!autoRefresh || !live) return;
    const id = setInterval(() => { void load(); }, REFRESH_SECONDS * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, live, load]);

  const snap = data?.snapshot;

  return (
    <div className="app">
      <header className="top">
        <h1>BTC Options Desk</h1>
        <span className="sub">
          Delta Exchange India · public market data · no API key
          {days !== null && <> · {days} days of history</>}
        </span>
      </header>

      <div className="tabs">
        <button className={tab === 'desk' ? 'on' : ''} onClick={() => setTab('desk')}>Should I enter?</button>
        <button className={tab === 'backtest' ? 'on' : ''} onClick={() => setTab('backtest')}>Backtest</button>
        <button className={tab === 'floors' ? 'on' : ''} onClick={() => setTab('floors')}>How much premium?</button>
      </div>

      {tab === 'desk' ? (
        <>
          <div className="bar">
            <div className="field">
              <label>when</label>
              <select value={live ? 'live' : 'past'} onChange={(e) => setLive(e.target.value === 'live')}>
                <option value="live">live now</option>
                <option value="past">a past moment</option>
              </select>
            </div>

            {!live && (
              <div className="field">
                <label>date &amp; time (IST)</label>
                <DateTimePicker value={when} onChange={setWhen} maxDate={new Date()} />
              </div>
            )}

            <div className="field">
              <label>expiry</label>
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)} style={{ minWidth: 190 }}>
                <option value="">today · the daily contract</option>
                {expiries.map((e) => (
                  <option key={e.expiry} value={e.expiry}>
                    {e.iso} · {e.hoursAway < 48
                      ? `${e.hoursAway.toFixed(0)}h away`
                      : `${(e.hoursAway / 24).toFixed(0)} days away`}
                    {e.isDaily ? ' · daily' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>min premium $</label>
              <input type="number" value={minPremium} onChange={(e) => setMinPremium(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>lots</label>
              <input type="number" value={lots} onChange={(e) => setLots(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>hedge gap</label>
              <input type="number" value={hedgeGap} onChange={(e) => setHedgeGap(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>strikes each side</label>
              <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
            </div>

            <button className="go" onClick={() => void load()} disabled={busy}>
              {busy ? 'loading…' : 'Refresh'}
            </button>
            {live && (
              <button
                className="ghost"
                onClick={() => setAutoRefresh((v) => !v)}
                title={`Re-fetch the live chain every ${REFRESH_SECONDS} seconds`}
              >
                {autoRefresh
                  ? `⏱ auto-refreshing every ${REFRESH_SECONDS}s — click to stop`
                  : `⏱ auto-refresh every ${REFRESH_SECONDS}s: off`}
              </button>
            )}
          </div>

          {err && <div className="err">{err}</div>}
          {busy && !data && <div className="spinner">loading chain…</div>}

          {data && snap && (
            <>
              <VerdictPanel
                verdict={data.verdict}
                picks={data.picks}
                lots={lots}
                usdinr={data.usdinr}
              />

              <div className="grid cols-3" style={{ marginBottom: 16 }}>
                <div className="card">
                  <h2>
                    {snap.live ? 'Live' : 'Snapshot'} · expiry {snap.expiry}
                    {!snap.isDaily && <span className="tag warn">not the daily</span>}
                  </h2>
                  <div className="big">{snap.spot.toFixed(1)}</div>
                  <div className="kv"><span>as of</span>
                    <span>{new Date(snap.ts * 1000).toLocaleString()}</span></div>
                  <div className="kv"><span>to settlement</span>
                    <span>{snap.hoursToExpiry.toFixed(2)} h</span></div>
                  <div className="kv"><span>ATM strike</span><span>{snap.atm}</span></div>

                  <Metric
                    label="ATM IV"
                    value={snap.atmIv !== null ? (snap.atmIv * 100).toFixed(1) + '%' : '·'}
                  >
                    <p>
                      The volatility the market's own prices imply, quoted per year. We
                      take the at-the-money mark price and ask which volatility makes
                      Black-Scholes return exactly that price.
                    </p>
                    <p>
                      Short-dated options carry lower implied volatility than longer
                      ones, so this number on a same-day contract is not comparable to
                      the one you see on a monthly.
                    </p>
                  </Metric>

                  <Metric
                    label="expected move"
                    value={snap.expectedMove !== null ? '±$' + snap.expectedMove.toFixed(0) : '·'}
                  >
                    <p>How far the option market thinks BTC can travel before settlement.</p>
                    <Formula>
                      spot × ATM IV × √(hours ÷ 8760)
                      {snap.atmIv !== null && (
                        <>
                          <br />
                          {snap.spot.toFixed(0)} × {(snap.atmIv * 100).toFixed(1)}% × √({snap.hoursToExpiry.toFixed(2)} ÷ 8760)
                          <br />= ±${snap.expectedMove?.toFixed(0)}
                        </>
                      )}
                    </Formula>
                    <p>
                      8760 is hours in a year: implied volatility is quoted annually and
                      has to be scaled down to the time actually left.
                    </p>
                    <p>
                      It is one standard deviation — roughly a two-in-three chance BTC
                      settles inside ±${snap.expectedMove?.toFixed(0)}, and a one-in-three
                      chance it does not. A strike inside that band is not a safe strike.
                    </p>
                    <p className="dim">
                      Measured against two years of settlements, this is a floor rather
                      than a ceiling: every day that broke the strategy moved further
                      than the market had priced.
                    </p>
                  </Metric>

                  <Metric
                    label="move as % of spot"
                    value={snap.expectedMove !== null
                      ? ((snap.expectedMove / snap.spot) * 100).toFixed(2) + '%'
                      : '·'}
                  >
                    <p>
                      The same number as a percentage, which is the form worth
                      remembering: on the 733 days measured, a winning day moved 0.63%
                      and a losing day moved 2.25%.
                    </p>
                  </Metric>
                </div>
                <BiasPanel bias={data.bias} snap={snap} />
                <PicksPanel picks={data.picks} lots={lots} usdinr={data.usdinr} minPremium={minPremium} />
                <AccountPanel usdinr={data.usdinr} />
              </div>

              <ChainTable legs={data.legs} snap={snap} />
              <div className="note">
                Age is minutes since a real trade printed. Delta's candle feed
                forward-fills quiet minutes, so a traded price with a large age is a
                carry-forward, not a quote you can hit — the mark is the honest number
                there. Historical rows have no order book, so bid and ask are blank and
                the mark is used as the sell estimate.
              </div>
            </>
          )}
        </>
      ) : tab === 'backtest' ? (
        <BacktestPanel usdinr={data?.usdinr ?? 85} />
      ) : (
        <FloorPanel usdinr={data?.usdinr ?? 85} />
      )}
    </div>
  );
}
