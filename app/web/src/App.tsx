import { useCallback, useEffect, useRef, useState } from 'react';
import { getChain, getExpiries, getHealth } from './api';
import type { ChainResponse, ExpiryOption } from './types';
import { ChainTable } from './components/ChainTable';
import { BiasPanel } from './components/BiasPanel';
import { BacktestPanel } from './components/BacktestPanel';
import { FloorPanel } from './components/FloorPanel';
import { VerdictPanel } from './components/VerdictPanel';
import { RecommendPanel } from './components/RecommendPanel';
import { DateTimePicker, istToEpoch, type IstMoment } from './components/DateTimePicker';
import { usePersisted } from './hooks/usePersisted';
import { AccountPanel } from './components/AccountPanel';
import { Metric, Formula, Field } from './components/Explain';

type Tab = 'desk' | 'backtest' | 'floors';

const REFRESH_SECONDS = 5;

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: true,
});

/**
 * Always India time, and always says so. The strategy is defined in IST, and a
 * timestamp rendered in the viewer's own zone quietly means something different
 * for every viewer.
 */
function istLabel(epochSeconds: number): string {
  return IST_FMT.format(new Date(epochSeconds * 1000)).replace(/,/g, '') + ' IST';
}

/** Yesterday at the entry minute — a sensible historical default. */
function defaultPast(): IstMoment {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 - 86400_000);
  return { date: d.toISOString().slice(0, 10), time: '05:30' };
}

export default function App() {
  const [tab, setTab] = usePersisted<Tab>('tab', 'desk');
  const [live, setLive] = usePersisted('live', true);
  const [when, setWhen] = useState<IstMoment>(defaultPast);
  // Remembered, but only honoured while that expiry is still listed -- a saved
  // contract that has since settled must not pin the desk to a dead chain.
  const [expiry, setExpiry, forgetExpiry] = usePersisted<string>('expiry', '');
  const [expiries, setExpiries] = useState<ExpiryOption[]>([]);
  const [width, setWidth] = usePersisted('width', 20);
  const [minPremium, setMinPremium] = usePersisted('minPremium', 15);
  const hedgeGap = 0;
  const [lots, setLots] = usePersisted('lots', 10);
  // On by default: a live chain that silently goes stale is worse than no chain.
  const [autoRefresh, setAutoRefresh] = usePersisted('autoRefresh', true);

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
  useEffect(() => {
    getExpiries()
      .then((r) => {
        setExpiries(r.expiries);
        const fallback = r.expiries.find((e) => e.isNextEntry)?.expiry ?? '';
        setExpiry((cur) => {
          // Keep a remembered choice only if that contract is still listed.
          if (cur && r.expiries.some((e) => e.expiry === cur)) return cur;
          return fallback;
        });
      })
      .catch(() => setExpiries([]));
  }, [setExpiry]);

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
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)} style={{ minWidth: 270 }}>
                {expiries.length === 0 && <option value="">loading…</option>}
                {expiries.map((e) => (
                  <option key={e.expiry} value={e.expiry}>
                    {istLabel(e.expiryTs)}
                    {' · '}
                    {e.hoursAway < 48
                      ? `in ${e.hoursAway.toFixed(0)}h`
                      : `in ${(e.hoursAway / 24).toFixed(0)} days`}
                    {e.isNextEntry
                      ? ' ★ the one you would sell'
                      : e.isDaily
                        ? ' · today’s, mostly spent'
                        : ' · not measured'}
                  </option>
                ))}
              </select>
              {expiries.length > 0 && !expiries.find((e) => e.expiry === expiry)?.isNextEntry && (
                <button className="pinned" onClick={forgetExpiry} title="back to the default">
                  pinned — reset
                </button>
              )}
            </div>

            <Field
              label="min premium $"
              help={
                <>
                  <p>
                    The least you are willing to be paid per BTC for taking the risk.
                    The desk then sells the <b>furthest</b> strike that still pays it —
                    the most distance the market will hand you at that price.
                  </p>
                  <p>
                    Asking for more walks the strike toward the money. Over 733 days:
                    $15 won 95.8% of the time with the strike 2.5% away; $50 won 83.8%
                    at 1.6% away; $100 lost money.
                  </p>
                </>
              }
            >
              <input type="number" value={minPremium} onChange={(e) => setMinPremium(Number(e.target.value))} />
            </Field>

            <Field
              label="lots"
              help={
                <>
                  <p>
                    One lot is 0.001 BTC and costs about $0.50 of margin, so ten lots
                    is 0.01 BTC and roughly $5 of margin.
                  </p>
                  <p>
                    Split them evenly between the two sides. Across 733 days the call
                    leg lost on 8 days and the put leg on 9, and the two <b>never lost
                    on the same day</b> — so an even split halved the worst day
                    (−$8.97 against −$18.11 all on one side) and more than doubled
                    return per unit of drawdown.
                  </p>
                </>
              }
            >
              <input type="number" value={lots} onChange={(e) => setLots(Number(e.target.value))} />
            </Field>

            <Field
              label="strikes each side"
              help={
                <p>
                  How much of the chain to fetch and display, counted in strikes above
                  and below the money. Display only — it does not change the trade,
                  though too small a window can hide the strike you want.
                </p>
              }
            >
              <input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} />
            </Field>

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
                    {snap.live ? 'Live' : 'Snapshot'}
                    {snap.isNextEntry
                      ? <span className="tag ok">next entry</span>
                      : <span className="tag warn">not the measured contract</span>}
                  </h2>
                  <div className="big">{snap.spot.toFixed(1)}</div>

                  <div className="metric">
                    <div className="metric-row">
                      <span className="metric-label">settles</span>
                      <span className="metric-value">{istLabel(snap.expiryTs)}</span>
                    </div>
                    <div className="metric-row">
                      <span className="metric-label dim">contract</span>
                      <span className="metric-value dim">
                        {snap.expiry}
                        {' · '}
                        {snap.hoursToExpiry < 48
                          ? `${snap.hoursToExpiry.toFixed(1)}h away`
                          : `${(snap.hoursToExpiry / 24).toFixed(0)} days away`}
                      </span>
                    </div>
                  </div>

                  <div className="metric">
                    <div className="metric-row">
                      <span className="metric-label">as of</span>
                      <span className="metric-value">{istLabel(snap.ts)}</span>
                    </div>
                  </div>

                  <div className="metric">
                    <div className="metric-row">
                      <span className="metric-label">ATM strike</span>
                      <span className="metric-value">{snap.atm.toLocaleString()}</span>
                    </div>
                  </div>

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
                <RecommendPanel rec={data.recommendation} market={data.market} minPremium={minPremium} />
                <BiasPanel bias={data.bias} snap={snap} />
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
