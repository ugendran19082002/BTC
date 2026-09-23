import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Clock, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type {
  MarketStateResponse, StateHistoryRow, StateIndicator, StatePattern, StatePlan,
} from '@/api/desk';
import { strike as fmtStrike } from '@/lib/format';
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

const TABS = ['Analysis', 'Levels', 'Patterns', 'Indicators'] as const;
type Tab = (typeof TABS)[number];

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
});

export function MarketState({
  data, history, hitRate, tf, spot,
}: {
  data: MarketStateResponse | null;
  history?: StateHistoryRow[];
  hitRate?: { correct: number; graded: number };
  /** The chart's timeframe, shown but not switched here: there is one row. */
  tf: string;
  /** BTC now, so each earlier call can say what price did after it. */
  spot?: number;
}) {
  const [tab, setTab] = useState<Tab>('Analysis');
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
        Two columns where there is room: the reading on the left, what the card
        said earlier on the right. Full width for a card this size stretched
        every row into a thin line of text with a hand's width of empty panel
        after it -- the reference the owner sent is a column, and it reads like
        one because of that. Under 900px they stack.
      */}
      {s ? (
        <div className="bt-market-state__body">
          <div className="bt-market-state__main">
            <div className="bt-market-state__tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t} role="tab" type="button" aria-selected={t === tab} onClick={() => setTab(t)}
                  className={cn('bt-market-state__tab', t === tab && 'bt-market-state__tab--on')}>{t}</button>
              ))}
            </div>

            {tab === 'Analysis' ? <Checks checks={s.checks} /> : null}
            {tab === 'Patterns' ? <Patterns patterns={data?.patterns.shown ?? []} /> : null}
            {tab === 'Indicators' ? <Indicators items={data?.indicators.shown ?? []} /> : null}

            {/* The plans sit under every tab, targets and all: they are what the
                card is for, and a number you have to change tab to see is one
                you act on late. */}
            <Plans plans={s.plans} level={s.level} distance={s.distance} against={s.against} />
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

function Patterns({ patterns }: { patterns: readonly StatePattern[] }) {
  if (!patterns.length) return <p className="bt-muted">Nothing named on these bars.</p>;
  return (
    <ul className="bt-market-state__patterns">
      {patterns.map((p) => (
        <li key={p.name} className={cn(p.bias === 'BULLISH' && 'is-up', p.bias === 'BEARISH' && 'is-down')}>
          <strong>{p.name}</strong>
          <span>{p.note}</span>
          {p.barsAgo > 0 ? <em>{p.barsAgo} bars ago</em> : null}
        </li>
      ))}
    </ul>
  );
}

function Indicators({ items }: { items: readonly StateIndicator[] }) {
  if (!items.length) return <p className="bt-muted">No readings yet.</p>;
  return (
    <ul className="bt-market-state__indicators">
      {items.map((i) => (
        <li key={i.key}>
          <span className="bt-market-state__ind-label">{i.label}</span>
          <strong>{i.text}</strong>
          <span className={cn('bt-market-state__ind-read',
            i.bias === 'BULLISH' && 'is-up', i.bias === 'BEARISH' && 'is-down')}>{i.read}</span>
          {i.gauge !== null ? (
            <span className="bt-market-state__gauge" aria-hidden>
              <span style={{ width: `${Math.round(i.gauge * 100)}%` }} />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Five calls a page: the newest is the one being looked for. */
const PAGE = 5;

const OUTCOME_WORDS: Record<string, string> = {
  CORRECT: 'Correct', WRONG: 'Wrong', UNRESOLVED: 'No follow-through', NOT_GRADED: '—',
};

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
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = rows.slice(at * PAGE, at * PAGE + PAGE);
  const first = at * PAGE + 1;

  return (
    <div className="bt-market-state__history">
      <h4>
        Signal history <span className="bt-market-state__hist-unit">BTC pts</span>
        {rate && rate.graded > 0 ? <span>{rate.correct} of {rate.graded} came good</span> : <span>none graded yet</span>}
      </h4>
      <ul>
        {shown.map((r, i) => {
          /*
           * What BTC did after the call: to the next call, or to the price now
           * for the newest one. It is the question the row is read to answer,
           * and reading it off two close prices in your head is the part
           * nobody does.
           */
          /*
           * What BTC did after the call. The graded rows carry it: the server
           * wrote down where price finished the window, so the figure does not
           * depend on when this screen happened to be open. An ungraded one is
           * measured to the next call, or to the price now for the newest.
           */
          const after = r.resolvedClose ?? rows[at * PAGE + i - 1]?.close ?? spot ?? null;
          const move = r.movePts ?? (after === null ? null : Math.round(after - r.close));
          // Which way it went is not the same as whether the call was right:
          // the colour follows the call, so a fall after a breakdown is green.
          const went = move === null || r.side === null ? null
            : (r.side === 'UP' ? move > 0 : move < 0);
          return (
            <li key={r.id}>
              <div className="bt-market-state__hist-line">
                <span className="bt-market-state__hist-at">{IST.format(r.at)}</span>
                {r.side === 'UP' ? <ArrowUpRight size={14} className="is-up" aria-hidden />
                  : r.side === 'DOWN' ? <ArrowDownRight size={14} className="is-down" aria-hidden />
                    : <Minus size={14} aria-hidden />}
                <span className="bt-market-state__hist-what">
                  {STATE_WORDS[r.event]?.title ?? r.event} <em>({r.confidence})</em>
                </span>
                <span className={cn('bt-market-state__hist-out',
                  r.outcome === 'CORRECT' && 'is-up', r.outcome === 'WRONG' && 'is-down',
                  (r.outcome === 'CORRECT' || r.outcome === 'WRONG') && 'is-chip')}>
                  {OUTCOME_WORDS[r.outcome ?? 'NOT_GRADED'] ?? '—'}
                </span>
              </div>
              {/* The index either side of the call, so the points are a figure
                  somebody can check rather than one they have to trust. */}
              <div className="bt-market-state__hist-line is-prices">
                <span>
                  {fmtStrike(Math.round(r.close))}
                  {after === null ? null : <> → {fmtStrike(Math.round(after))}</>}
                </span>
                <span className={cn('bt-market-state__hist-pts',
                  went === true && 'is-up', went === false && 'is-down')}
                  title="BTC index points between this call and the next one — the underlying, not option premium">
                  {move === null ? '—' : `${move > 0 ? '+' : move < 0 ? '−' : ''}${Math.abs(move).toLocaleString('en-US')} pts`}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Five at a time, newest first. Ten rows of small print is a wall
          nobody reads to the end of, and the newest call is the one being
          looked for. */}
      {rows.length > PAGE ? (
        <div className="bt-market-state__pager">
          <span>{first}–{first + shown.length - 1} of {rows.length}</span>
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
    </div>
  );
}
