import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clock, Download, Minus, TrendingDown, TrendingUp,
} from 'lucide-react';
import type { MarketStateResponse, StateHistoryRow, StatePlan } from '@/api/desk';
import { strike as fmtStrike } from '@/lib/format';
import { trackFor } from '@/components/desk/signal-track';
import { csvNameFor, istDay, signalsToCsv } from '@/components/desk/signal-export';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/**
 * Where price is against the level that matters, in one card.
 *
 * The one question a chart is opened to answer -- is it going, or has it been
 * turned back? -- with the working underneath it: what has to be true for the
 * break to count, which of those are true now, and what the trade is either
 * way. The rules are all on the server (`domain/market-state.ts`); nothing is
 * decided here, only shown.
 *
 * ## The two things this card is careful about
 *
 * **A setup is not a fact.** "Breakout likely" and "breakout confirmed" are
 * different sentences and are never dressed alike: the banner says which, and
 * an unconfirmed state is never given the confirmed colour.
 *
 * **The number is a score, not a probability.** 76 means the weighted
 * confirmations came to 0.76, not that it goes up three times in four. Nothing
 * here is calibrated against history yet, so the badge says "score" and the
 * tooltip says the rest. When the matched-state model lands, a probability can
 * sit beside it -- and be labelled as one.
 */

const STATE_WORDS: Record<string, { title: string; tone: Tone }> = {
  RANGE: { title: 'Range', tone: 'flat' },
  BREAKOUT_WATCH: { title: 'Breakout watch', tone: 'up-soft' },
  BREAKOUT_CANDIDATE: { title: 'Breakout candidate', tone: 'up-soft' },
  BREAKOUT_CONFIRMED: { title: 'Breakout confirmed', tone: 'up' },
  RETEST_HOLD: { title: 'Retest holding', tone: 'up' },
  FALSE_BREAKOUT: { title: 'False breakout', tone: 'down' },
  REJECTION: { title: 'Resistance rejection', tone: 'down' },
  BREAKDOWN_WATCH: { title: 'Breakdown watch', tone: 'down-soft' },
  BREAKDOWN_CANDIDATE: { title: 'Breakdown candidate', tone: 'down-soft' },
  BREAKDOWN_CONFIRMED: { title: 'Breakdown confirmed', tone: 'down' },
  FALSE_BREAKDOWN: { title: 'False breakdown', tone: 'up' },
  SUPPORT_REJECTION: { title: 'Support held', tone: 'up' },
};

type Tone = 'up' | 'up-soft' | 'down' | 'down-soft' | 'flat';

const TONE_CLASS: Record<Tone, string> = {
  up: 'bt-state-up',
  'up-soft': 'bt-state-up-soft',
  down: 'bt-state-down',
  'down-soft': 'bt-state-down-soft',
  flat: 'bt-state-flat',
};


const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
});
const IST_DAY = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
});

