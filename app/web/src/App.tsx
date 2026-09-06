import { useCallback, useEffect, useRef, useState } from 'react';
import { getChain, getHealth } from './api';
import type { ChainResponse } from './types';
import { ChainTable } from './components/ChainTable';
import { BiasPanel } from './components/BiasPanel';
import { PicksPanel } from './components/PicksPanel';
import { BacktestPanel } from './components/BacktestPanel';

type Tab = 'desk' | 'backtest';

/** `datetime-local` wants local wall time; the API speaks UTC. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('desk');
  const [live, setLive] = useState(true);
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() - 86400_000)));
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
      const at = live ? 'now' : new Date(when).toISOString();
      const r = await getChain(at, width, minPremium, hedgeGap);
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
  }, [live, when, width, minPremium, hedgeGap]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { getHealth().then((h) => setDays(h.days)).catch(() => setDays(null)); }, []);

  useEffect(() => {
    if (!autoRefresh || !live) return;
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, live, load]);

  const snap = data?.snapshot;

  return (
    <div className="app">
      <header className="top">
        <h1>BTC Options Desk</h1>
        <span className="sub">
          Delta Exchange India · public market data · no API key
          {days !== null && <> · {days} days harvested</>}
        </span>
      </header>

      <div className="tabs">
        <button className={tab === 'desk' ? 'on' : ''} onClick={() => setTab('desk')}>Chain &amp; entry</button>
        <button className={tab === 'backtest' ? 'on' : ''} onClick={() => setTab('backtest')}>Backtest</button>
      </div>

      {tab === 'desk' ? (
        <>
          <div className="bar">
            <div className="field">
              <label>when</label>
              <select value={live ? 'live' : 'past'} onChange={(e) => setLive(e.target.value === 'live')}>
                <option value="live">live now</option>
                <option value="past">a past minute</option>
              </select>
            </div>
            {!live && (
              <div className="field">
                <label>minute (your local time)</label>
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={{ minWidth: 200 }} />
              </div>
            )}
            <div className="field">
              <label>strikes each side</label>
              <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>min premium $</label>
              <input type="number" value={minPremium} onChange={(e) => setMinPremium(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>hedge gap</label>
              <input type="number" value={hedgeGap} onChange={(e) => setHedgeGap(Number(e.target.value))} />
            </div>
            <div className="field">
              <label>lots</label>
              <input type="number" value={lots} onChange={(e) => setLots(Number(e.target.value))} />
            </div>
            <button className="go" onClick={() => void load()} disabled={busy}>
              {busy ? 'loading…' : 'Refresh'}
            </button>
            {live && (
              <button className="ghost" onClick={() => setAutoRefresh((v) => !v)}>
                auto 30s: {autoRefresh ? 'on' : 'off'}
              </button>
            )}
          </div>

          {err && <div className="err">{err}</div>}
          {busy && !data && <div className="spinner">loading chain…</div>}

          {data && snap && (
            <>
              <div className="grid cols-3" style={{ marginBottom: 16 }}>
                <div className="card">
                  <h2>{snap.live ? 'Live' : 'Snapshot'} · expiry {snap.expiry}</h2>
                  <div className="big">{snap.spot.toFixed(1)}</div>
                  <div className="kv"><span>as of</span>
                    <span>{new Date(snap.ts * 1000).toLocaleString()}</span></div>
                  <div className="kv"><span>to expiry</span>
                    <span>{snap.hoursToExpiry.toFixed(2)} h</span></div>
                  <div className="kv"><span>ATM strike</span><span>{snap.atm}</span></div>
                  <div className="kv"><span>ATM IV</span>
                    <span>{snap.atmIv !== null ? (snap.atmIv * 100).toFixed(1) + '%' : '·'}</span></div>
                  <div className="kv"><span>expected move</span>
                    <span>{snap.expectedMove !== null ? '±$' + snap.expectedMove.toFixed(0) : '·'}</span></div>
                </div>
                <BiasPanel bias={data.bias} snap={snap} />
                <PicksPanel picks={data.picks} lots={lots} usdinr={data.usdinr} minPremium={minPremium} />
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
      ) : (
        <BacktestPanel usdinr={data?.usdinr ?? 85} />
      )}
    </div>
  );
}
