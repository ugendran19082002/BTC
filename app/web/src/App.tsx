import { useCallback, useEffect, useRef, useState } from 'react';
import { getAccount, getChain, getExpiries, getHealth } from './api';
import type { ChainResponse, ExpiryOption } from './types';
import { ChainTable } from './components/ChainTable';
import { BiasPanel } from './components/BiasPanel';
import { BacktestPanel } from './components/BacktestPanel';
import { FloorPanel } from './components/FloorPanel';
import { VerdictPanel } from './components/VerdictPanel';
import { RecommendPanel } from './components/RecommendPanel';
import { MovePanel } from './components/MovePanel';
import { StructurePanel } from './components/StructurePanel';
import { ForecastPanel } from './components/ForecastPanel';
import { DateTimePicker, istToEpoch, type IstMoment } from './components/DateTimePicker';
import { usePersisted } from './hooks/usePersisted';
import { Select } from './components/ui/select';
import { Card, CardTitle, CardLead } from './components/ui/card';
import { Stat, StatDivider } from './components/ui/stat';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
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
  const [hedgeGap, setHedgeGap] = usePersisted('hedgeGap', 0);
  const [requireHedge, setRequireHedge] = usePersisted('requireHedge', false);
  const [lots, setLots] = usePersisted('lots', 10);
  // On by default: a live chain that silently goes stale is worse than no chain.
  const [autoRefresh, setAutoRefresh] = usePersisted('autoRefresh', true);

  const [data, setData] = useState<ChainResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [accountLinked, setAccountLinked] = useState<boolean | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true);
    setErr(null);
    try {
      const at = live ? 'now' : new Date(istToEpoch(when) * 1000).toISOString();
      const r = await getChain(at, width, minPremium, hedgeGap, lots, expiry || undefined, requireHedge);
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
  }, [live, when, width, minPremium, hedgeGap, lots, expiry, requireHedge]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { getHealth().then((h) => setDays(h.days)).catch(() => setDays(null)); }, []);
  useEffect(() => {
    getAccount().then((a) => setAccountLinked(a.configured)).catch(() => setAccountLinked(null));
  }, []);
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
          Delta Exchange India · prices are public, no key needed
          {days !== null && <> · {days} days of history</>}
          {accountLinked === true && <> · account linked, read-only</>}
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
              <Select value={live ? 'live' : 'past'} onChange={(e) => setLive(e.target.value === 'live')}>
                <option value="live">live now</option>
                <option value="past">a past moment</option>
              </Select>
            </div>

            {!live && (
              <div className="field">
                <label>date &amp; time (IST)</label>
                <DateTimePicker value={when} onChange={setWhen} maxDate={new Date()} />
              </div>
            )}

            <div className="field">
              <label>expiry</label>
              <Select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="min-w-[260px]">
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
              </Select>
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
              label="hedge gap"
              help={
                <>
                  <p>
                    How many strikes past the one you sell to <b>buy</b> protection.
                    Strikes are $200 apart, so a gap of 3 is $600, and the worst case
                    becomes 600 minus the net credit.
                  </p>
                  <p>
                    Set 0 for none. The measured strategy is naked: at these distances
                    Delta lists nothing to buy on roughly three days in four, and where
                    it does the hedge often costs almost as much as the premium.
                  </p>
                </>
              }
            >
              <input type="number" value={hedgeGap} onChange={(e) => setHedgeGap(Number(e.target.value))} />
              {hedgeGap > 0 && (
                <button
                  className={requireHedge ? 'pinned' : 'pinned off'}
                  onClick={() => setRequireHedge((v) => !v)}
                  title="refuse the trade when no hedge is listed"
                >
                  {requireHedge ? 'blocking without hedge' : 'allow naked'}
                </button>
              )}
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

            <div className="actions">
              <Button onClick={() => void load()} disabled={busy}>
                {busy ? 'loading…' : 'Refresh'}
              </Button>
              {live && (
                <Button
                  variant={autoRefresh ? 'default' : 'outline'}
                  onClick={() => setAutoRefresh((v) => !v)}
                  title={`Re-fetch the live chain every ${REFRESH_SECONDS} seconds`}
                >
                  {autoRefresh ? `auto ${REFRESH_SECONDS}s · on` : `auto ${REFRESH_SECONDS}s · off`}
                </Button>
              )}
            </div>
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

              <div className="lead-row">
                <Card>
                  <CardTitle
                    right={
                      snap.isNextEntry
                        ? <Badge tone="ok">next entry</Badge>
                        : <Badge tone="warn">not the tested contract</Badge>
                    }
                  >
                    {snap.live ? 'Live' : 'Snapshot'}
                  </CardTitle>

                  <CardLead>{snap.spot.toFixed(1)}</CardLead>

                  <div className="mt-2">
                    <Stat label="settles" value={istLabel(snap.expiryTs)} />
                    <Stat
                      label="contract"
                      value={`${snap.expiry} · ${
                        snap.hoursToExpiry < 48
                          ? `${snap.hoursToExpiry.toFixed(1)}h away`
                          : `${(snap.hoursToExpiry / 24).toFixed(0)} days away`
                      }`}
                      tone="dim"
                    />
                    <Stat label="as of" value={istLabel(snap.ts)} tone="dim" />
                    <StatDivider />
                    <Stat label="at-the-money strike" value={snap.atm.toLocaleString()} />
                  </div>

                  <Metric
                    label="how jumpy the market expects it to be"
                    value={snap.atmIv !== null ? (snap.atmIv * 100).toFixed(1) + '%' : '—'}
                  >
                    <p>
                      Implied volatility: the volatility that makes the maths agree with
                      the price people are actually paying. Quoted per year.
                    </p>
                    <p>
                      Same-day options carry a lower number than monthly ones, so do not
                      compare this with what you see on a longer contract.
                    </p>
                  </Metric>

                  <Metric
                    label="how far it could move by settlement"
                    value={snap.expectedMove !== null ? '±$' + snap.expectedMove.toFixed(0) : '—'}
                  >
                    <p>How far the market thinks BTC can travel before this contract ends.</p>
                    <Formula>
                      spot × volatility × √(hours ÷ 8760)
                      {snap.atmIv !== null && (
                        <>
                          <br />
                          {snap.spot.toFixed(0)} × {(snap.atmIv * 100).toFixed(1)}% × √({snap.hoursToExpiry.toFixed(2)} ÷ 8760)
                          <br />= ±${snap.expectedMove?.toFixed(0)}
                        </>
                      )}
                    </Formula>
                    <p>
                      8760 is hours in a year. Volatility is quoted yearly, so it has to
                      be scaled down to the time actually left.
                    </p>
                    <p>
                      Roughly a 2-in-3 chance it settles inside this range, 1-in-3 that
                      it does not. A strike inside the range is not a safe strike.
                    </p>
                    <p className="dim">
                      Across 733 days this was a floor, not a ceiling. Every day that
                      broke the strategy moved further than the market had priced.
                    </p>
                  </Metric>

                  <Metric
                    label="that as a percentage"
                    value={snap.expectedMove !== null
                      ? ((snap.expectedMove / snap.spot) * 100).toFixed(2) + '%'
                      : '—'}
                  >
                    <p>
                      Worth remembering in this form: over 733 days a winning day moved
                      0.63% and a losing day moved 2.25%.
                    </p>
                  </Metric>

                  {snap.expectedMoveAtEntry !== null && snap.hoursToExpiry > 14 && (
                    <Metric
                      label="over the 12h you would actually hold"
                      value={'±$' + snap.expectedMoveAtEntry.toFixed(0)}
                    >
                      <p>
                        The figure above covers all {snap.hoursToExpiry.toFixed(1)} hours
                        left on this contract. You would not hold it that long — you
                        enter at 05:30 and it settles at 17:30 the same day, about twelve
                        hours.
                      </p>
                      <Formula>
                        {snap.spot.toFixed(0)} × {snap.atmIv !== null ? (snap.atmIv * 100).toFixed(1) : '—'}% × √(12 ÷ 8760)
                        <br />= ±${snap.expectedMoveAtEntry.toFixed(0)}
                      </Formula>
                      <p>
                        This is the one to judge a strike against. It assumes today's
                        volatility still holds tomorrow morning, which it may not.
                      </p>
                    </Metric>
                  )}
                </Card>

                <RecommendPanel rec={data.recommendation} market={data.market} minPremium={minPremium} usdinr={data.usdinr} />
                <StructurePanel structure={data.structure} snap={snap} />
              </div>

              {data.forecast && (
                <div className="wide-row">
                  <ForecastPanel forecast={data.forecast} sides={data.recommendation.sides} />
                </div>
              )}

              <div className="masonry">
                {data.market && <MovePanel market={data.market} snap={snap} />}
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