export function MarketState({
  data, history, hitRate, tf, spot, extra = [],
}: {
  data: MarketStateResponse | null;
  history?: StateHistoryRow[];
  hitRate?: { correct: number; graded: number };
  /** The chart's timeframe, shown but not switched here: there is one row. */
  tf: string;
  /** BTC now, so each earlier call can say what price did after it. */
  spot?: number;
  /**
   * Tabs the caller fills: the expiry read and the options' own bias.
   *
   * They were two more cards in the right-hand column, asking the same
   * question this card asks -- which way, and how sure -- from the options
   * board instead of the bars. Three cards for one question is how a screen
   * gets read in the wrong order. They are passed in rather than built here so
   * their own logic is untouched and this file stays free of the chain's
   * types: it shows them, it does not compute them.
   */
  extra?: readonly { label: string; node: ReactNode }[];
}) {
  const s = data?.state ?? null;
  const words = s ? STATE_WORDS[s.event] ?? { title: s.event, tone: 'flat' as Tone } : null;

  // "Likely" while it is a setup, the plain name once it has happened. The
  // difference is the whole point of the stage, so it is in the title itself
  // rather than in a subtitle somebody can miss.
  const title = useMemo(() => {
    if (!s || !words) return 'Reading the chart…';
    if (s.stage === 'WATCH') return `${words.title.replace(' watch', '')} likely`;
    return words.title;
  }, [s, words]);

  return (
    <section className="bt-market-state" aria-label="Market analysis">
      <header className="bt-market-state__head">
        <h3>Market analysis</h3>
        <div className="bt-market-state__head-right">
          <span className="bt-market-state__tf">{tf}</span>
          {data ? (
            <span className="bt-market-state__at"><Clock size={12} aria-hidden /> Updated {IST.format(data.at)}</span>
          ) : null}
          {s ? (
            <span className="bt-market-state__score" title="A weighted score of the confirmations below, out of 100. Not a probability: nothing here is calibrated against history yet.">
              <b>{s.confidence}</b> score
            </span>
          ) : null}
        </div>
      </header>

      {s && words ? (
        <div className={cn('bt-market-state__banner', TONE_CLASS[words.tone])}>
          {s.side === 'UP' ? <TrendingUp size={22} aria-hidden /> : s.side === 'DOWN' ? <TrendingDown size={22} aria-hidden /> : <Minus size={22} aria-hidden />}
          <div>
            <strong>
              {title}
              {s.side ? <span className="bt-market-state__bias">{s.side === 'UP' ? ' (bullish)' : ' (bearish)'}</span> : null}
            </strong>
            <p>{s.words}</p>
          </div>
          <span className="bt-market-state__stage">{s.confirmed ? 'Confirmed' : 'Not confirmed'}</span>
        </div>
      ) : (
        <p className="bt-muted">No state yet.</p>
      )}

      {/*
        No tabs (24 Sep 2026).

        The card had six -- Analysis, Levels, Patterns, Indicators, Expiry,
        Options -- and five of them hid an answer to a question already being
        asked on the same screen: the patterns and the readings are in the
        strip beside the chart, and the levels are the plans, which are never
        hidden anyway. A tab bar over a card this short is a filing cabinet for
        one page.

        What is left runs down the card in the order somebody reads it: what
        has to be true, the trade either way, where the board says it settles,
        and which side the options are being bought on.
      */}
      {s ? (
        <div className="bt-market-state__body">
          <div className="bt-market-state__main">
            {/*
              The checks on the left, what kind of market it is on the right.
              A reader asks the three chips first -- is there a trend, are the
              bars big, do the other timeframes agree -- and then reads the
              confirmations knowing what they are confirmations of.
            */}
            <div className="bt-market-state__reading">
              <Checks checks={s.checks} />
              {data ? (
                <ul className="bt-market-state__chips">
                  <li><span>Market regime</span><b>{data.context.regime}</b></li>
                  <li>
                    <span>Volatility</span>
                    <b title={data.context.volatility.atrPct === null ? undefined
                      : `ATR is ${data.context.volatility.atrPct.toFixed(2)}% of price a bar`}>
                      {data.context.volatility.word}
                    </b>
                  </li>
                  <li className={cn(data.context.alignment.side === 'UP' && 'is-up',
                    data.context.alignment.side === 'DOWN' && 'is-down')}>
                    <span>Timeframe alignment</span><b>{data.context.alignment.word}</b>
                  </li>
                </ul>
              ) : null}
            </div>

            {/*
              The levels either side, named the way a trader names them: R1 and
              S1 are what price is working against now, R2 and S2 are where it
              goes if those give way.
            */}
            {data && data.levels.length > 0 ? (
              <div className="bt-market-state__levels">
                <h4>Key levels</h4>
                <ul>
                  {data.levels.map((l) => (
                    <li key={l.label} className={cn(l.side === 'resistance' ? 'is-down' : 'is-up')}>
                      <span className="bt-market-state__level-tag">{l.label}</span>
                      <b>{fmtStrike(Math.round(l.price))}</b>
                      <em>{l.strength}</em>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <Plans plans={s.plans} level={s.level} distance={s.distance} against={s.against} />

            {extra.map((e) => (
              <section key={e.label} className="bt-market-state__extra" aria-label={e.label}>
                {e.node}
              </section>
            ))}
          </div>

          {history?.length ? <History rows={history} rate={hitRate} spot={spot} /> : null}
        </div>
      ) : null}

    </section>
  );
}

/** The confirmation list: what has to be true, and what is. */
function Checks({ checks }: { checks: readonly { label: string; ok: boolean | null }[] }) {
  return (
    <ul className="bt-market-state__checks">
      {checks.map((c) => (
        <li key={c.label} className={cn(c.ok === true && 'is-ok', c.ok === false && 'is-no', c.ok === null && 'is-unknown')}>
          {c.ok === true ? <CircleCheck size={16} aria-hidden /> : c.ok === false ? <CircleAlert size={16} aria-hidden /> : <Minus size={16} aria-hidden />}
          <span>{c.label}</span>
          {/* A reading the desk could not take is said out loud, not left
              looking like a failed one: they mean quite different things. */}
          {c.ok === null ? <em>not measured</em> : null}
        </li>
      ))}
    </ul>
  );
}

/** Both sides at once: go long over the level, wait between, go short under. */
function Plans({
  plans, level, distance, against,
}: {
  plans: { up: StatePlan | null; down: StatePlan | null };
  level: { resistance: number | null; support: number | null };
  distance: number | null;
  against: number | null;
}) {
  return (
    <div className="bt-market-state__plans">
      <PlanBox plan={plans.up} title="Breakout" action="go long" tone="up" />
      <div className="bt-market-state__plan bt-market-state__plan--wait">
        <h4>Range <span>wait</span></h4>
        <p className="bt-market-state__range">
          {level.support !== null ? fmtStrike(level.support) : '—'} – {level.resistance !== null ? fmtStrike(level.resistance) : '—'}
        </p>
        {against !== null && distance !== null ? (
          <p className="bt-muted">{distance > 0 ? '+' : ''}{Math.round(distance)} from {fmtStrike(against)}</p>
        ) : <p className="bt-muted">No trade between them</p>}
      </div>
      <PlanBox plan={plans.down} title="Breakdown" action="go short" tone="down" />
    </div>
  );
}

function PlanBox({ plan, title, action, tone }: { plan: StatePlan | null; title: string; action: string; tone: 'up' | 'down' }) {
  return (
    <div className={cn('bt-market-state__plan', tone === 'up' ? 'is-up' : 'is-down')}>
      <h4>{title} <span>{action}</span></h4>
      {plan ? (
        <>
          <p className="bt-market-state__trigger">
            {tone === 'up' ? <ArrowUpRight size={14} aria-hidden /> : <ArrowDownRight size={14} aria-hidden />}
            {tone === 'up' ? '> ' : '< '}{fmtStrike(plan.trigger)}
          </p>
          <dl>
            <div><dt>Target 1</dt><dd>{fmtStrike(plan.target1)}</dd></div>
            <div><dt>Target 2</dt><dd>{fmtStrike(plan.target2)}</dd></div>
            {/* "Stop loss" is what it is for, and what the owner's reference calls
                it; invalidation is the same price said to a chartist. */}
            <div><dt>Stop loss</dt><dd>{fmtStrike(plan.invalidation)}</dd></div>
          </dl>
        </>
      ) : <p className="bt-muted">No level on this side</p>}
    </div>
  );
}

/**
 * One signal, the way the owner's reference draws it.
 *
 * Left to right, in the order the questions are asked: when, which way, what
 * was called and how sure, where it ended up, the three prices it was defined
 * by, how far it actually got, and what that came to in points.
 *
 * The same row is used in the list and behind *View all*, because two
 * renderings of one thing is two things to keep true.
 */
function SignalRow({ row: r, before, spot }: {
  row: StateHistoryRow;
  /** The call before this one, whose close says where price went after it. */
  before: StateHistoryRow | null;
  spot?: number;
}) {
  const after = r.resolvedClose ?? before?.close ?? spot ?? null;
  const move = r.movePts ?? (after === null ? null : Math.round(after - r.close));
  const went = move === null || r.side === null ? null : (r.side === 'UP' ? move > 0 : move < 0);
  const waiting = r.outcome === null;
  const toTrigger = r.plan && after !== null ? Math.round(Math.abs(r.plan.trigger - after)) : null;
  const track = r.plan ? trackFor({
    side: r.side, trigger: r.plan.trigger, target: r.plan.target1, price: after, outcome: r.outcome ?? null,
  }) : null;

  return (
    <li data-outcome={r.outcome ?? 'WAITING'}>
      <div className="bt-signal__when">
        <b>{IST.format(r.at)}</b>
        <span>{IST_DAY.format(r.at)}</span>
      </div>

      <span className={cn('bt-signal__side', r.side === 'UP' && 'is-up', r.side === 'DOWN' && 'is-down')} aria-hidden>
        {r.side === 'UP' ? <ArrowUpRight size={16} /> : r.side === 'DOWN' ? <ArrowDownRight size={16} /> : <Minus size={16} />}
      </span>

      <div className="bt-signal__what">
        <div>
          <strong>{STATE_WORDS[r.event]?.title ?? r.event}</strong>
          <em>({r.confidence})</em>
          <span className="bt-market-state__hist-tf">{r.tf}</span>
        </div>
        {r.plan ? (
          <span className="bt-signal__call">
            {r.side === 'UP' ? 'Over' : 'Under'} {fmtStrike(Math.round(r.plan.trigger))}
            {' → target '}{fmtStrike(Math.round(r.plan.target1))}
          </span>
        ) : null}
        <span className="bt-signal__btc">
          BTC {fmtStrike(Math.round(r.close))}
          {after === null ? null : <> → {fmtStrike(Math.round(after))}</>}
        </span>
      </div>

      <span className={cn('bt-market-state__hist-out', `is-${(r.outcome ?? 'waiting').toLowerCase()}`)}>
        {outcomeWord(r.outcome)}
      </span>

      {r.plan ? (
        <div className="bt-signal__prices">
          <span><em>Trigger</em><b>{fmtStrike(Math.round(r.plan.trigger))}</b></span>
          <span><em>Target</em><b>{fmtStrike(Math.round(r.plan.target1))}</b></span>
          <span><em>Stop</em><b>{fmtStrike(Math.round(r.plan.invalidation))}</b></span>
        </div>
      ) : <div className="bt-signal__prices" />}

      {/* How far it got: the dot is where price reached between the two. */}
      {track ? (
        <div className={cn('bt-market-state__track', `is-${track.tone}`)}>
          <span className="bt-market-state__track-line" aria-hidden>
            <i style={{ width: `${Math.round(track.at * 100)}%` }} />
            <em style={{ left: `${Math.round(track.at * 100)}%` }} />
          </span>
          <span className="bt-market-state__track-ends">
            <b>{fmtStrike(Math.round(r.plan!.trigger))}</b>
            {waiting && toTrigger !== null ? <b className="bt-market-state__hist-far">{toTrigger} pts to trigger</b>
              : r.outcome === 'NOT_TRIGGERED' ? <b className="bt-market-state__hist-far">Not triggered</b>
                : <b>{fmtStrike(Math.round(r.plan!.target1))}</b>}
          </span>
        </div>
      ) : <div />}

      <div className="bt-signal__result">
        <span>{waiting ? 'Current' : r.outcome === 'NOT_TRIGGERED' || r.outcome === 'EXPIRED' ? 'Expired' : 'Result'}</span>
        <b className={cn(went === true && 'is-up', went === false && 'is-down')}>
          {r.outcome === 'NOT_TRIGGERED' ? '0 pts'
            : move === null ? '—'
              : `${move > 0 ? '+' : move < 0 ? '−' : ''}${Math.abs(Math.round(move)).toLocaleString('en-US')} pts`}
        </b>
      </div>
    </li>
  );
}

/** Five calls a page: the newest is the one being looked for. */
const PAGE = 5;

/**
 * Where each call ended.
 *
 * **"Wrong" is not one of them, on purpose (24 Sep 2026).** A breakout watch
 * says "over 84,532 this goes to 84,731"; if price never reached 84,532 there
 * was no trade to be wrong about, and the screen was filling with red for
 * calls that were never anything but a plan. A call that has not finished says
 * *waiting*, one that never started says *not triggered*, and the only red
 * word is for a call that ran and hit its own invalidation.
 */
const OUTCOME_WORDS: Record<string, string> = {
  TARGET_HIT: 'Target hit',
  INVALIDATED: 'Invalidated',
  NOT_TRIGGERED: 'Not triggered',
  EXPIRED: 'Expired',
  NOT_GRADED: '—',
};

/**
 * A call that has not been graded yet says so.
 *
 * It read "—" before, which is what a range reads -- so a breakout waiting on
 * its four bars looked exactly like a call nobody would ever grade, and the
 * list looked broken rather than busy.
 */
const outcomeWord = (o: string | null | undefined): string =>
  o == null ? 'Waiting' : OUTCOME_WORDS[o] ?? '—';

/**
 * What the card has said before, and whether it was right.
 *
 * The reason the score can be believed at all, or not. A call is graded
 * against the bars that followed by a rule fixed before the outcome was known,
 * and the tally is given as "3 of 4" rather than a percentage, because four
 * calls is not a hit rate.
 */
function History({ rows, rate, spot }: {
  rows: readonly StateHistoryRow[];
  rate?: { correct: number; graded: number };
  spot?: number;
}) {
  const [page, setPage] = useState(0);
  const [allOpen, setAllOpen] = useState(false);
  /*
   * Today, by default.
   *
   * The list is read to answer "what has the desk called since this morning",
   * and a page of yesterday's calls at the top answers a question nobody
   * asked. Everything is still there behind *View all*, where a day is a
   * heading and the whole lot can be taken away as a file.
   */
  const today = istDay(Date.now());
  const todays = rows.filter((r) => istDay(r.at) === today);
  const shownRows = todays.length > 0 ? todays : rows;
  const pages = Math.max(1, Math.ceil(shownRows.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = shownRows.slice(at * PAGE, at * PAGE + PAGE);
  const first = at * PAGE + 1;

  /*
   * The file is built here rather than asked of the server: the rows are
   * already on the screen, and a download that needs a round trip is one that
   * can fail while somebody is looking at the data it would contain.
   */
  const download = () => {
    const csv = signalsToCsv(rows, outcomeWord);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = csvNameFor(rows[0]?.tf ?? 'all');
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bt-market-state__history">
      <h4>
        Signal history <span className="bt-market-state__hist-unit">BTC pts</span>
        <span className="bt-market-state__hist-scope">{todays.length > 0 ? 'Today' : 'Latest'}</span>
        {rate && rate.graded > 0
          ? <span title="Of the calls that actually triggered and finished. A setup whose trigger was never reached is not counted either way.">
            {rate.correct} of {rate.graded} reached target
          </span>
          : <span>none finished yet</span>}
        <button type="button" className="bt-market-state__hist-all" onClick={() => setAllOpen(true)}>
          View all <ChevronRight size={12} aria-hidden />
        </button>
      </h4>
      <ul className="bt-signals">
        {shown.map((r, i) => (
          <SignalRow key={r.id} row={r} before={shownRows[i + 1] ?? null} spot={spot} />
        ))}
      </ul>

      {/* Five at a time, newest first. Ten rows of small print is a wall
          nobody reads to the end of, and the newest call is the one being
          looked for. */}
      {shownRows.length > PAGE ? (
        <div className="bt-market-state__pager">
          <span>{first}–{first + shown.length - 1} of {shownRows.length} signals</span>
          <button type="button" className="bt-chip" aria-label="Newer calls"
            disabled={at === 0} onClick={() => setPage(at - 1)}>
            <ChevronLeft size={14} aria-hidden />
          </button>
          <button type="button" className="bt-chip" aria-label="Older calls"
            disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
            <ChevronRight size={14} aria-hidden />
          </button>
        </div>
      ) : null}

      {/*
        Every day the journal still holds, grouped by the day it happened on,
        with the whole lot downloadable. The screen keeps today; this is where
        somebody goes to check last Tuesday against their broker statement.
      */}
      <Sheet open={allOpen} onOpenChange={setAllOpen}>
        <SheetContent title="Signal history — all days">
          <div className="bt-market-state__all">
            <div className="bt-market-state__all-head">
              <span>{rows.length} signals</span>
              <button type="button" className="bt-chip" onClick={download}>
                <Download size={13} aria-hidden /> Download CSV
              </button>
            </div>
            {[...new Set(rows.map((r) => istDay(r.at)))].map((day) => (
              <section key={day}>
                <h5>{day}</h5>
                <ul className="bt-signals">
                  {rows.filter((r) => istDay(r.at) === day).map((r, i, list) => (
                    <SignalRow key={r.id} row={r} before={list[i + 1] ?? null} spot={spot} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
