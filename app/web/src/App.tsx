import { useCallback, useEffect, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { getChain, getExpiries, getHealth, getMe, logout, NotSignedIn } from './api';
import type { ChainResponse, ExpiryOption } from './types';
import { ChainTable } from './components/ChainTable';
import { MoveSection } from './components/MoveSection';
import { BiasSection } from './components/BiasSection';
import { BacktestPanel } from './components/BacktestPanel';
import { FloorPanel } from './components/FloorPanel';
import { VerdictPanel } from './components/VerdictPanel';
import { RecommendPanel } from './components/RecommendPanel';
import { DateTimePicker, istToEpoch, type IstMoment } from './components/DateTimePicker';
import { usePersisted } from './hooks/usePersisted';
import { LoginPage } from './components/LoginPage';
import { LivePrice } from './components/LivePrice';
import { Select, SelectItem } from './components/ui/select';
import { CardLead } from './components/ui/card';
import { CollapsibleCard } from './components/ui/collapsible-card';
import { Stat, StatDivider } from './components/ui/stat';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { AccountSection } from './components/AccountSection';
import { Metric, Formula, Field } from './components/Explain';

type Tab = 'desk' | 'backtest' | 'floors';

const REFRESH_SECONDS = 5;
// The expiry list changes once a day, at settlement. A minute is often enough
// to catch that without asking the server for a list that rarely moves.
const EXPIRY_RECHECK_SECONDS = 60;

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
  // Off by default on a desktop: the extra columns are why the table is worth
  // looking at. On a phone the media query hides them regardless.
  const [density, setDensity] = usePersisted<'default' | 'all'>('chain:density', 'default');
  const [settingsOpen, setSettingsOpen] = usePersisted<boolean>('open:settings', true);
  const [minPremium, setMinPremium] = usePersisted('minPremium', 15);
  const [mode, setMode] = usePersisted<'premium' | 'safety'>('mode', 'premium');
  const [safetyBar, setSafetyBar] = usePersisted('safetyBar', 98);
  const [hedgeGap, setHedgeGap] = usePersisted('hedgeGap', 0);
  const [requireHedge, setRequireHedge] = usePersisted('requireHedge', false);
  const [lots, setLots] = usePersisted('lots', 10);
  // On by default: a live chain that silently goes stale is worse than no chain.
  const [autoRefresh, setAutoRefresh] = usePersisted('autoRefresh', true);

  const [data, setData] = useState<ChainResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [days, setDays] = useState<number | null>(null);
  // null while we are still asking the server whether a login is required
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true);
    setErr(null);
    try {
      const at = live ? 'now' : new Date(istToEpoch(when) * 1000).toISOString();
      const r = await getChain(at, width, minPremium, hedgeGap, lots, expiry || undefined, requireHedge, mode, safetyBar / 100);
      // a slow earlier request must not overwrite a newer one
      if (my === seq.current) setData(r);
    } catch (e) {
      if (my === seq.current) {
        if (e instanceof NotSignedIn) {
          setSignedIn(false);
          setErr(null);
        } else {
          setErr((e as Error).message);
        }
        setData(null);
      }
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, [live, when, width, minPremium, hedgeGap, lots, expiry, requireHedge, mode, safetyBar]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    getMe()
      .then((m) => setSignedIn(!m.required || m.signedIn))
      .catch(() => setSignedIn(true)); // an older server without login: let it through
  }, []);

  useEffect(() => { getHealth().then((h) => setDays(h.days)).catch(() => setDays(null)); }, []);
  /**
   * The list of expiries, re-read on a timer rather than once at load.
   *
   * The server already drops a contract the moment it settles. Reading that
   * list only on mount meant a page left open overnight still offered a
   * contract that had expired hours earlier, and a remembered pin on it
   * outlived the thing it pointed at. A pin is for looking at another expiry
   * now, not forever: when the contract it names is gone, so is the pin, and
   * the selection falls back to the one the next 05:30 entry would sell.
   */
  const loadExpiries = useCallback(() => {
    getExpiries()
      .then((r) => {
        setExpiries(r.expiries);
        const fallback = r.expiries.find((e) => e.isNextEntry)?.expiry ?? '';
        setExpiry((cur) => (cur && r.expiries.some((e) => e.expiry === cur) ? cur : fallback));
      })
      .catch(() => setExpiries([]));
  }, [setExpiry]);

  useEffect(() => {
    loadExpiries();
    const id = setInterval(loadExpiries, EXPIRY_RECHECK_SECONDS * 1000);
    return () => clearInterval(id);
  }, [loadExpiries]);

  useEffect(() => {
    if (!autoRefresh || !live) return;
    const id = setInterval(() => { void load(); }, REFRESH_SECONDS * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, live, load]);

  const snap = data?.snapshot;

  if (signedIn === null) return <div className="spinner">…</div>;
  if (!signedIn) return <LoginPage onSignedIn={() => setSignedIn(true)} />;

  return (
    <div className="app">
      <header className="top">
        <h1>BTC Options Desk</h1>
        {snap && <LivePrice spot={snap.spot} live={snap.live} />}
        <span className="sub">
          Delta Exchange India · prices are public
          {days !== null && <> · {days} days of history</>}
        </span>
        <button
          className="ghost"
          style={{ marginLeft: 'auto' }}
          onClick={() => { void logout().then(() => setSignedIn(false)); }}
        >
          sign out
        </button>
      </header>

      <div className="tabs">
        <button className={tab === 'desk' ? 'on' : ''} onClick={() => setTab('desk')}>Should I enter?</button>
        <button className={tab === 'backtest' ? 'on' : ''} onClick={() => setTab('backtest')}>Backtest</button>
        <button className={tab === 'floors' ? 'on' : ''} onClick={() => setTab('floors')}>How much premium?</button>
      </div>

      {tab === 'desk' ? (
        <>
          {/*
            The settings fold like everything else. Eight controls above the
            answer is a lot of screen on a phone, and most days none of them
            change -- but folded away they must still be readable, or you cannot
            tell what the numbers below were computed from. Hence the summary.
          */}
          <Collapsible.Root open={settingsOpen} onOpenChange={setSettingsOpen} className="bar-wrap">
            <Collapsible.Trigger className="bar-toggle">
              <ChevronDown className={`h-3 w-3 flex-none transition-transform ${settingsOpen ? '' : '-rotate-90'}`} />
              <span>settings</span>
              {!settingsOpen && (
                <span className="bar-summary">
                  {live ? 'live' : 'past'} · {mode === 'safety' ? `safest ≥ ${safetyBar}%` : 'most premium'}
                  {' · '}≥ ${minPremium} · {lots} lots · {width} each side
                  {hedgeGap > 0 && ` · hedge ${hedgeGap}`}
                </span>
              )}
            </Collapsible.Trigger>
            <Collapsible.Content>
          <div className="bar">
            <div className="field">
              <label>when</label>
              <Select
                ariaLabel="when"
                value={live ? 'live' : 'past'}
                onValueChange={(v) => setLive(v === 'live')}
              >
                <SelectItem value="live">live now</SelectItem>
                <SelectItem value="past">a past moment</SelectItem>
              </Select>
            </div>

            {!live && (
              <div className="field wide">
                <label>date &amp; time (IST)</label>
                <DateTimePicker value={when} onChange={setWhen} maxDate={new Date()} />
              </div>
            )}

            <div className="field wide">
              <label>expiry</label>
              {/*
                The row label is the date and how long is left -- nothing else.
                What kind of contract it is used to ride along on the same line
                and made every row too long to read on a phone; it is a hint
                under the label now, and the one you would actually sell is
                marked with a star rather than described.
              */}
              <Select ariaLabel="expiry" value={expiry} onValueChange={setExpiry}>
                {expiries.length === 0 && <SelectItem value="" disabled>loading…</SelectItem>}
                {expiries.map((e) => (
                  <SelectItem
                    key={e.expiry}
                    value={e.expiry}
                    hint={
                      e.isNextEntry
                        ? 'the one you would sell'
                        : e.isDaily
                          ? 'today’s, mostly spent'
                          : 'not measured'
                    }
                  >
                    {e.isNextEntry && '★ '}
                    {istLabel(e.expiryTs)}
                    {' · '}
                    {e.hoursAway < 48
                      ? `in ${e.hoursAway.toFixed(0)}h`
                      : `in ${(e.hoursAway / 24).toFixed(0)} days`}
                  </SelectItem>
                ))}
              </Select>
              {expiries.length > 0 && !expiries.find((e) => e.expiry === expiry)?.isNextEntry && (
                <button className="pinned" onClick={forgetExpiry} title="back to the default">
                  pinned — reset
                </button>
              )}
            </div>

            <Field
              label="pick the strike by"
              help={
                <>
                  <p>
                    <b>Most premium</b> takes the furthest strike that still pays your
                    floor. Over 733 days: profit factor 3.08, worst day −$7.08, a trade
                    on 653 days, average premium $27.
                  </p>
                  <p>
                    <b>Safest</b> takes the richest strike that clears <i>both</i> your
                    premium floor and your safety bar. At $15 and 98%: profit factor
                    9.67, worst day −$3.66, a trade on 456 days.
                  </p>
                  <p>
                    In this mode a day where only one side clears both bars is still
                    traded, with the whole position on that side. That matters: skipping
                    those days drops it from 456 days to 215.
                  </p>
                  <p>
                    Asking for more safety does not get you more premium — it gets you
                    less. A strike that safe is a long way out, and strikes that far out
                    are cheap. What you are buying is a smaller worst day.
                  </p>
                </>
              }
            >
              <Select
                ariaLabel="pick the strike by"
                value={mode}
                onValueChange={(v) => setMode(v as 'premium' | 'safety')}
              >
                <SelectItem value="premium" hint="furthest strike still paying your floor">
                  most premium
                </SelectItem>
                <SelectItem value="safety" hint="richest strike clearing your floor and the safety bar">
                  safest
                </SelectItem>
              </Select>
            </Field>

            {mode === 'safety' && (
              <Field
                label="safety bar %"
                help={
                  <>
                    <p>
                      The lowest measured chance of expiring worthless you will accept
                      on a strike.
                    </p>
                    <p>
                      <b>98% is the tightest bar that worked in all three years.</b>{' '}
                      Going to 99% looks better overall but fails 2024 outright —
                      profit factor 1.23 on 29 days — because it waits for conditions
                      that year rarely offered.
                    </p>
                  </>
                }
              >
                <input
                  type="number" step="0.1" min="50" max="99.9"
                  value={safetyBar}
                  onChange={(e) => setSafetyBar(Number(e.target.value))}
                />
              </Field>
            )}

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
                <>
                  <p>
                    How much of the chain to fetch and display, counted in strikes above
                    and below the money. Display only — it does not change the trade,
                    though too small a window can hide the strike you want.
                  </p>
                  <p>
                    Raising it past what Delta lists adds nothing. A daily contract opens
                    with roughly a dozen strikes each way and gains more only as BTC
                    travels toward the edge, so 30 here often returns 12. The table says
                    so when that happens.
                  </p>
                </>
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
            </Collapsible.Content>
          </Collapsible.Root>

          {err && <div className="err">{err}</div>}
          {busy && !data && <div className="spinner">loading chain…</div>}

          {data && snap && (
            <>
              <div className="lead-row">
                <CollapsibleCard
                  id="live"
                  title={snap.live ? 'Live' : 'Snapshot'}
                  right={
                    snap.isNextEntry
                      ? <Badge tone="ok">next entry</Badge>
                      : <Badge tone="warn">not the tested contract</Badge>
                  }
                >

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
                  {data.market && <MoveSection market={data.market} snap={snap} />}
                  <BiasSection bias={data.bias} />
                  <AccountSection usdinr={data.usdinr} />
                </CollapsibleCard>

                <RecommendPanel rec={data.recommendation} market={data.market} minPremium={minPremium} usdinr={data.usdinr} />
              </div>
              <div className="chain-bar">
                <span className="dim">
                  {data.legs.length} legs · {snap.step} apart
                  {data.recommendation.ok && data.recommendation.sides.length > 0
                    ? ' · marked where the desk would sell'
                    : ' · nothing marked — nothing qualifies today'}
                </span>
                <span className="chain-density">
                  <Select
                    ariaLabel="chain columns"
                    value={density}
                    onValueChange={(v) => setDensity(v as 'default' | 'all')}
                  >
                    <SelectItem value="default" hint="the odds and the prices — what settles the trade">
                      columns · default
                    </SelectItem>
                    <SelectItem value="all" hint="adds OI, volume, age, delta and IV both sides">
                      columns · everything
                    </SelectItem>
                  </Select>
                </span>
              </div>
              <ChainTable legs={data.legs} snap={snap} sides={data.recommendation.ok ? data.recommendation.sides : []} density={density} />
              <div className="note">
                Age is minutes since a real trade printed. Delta's candle feed
                forward-fills quiet minutes, so a traded price with a large age is a
                carry-forward, not a quote you can hit — the mark is the honest number
                there. Historical rows have no order book, so bid and ask are blank and
                the mark is used as the sell estimate.
              </div>

              <VerdictPanel
                verdict={data.verdict}
                picks={data.picks}
                lots={lots}
                usdinr={data.usdinr}
              />



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
