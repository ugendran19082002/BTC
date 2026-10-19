import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { WidenCompare } from '@/components/report/WidenCompare';
import { SavedMethodsPicker } from '@/components/report/SavedMethodsPicker';
import { WinPickResult } from '@/components/report/WinPickResult';
import { usePersisted } from '@/hooks/usePersisted';
import { ChevronDown, Copy, FolderOpen, Pencil, Search, Trash2 } from 'lucide-react';
import { AS_SAVED, cloneBacktestSave, clonePortfolio, deleteBacktestSave, deletePortfolio, getBacktestPortfolio, getBacktestSaves, getPortfolioLiveCheck, getPortfolioTrades, getPortfolioVolStudy, getPortfolioVolStudyTrades, overQuery, renameBacktestGroup, saveBacktest, savePortfolio, type PortfolioCap, type PortfolioHours, type PortfolioLimit, type PortfolioOver } from '@/api/backtest-saves';
import { pct } from '@/lib/format';
import { time12 } from '@/lib/time';
import { overWords } from '@/components/report/backtest-words';
import { LiveCheck } from '@/components/report/LiveCheck';
import { VolStudy } from '@/components/report/VolStudy';
import { dayLabel, moneyText, timeIst } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { BacktestPortfolioResult, BacktestSave, BacktestSaves, BoardGrain, BtDayTrades, BtRow, SavedQuery, TradePick } from '@/types/signal-backtest';
import { BacktestBreakdowns, ChargesNote, DayAverages, GRAIN, ResultNav, WinnersLosers, pricedWords, skippedParts } from '@/components/report/BacktestBreakdowns';
import { BacktestCurve } from '@/components/report/BacktestCurve';
import { SessionTable } from '@/components/report/SessionTable';
import { DayTradesSheet } from '@/components/report/DayTrades';
import { Empty, Loading, Panel, Stat, Stats } from '@/components/mobile/parts';
import { Updating, useAnswer } from '@/components/report/Updating';
import { Entry, Ledger, SETTLE_MS, Table, count, each, marginWorking, netClass, rate } from '@/components/report/backtest-parts';

/**
 * Backtests kept by name, and run together (owner, 13 Oct 2026: "save a backtest's settings and run a saved one;
 * several saved ones as a portfolio, with the total of them all").
 *
 * A saved backtest is the settings on the screen -- never a range of days or a result -- so tapping one puts its
 * settings back and the result below is worked for whatever days are chosen. Ticking two or more and running them
 * together works each on its own, as it is alone, and adds them up; the set can be kept under a name as a
 * portfolio and run again in one tap.
 *
 * Both can be edited: a saved backtest's settings (put on the screen, changed there) and its name; a portfolio's
 * members (ticked in the list) and its name. Nothing changes until Save changes.
 */

/** A query as it is compared: every setting named, lists in one order -- the screen leaves out what is off, the desk sends it. */
function shapeOf(q: SavedQuery): string {
  const p = q.params;
  return JSON.stringify({
    rule: p.rule, value: p.value, lots: p.lots, targetPct: p.targetPct, stopPct: p.stopPct, window: p.window,
    hours: p.window === 'custom' ? [p.hoursFrom ?? '', p.hoursTo ?? ''] : null,
    deskMax: p.deskMax ?? 0, cePct: p.cePct ?? 100, pePct: p.pePct ?? 100,
    range: [p.slMin ?? 0, p.slMax ?? 0, p.tgtMin ?? 0, p.tgtMax ?? 0],
    steps: (p.targetSteps ?? []).map((s) => [s.at, Math.round(s.pct * 10_000)]), vol: p.vol ?? 'off', volBy: p.volBy ?? 'atr', minPremium: p.minPremium ?? 10,
    noEntry: p.noEntry?.on ? p.noEntry.windows.map((w) => `${w.from}-${w.to}`) : null,
    blocks: p.strikeBlocks?.length ? p.strikeBlocks : null,
    tsl: p.tsl ?? null,
    widen: [p.widenSlAtr ?? 0, p.widenTgtAtr ?? 0, p.widenMode ?? 'widest'],
    skip: [p.skipPerpSl === true, p.skipPerpTgt === true],
    be: p.breakEven ?? null,
    tfs: [...q.tfs].sort(), methods: [...q.methods].sort(), strategy: q.strategy,
  });
}

const field = 'h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-3 text-[16px] text-foreground';
const solid = 'h-11 shrink-0 rounded-lg border-0 bg-[var(--chosen)] px-3 font-[inherit] text-[14px] font-semibold text-[var(--chosen-ink)] disabled:opacity-40';
const quiet = 'h-11 shrink-0 rounded-lg border border-solid border-border bg-transparent px-3 font-[inherit] text-[14px] text-foreground disabled:opacity-40';
const link = 'm-0 min-h-[36px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[13px] font-medium text-[var(--accent)] disabled:opacity-40';

/** The run's parts to jump to: the backtest's own, beside each one's line in the summary. */
export const RUN_PARTS = [
  { id: 'pf-summary', label: 'Summary' },
  { id: 'pf-exits', label: 'Exits & time frames' },
  { id: 'pf-pairs', label: 'Pairs' },
  { id: 'pf-methods', label: 'Methods' },
  { id: 'pf-perp', label: 'Perp vs options' },
  { id: 'pf-sessions', label: 'Sessions' },
  { id: 'pf-days', label: 'Days' },
  { id: 'pf-volsl', label: 'By volatility' },
  { id: 'pf-live', label: 'Live check' },
] as const;

/** Whether a part of the run is on the screen, for the jump bar: the summary and the two studies always; the rest once it traded. */
function runHas(r: BacktestPortfolioResult, id: string): boolean {
  if (id === 'pf-summary' || id === 'pf-volsl' || id === 'pf-live') return true;
  if (r.total.n === 0) return false;
  if (id === 'pf-days') return true;
  if (id === 'pf-sessions') return (r.bySession?.length ?? 0) > 0;
  if (id === 'pf-perp') return r.total.perpNetPts !== undefined;
  return r.breakdown !== undefined;
}

/** Each day's options priced, over the members: one board, so each day counted once (the first member's). */
const pricedOf = (r: BacktestPortfolioResult): Record<BoardGrain, number> | undefined => {
  if (r.days.some((d) => d.grain)) {
    const out: Record<BoardGrain, number> = { 'own-1m': 0, 'mark-1m': 0, '5m': 0 };
    for (const d of r.days) if (d.grain) out[d.grain]++;
    return out;
  }
  return r.members.find((m) => m.priced)?.priced ?? undefined;
};

/**
 * The saved backtests run together, laid out as one backtest's result is (owner, 17 Oct 2026: "the portfolio is
 * missing the backtest's upgrades -- fully the same, user friendly"): the total and its working, each one, then the
 * same breakdowns -- exits, volatility, trend and market move, time frames, pairs, methods, sessions, kinds of day,
 * expiry days -- each a panel of its own that folds, with the jump bar over them.
 */
function PortfolioResult({ title, r, wide, readTrades, widen }: {
  title: string; r: BacktestPortfolioResult; wide: boolean;
  /** The perp levels three ways over the run (`WidenCompare`), where the run widens them. */
  widen?: ReactNode;
  /** Its trades, one by one, as the run worked them -- of a day, a session, a method in one (`DayTradesSheet`). */
  readTrades?: (pick: TradePick) => Promise<BtDayTrades>;
}) {
  const [openTrades, setOpenTrades] = useState<{ key: string; title?: string; pick: TradePick } | null>(null);
  const t = r.total;
  const members: BtRow[] = r.members.map((m) => ({ ...m.total, key: m.id, name: m.name }));
  const days: BtRow[] = [...r.days].reverse().map((d) => ({
    key: d.day, name: `${dayLabel(d.day)}${d.live ? ' · so far' : ''}${d.grain ? ` · ${GRAIN[d.grain]}` : ''}`, n: d.n, wins: d.wins, losses: d.n - d.wins, net: d.net, won: 0, lost: 0, perpPts: 0, charges: d.charges, exits: {},
  }));
  const failed = r.members.filter((m) => m.problem);
  const notTraded = r.skipped ? Object.values(r.skipped).reduce((n, x) => n + (x ?? 0), 0) : 0;
  const priced = pricedWords(pricedOf(r));
  const sessions = (r.bySession?.length ?? 0) > 0 ? (
    // By session of the day, all of them together (owner, 15 Oct 2026): 1h by default, 15m to 6h.
    <Panel title="By session of the day, together">
      <SessionTable rows={r.bySession!} onOpen={(pick, title) => setOpenTrades({ key: `session:${pick.slotFrom}-${pick.slotTo}:${pick.method ?? ''}`, title, pick })} />
    </Panel>
  ) : null;
  const expiryDays = (
    <Panel title="By expiry day, together">
      <Table caption="Run together: by expiry day" first="Expiry day" rows={days} onCount={readTrades ? (day) => setOpenTrades({ key: day, pick: { day } }) : undefined} />
      {readTrades && <p className="m-0 mt-1 text-[12px] text-muted-foreground">Tap a day&apos;s trade count for its trades, one by one, each with whose it is.</p>}
    </Panel>
  );
  return (
    <>
      <div id="pf-summary" className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]">
        <Panel title={`Run together · ${title}`} foldKey="Run together">
          <p className="m-0 text-[13px] text-muted-foreground">
            {dayLabel(r.from)} → {dayLabel(r.to)} · {r.members.length} saved backtests,{' '}
            {r.shared
              ? <>traded as <b className="font-medium text-foreground">one account</b>: at most {r.shared.max} open together (CE {r.shared.ce} · PE {r.shared.pe}), the longer time frame first, as the desk takes them.</>
              : 'each worked as it is alone and added up.'}
          </p>
          {r.shared && r.shared.turnedAway > 0 && (
            <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">{count(r.shared.turnedAway)} signals found the account, or their side of it, full and were not traded.</p>
          )}
          {failed.map((m) => <p key={m.id} role="alert" className="m-0 mt-1 text-[12.5px] text-[var(--warn)]"><b className="font-semibold">{m.name}</b> is left out: {m.problem}</p>)}
          {t.n === 0 ? <div className="mt-2 grid gap-3"><Empty>None of them traded in this range.</Empty>{r.winPick && <WinPickResult pick={r.winPick} members={r.members} nameOf={(id) => id} />}</div> : (
            <>
              <div className={cn('mt-1 text-[26px] font-semibold tabular-nums', netClass(t.net))}>
                {moneyText(t.net)} <span className="text-[14px] font-medium text-muted-foreground">{each(t)} a trade</span>
              </div>
              <div className="mt-2">
                <Ledger>
                  <Entry label="Before charges" tone={t.net + t.charges > 0 ? 'up' : t.net + t.charges < 0 ? 'down' : undefined}>{moneyText(t.net + t.charges)}</Entry>
                  <Entry label="Charges" tone="down">{moneyText(-t.charges)}</Entry>
                  <Entry label="After charges" tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{moneyText(t.net)}</Entry>
                </Ledger>
              </div>
              <ChargesNote t={t} />
              {r.margin.peakUsd > 0 && (
                <>
                  <div className="mt-2">
                    <Ledger>
                      <Entry label="Margin at most, together">{moneyText(r.margin.peakUsd).replace('+', '')}</Entry>
                      <Entry label="On that margin" tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{`${t.net >= 0 ? '+' : '−'}${Math.abs((100 * t.net) / r.margin.peakUsd).toFixed(1)}%`}</Entry>
                      <Entry label="Each one's most, added">{moneyText(r.margin.sumOfPeaksUsd).replace('+', '')}</Entry>
                    </Ledger>
                  </div>
                  <p className="m-0 mt-1 px-1 text-[12px] leading-snug text-muted-foreground">
                    Their trades laid on one clock: the most held at once was {r.margin.peakOpen} trade{r.margin.peakOpen === 1 ? '' : 's'}
                    {r.margin.peakAt !== null ? ` at ${timeIst(r.margin.peakAt)}` : ''}{r.margin.peakDay ? ` on the ${dayLabel(r.margin.peakDay)} expiry` : ''}
                    {r.shared ? <> -- never more than the account&apos;s {r.shared.max}</> : ''} -- what running them side by side on one account would have needed, by the desk&apos;s 200x estimate.
                    It is under the sum of each one&apos;s own most where their busiest moments differ.
                    {marginWorking(r.margin) && <> <b className="font-medium text-foreground">The working:</b> {marginWorking(r.margin)}</>}
                    {!r.shared && r.margin.peakOpen > 0 && ' Each kept its own limit here, so more may be open together than one account would hold: choose One account to hold them to one limit.'}
                  </p>
                </>
              )}
              <div className="mt-2">
                <Stats cols={3}>
                  <Stat label="Trades">{count(t.n)}</Stat>
                  <Stat label="Won">{pct(rate(t), 0)}</Stat>
                  <Stat label="Profit factor">{t.lost > 0 ? (t.won / t.lost).toFixed(2) : '—'}</Stat>
                </Stats>
              </div>
              <DayAverages days={r.days} net={t.net} />
              <BacktestCurve days={r.days} />
              <WinnersLosers t={t} />
              {r.winPick && (
                <div className="mt-3">
                  <WinPickResult pick={r.winPick} members={r.members}
                    nameOf={(id) => r.breakdown?.byMethod.find((x) => x.key === id)?.name ?? id} />
                </div>
              )}
              <section aria-label="Each saved backtest" className="mt-3">
                <h3 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">Each one</h3>
                <Table caption="Run together: each saved backtest" first="Saved backtest" rows={members} />
              </section>
            </>
          )}
          {r.signals !== undefined && r.skipped && (
            <p className="m-0 mt-2 text-[12.5px] leading-snug text-muted-foreground">
              {count(r.signals)} signals went in the trade over all of them; {count(r.signals - notTraded)} were traded here.
              {notTraded > 0 && <> Not traded: {skippedParts(r.skipped, { byStrategy: false, run: true }).join(', ')}.</>}
            </p>
          )}
          {priced && <p className="m-0 mt-1.5 text-[12.5px] leading-snug text-muted-foreground">{priced}</p>}
        </Panel>
      </div>
      {t.n > 0 && (r.breakdown ? (
        <BacktestBreakdowns total={t} b={r.breakdown} wide={wide} idPrefix="pf" sessions={sessions} expiryDays={expiryDays}
          widen={widen} />
      ) : (
        // An older server sends no breakdowns: the sessions and the days, as before.
        <>
          {sessions && <div id="pf-sessions" className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]">{sessions}</div>}
          <div id="pf-days" className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]">{expiryDays}</div>
        </>
      ))}
      <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
        {r.shared
          ? 'They share the account’s places: a signal is taken while there is room, the longer time frame first. A signal two of them both take is traded twice, once by each, where there is room for both.'
          : 'One does not take a place from another: each has its own limits, as set in it. A signal two of them both take is traded twice, once by each.'}
      </p>
      {readTrades && <DayTradesSheet day={openTrades?.key ?? null} title={openTrades?.title} read={() => readTrades(openTrades!.pick)} onClose={() => setOpenTrades(null)} />}
    </>
  );
}

const NO_OVER: PortfolioOver = {};

/** Which saved backtests are run together, and what the run is called: a portfolio's name, or theirs. */
/**
 * A run together: which saved backtests, under what title, and when it was asked for -- every tap on Run (or Run
 * again) a new `at`, so it is asked again even when nothing in sight changed (19 Oct 2026: "after changing the methods,
 * Run again did nothing").
 */
export type TogetherRun = { ids: string[]; title: string; at?: number };

/**
 * What a run together was held to, when it is not each saved backtest's own (13 and 14 Oct 2026): the hours, and
 * any setting switched on over the run -- and which of them, worked by a strategy, kept that strategy's rules all
 * the same. Said over the result, so a total is never read as the saved backtests' own when they were changed for
 * the run; and said when nothing was, so "which settings was this?" is never open.
 */
function RunNote({ r }: { r: BacktestPortfolioResult }) {
  const h = r.hours ?? null, o = r.over ?? null;
  if (!h && !o) return <p className="m-0 px-1 text-[12.5px] leading-snug text-muted-foreground">Each saved backtest ran with its own hours and settings, as saved. Switch one on under For this run to try the same set with it.</p>;
  const hours = h ? (h.window === 'desk' ? '9:30 PM → 3:59 PM' : h.window === 'all' ? 'the whole expiry day' : `${time12(h.hoursFrom ?? '')} → ${time12(h.hoursTo ?? '')}`) : null;
  const settings = o ? overWords(o.settings) : [];
  const kept = new Set([...(h?.own ?? []), ...(o?.own ?? [])]);
  const own = r.members.filter((m) => kept.has(m.id)).map((m) => m.name);
  return (
    <div role="note" aria-label="What this run was held to" className="grid gap-1 rounded-md border border-[var(--chosen-line)] bg-[var(--chosen-soft)] px-3 py-2 text-[13px] leading-snug text-foreground">
      {hours && <p className="m-0">Signals of <b>{hours}</b> (IST) for this run, in place of each saved backtest&apos;s own hours.</p>}
      {settings.length > 0 && <p className="m-0">For this run, every one of them with: <b>{settings.join(' · ')}</b>.</p>}
      <p className="m-0 text-muted-foreground">
        Everything else is each saved backtest&apos;s own. Nothing saved is changed.
        {own.length > 0 && <> {own.join(', ')} {own.length === 1 ? 'is' : 'are'} worked by a strategy and kept {own.length === 1 ? 'its' : 'their'} strategy&apos;s own rules.</>}
      </p>
    </div>
  );
}

/**
 * The run together, where the results are shown: asked with the days on the screen, and again when they change.
 * Each one is a whole backtest, so the first run of a set takes a moment.
 */
export function PortfolioRun({ run, range, limit = 'shared', cap = null, hours = AS_SAVED, over = NO_OVER, wide = false, onClose, revision = '' }: {
  run: TogetherRun; range: { from: string; to: string }; limit?: PortfolioLimit;
  /** One account's limit as the screen shows it; null, the desk's own rule (the largest among the saved backtests). */
  cap?: PortfolioCap | null;
  /** The hours the run is held to: each saved backtest's own unless the screen chose others for the run. */
  hours?: PortfolioHours;
  /** The settings switched on over the run; none, each saved backtest's own. */
  over?: PortfolioOver;
  wide?: boolean; onClose: () => void;
  /**
   * What its saved backtests are now -- each one's id and when it last changed. A saved backtest changed (its methods
   * picked here, a pick kept on it) is a different run: asked again by itself, not left on the old answer.
   */
  revision?: string;
}) {
  const asked = limit === 'shared' ? cap : null;
  const hoursKey = hours.window === 'custom' ? `custom:${hours.hoursFrom}-${hours.hoursTo}` : hours.window;
  const askKey = `${run.ids.join(',')}|${run.at ?? 0}|${revision}|${range.from}|${range.to}|${limit}|${asked ? `${asked.max}/${asked.ce}/${asked.pe}` : ''}|${hoursKey}|${new URLSearchParams(overQuery(over))}`;
  // As the single backtest: asked once the run's settings stand still a moment -- each saved backtest in it is a whole backtest.
  const result = useAnswer(askKey, () => getBacktestPortfolio(run.ids, range, limit, asked, hours, over), 300_000, SETTLE_MS);
  if (result.error && !result.data) {
    return (
      <Panel title={`Run together · ${run.title}`}>
        <p role="alert" className="m-0 text-[13px] text-[var(--down)]">They could not be run together: {result.error.message}</p>
        <button type="button" className={cn(link, 'mt-1')} onClick={onClose}>Close</button>
      </Panel>
    );
  }
  if (!result.data) {
    return <Panel title={`Run together · ${run.title}`}><Loading error={null} what="the run together (each one is a whole backtest: a moment the first time)" /></Panel>;
  }
  return (
    <Updating busy={result.stale} failed={result.failed} what="the run together">
      <RunNote r={result.data} />
      {/* The jump bar, as over one backtest's result: only the parts there are. */}
      <ResultNav parts={RUN_PARTS} has={(id) => runHas(result.data!, id)} />
      <PortfolioResult title={run.title} r={result.data} wide={wide} readTrades={(pick) => getPortfolioTrades(pick, run.ids, range, limit, asked, hours, over)}
        widen={over.perpWiden && (over.perpWiden.slAtr > 0 || over.perpWiden.tgtAtr > 0) ? (
          <WidenCompare sl={over.perpWiden.slAtr} tgt={over.perpWiden.tgtAtr} askKey={askKey}
            ask={async (v) => {
              const a = await getBacktestPortfolio(run.ids, range, limit, asked, hours, { ...over, perpWiden: v ? { slAtr: v.slAtr, tgtAtr: v.tgtAtr, mode: v.mode } : { slAtr: 0, tgtAtr: 0 } });
              return { total: a.total, days: a.days };
            }} />
        ) : undefined} />
      {/* The same run beside the live desk (14 Oct 2026): its own question, so the hours and settings over the run are over the check. */}
      {/* The SL, delta and lots by volatility over the run's saved backtests (17 Oct 2026): each on its own signals, added up. */}
      <div id="pf-volsl" className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]">
        <VolStudy askKey={askKey} wide={wide} read={(a) => getPortfolioVolStudy(a, run.ids, range, limit, asked, hours, over)} readTrades={(a, pick) => getPortfolioVolStudyTrades(a, pick, run.ids, range, limit, asked, hours, over)} title="By volatility · SL, delta, lots · over the run" />
      </div>
      <div id="pf-live" className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]">
        <LiveCheck askKey={askKey} read={() => getPortfolioLiveCheck(run.title, run.ids, range, limit, asked, hours, over)} />
      </div>
      <button type="button" className={cn(link, 'justify-self-start')} onClick={onClose}>Close the run together</button>
    </Updating>
  );
}

/** When something was last changed, as people say it: "just now", "5 min ago", "3 h ago", "2 days ago", else the date. */
export function agoWords(ms: number, now: number): string {
  const s = Math.max(0, now - ms) / 1_000;
  if (s < 60) return 'just now';
  if (s < 3_600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)} h ago`;
  if (s < 7 * 86_400) { const d = Math.floor(s / 86_400); return `${d} day${d === 1 ? '' : 's'} ago`; }
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

/** A name as the desk keeps it: spaces tidied. Compared without capitals, as the desk compares them. */
const tidy = (n: string) => n.replace(/\s+/g, ' ').trim();
const takenWords = (kind: 'save' | 'portfolio', n: string) =>
  kind === 'save'
    ? `There is a saved backtest called "${tidy(n)}" already: give this one another name, or update that one.`
    : `There is a portfolio called "${tidy(n)}" already.`;

type Sort = 'name' | 'recent';
/** Which group the lists show: '*' every one, '' those in no group, else that group. */
type GroupPick = string;
const ALL = '*';

const iconBtn = 'm-0 grid h-9 w-9 shrink-0 appearance-none place-items-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
const small = 'h-9 min-w-0 rounded-md border border-solid border-border bg-[var(--bg)] px-2.5 text-[14px] text-foreground';
const chipCls = (on: boolean) => cn('m-0 h-8 shrink-0 appearance-none rounded-full border border-solid px-3 font-[inherit] text-[12.5px]',
  on ? 'border-[var(--chosen)] bg-[var(--chosen-soft)] text-foreground' : 'border-border bg-transparent text-muted-foreground');

export function SavedBacktests({ mode = 'single', current, wordsOf, onLoad, run, onRun, onSaves, wide = false }: {
  /**
   * Which of the screen's two sections this is in (owner, 13 Oct 2026: "the portfolio section or the backtest
   * section -- only one open at a time"). `single`: the saved backtests as a list to keep, put back on the screen,
   * edit, clone and delete. `portfolio`: the portfolios to run, edit, clone and delete, and the saved backtests as
   * ticks to run together or keep as a new one.
   */
  mode?: 'single' | 'portfolio';
  /** The settings on the screen now. */
  current: SavedQuery;
  /** A query in one line of words, as the screen's own settings line says it. */
  wordsOf: (q: SavedQuery) => string;
  /** Put a saved backtest's settings on the screen. */
  onLoad: (q: SavedQuery) => void;
  /** The run together on the screen, if any, and how one is started or closed: its results are the screen's to place (`PortfolioRun`). */
  run: TogetherRun | null;
  onRun: (run: TogetherRun | null) => void;
  /** Told the saved backtests whenever they are read: the screen works one account's default limit out from them. */
  onSaves?: (saves: BacktestSave[]) => void;
  /** A wide desk: the list is always open. On a phone it folds to one line (`listOpen`). */
  wide?: boolean;
}) {
  const [list, setList] = useState<BacktestSaves | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  // The group a new one is filed in (16 Oct 2026): blank is none.
  const [group, setGroup] = useState('');
  const [portfolioName, setPortfolioName] = useState('');
  // The saved one whose settings were last put on the screen: changed since, it can be updated in place.
  const [fromId, setFromId] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  // A delete asked about, before it is done: a saved backtest or a portfolio.
  const [asking, setAsking] = useState<{ kind: 'save' | 'portfolio'; id: string } | null>(null);
  /*
   * What is being edited, and its name as typed (owner, 13 Oct 2026: "edit a saved backtest, and edit a
   * portfolio"). A saved backtest: its settings are put on the screen to be changed there, its name and group
   * here. A portfolio: its members are ticked in the list to be changed there, and its name here. Nothing is kept
   * until Save changes; Cancel leaves it as it was.
   */
  const [editing, setEditing] = useState<{ kind: 'save' | 'portfolio'; id: string } | null>(null);
  const [editName, setEditName] = useState('');
  const [editGroup, setEditGroup] = useState('');
  /*
   * Finding one among many (16 Oct 2026, "user friendly"): a search over the names, groups and settings, the
   * order (by name or the last changed first), and which group is shown -- the last two kept in this browser.
   * Groups fold, and a group can be renamed (or emptied out) in one go.
   */
  const [search, setSearch] = useState('');
  const [sort, setSort] = usePersisted<Sort>('savedBacktests.sort', 'name');
  const [groupPick, setGroupPick] = usePersisted<GroupPick>('savedBacktests.group', ALL);
  const [closedGroups, setClosedGroups] = usePersisted<string[]>('savedBacktests.closedGroups', []);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  /*
   * On a phone the saved list folds to one line (owner, 14 Oct 2026: "the backtest screen, user friendly"): eight
   * saved backtests were 1,200px between the settings and the result. Kept as last left, in this browser.
   */
  const [listOpen, setListOpen] = usePersisted<boolean>('savedBacktests.listOpen.phone', false);
  const listShown = wide || listOpen;
  const setRun = onRun;
  const now = Date.now();

  const refresh = useCallback(() => getBacktestSaves().then((x) => { setList(x); setFailed(null); return x; }, (e: Error) => { setFailed(e.message); return null; }), []);
  useEffect(() => { void refresh(); }, [refresh]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (list) onSaves?.(list.saves); }, [list]);

  const saves = list?.saves ?? [];
  const portfolios = list?.portfolios ?? [];
  const shape = shapeOf(current);
  const shown = saves.find((s) => shapeOf(s.query) === shape) ?? null;
  const from = saves.find((s) => s.id === fromId) ?? null;
  const nameOf = (id: string) => saves.find((s) => s.id === id)?.name ?? 'a deleted one';
  const picked = ticked.filter((id) => saves.some((s) => s.id === id));
  // A name another one already has, any capitals -- said as it is typed, not after Save (16 Oct 2026: "no duplicate names").
  const savedNamed = (n: string, except?: string) => { const k = tidy(n).toLowerCase(); return k ? saves.find((s) => s.name.toLowerCase() === k && s.id !== except) ?? null : null; };
  const portfolioNamed = (n: string, except?: string) => { const k = tidy(n).toLowerCase(); return k ? portfolios.find((p) => p.name.toLowerCase() === k && p.id !== except) ?? null : null; };
  const groups = [...new Set(saves.map((s) => s.group ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const pick = groupPick === ALL || groupPick === '' || groups.includes(groupPick) ? groupPick : ALL;

  // The saved backtest whose methods are being picked in place (19 Oct 2026), if any.
  const [methodsOf, setMethodsOf] = useState<string | null>(null);
  const act = async (what: () => Promise<string>) => {
    setBusy(true); setSaid(null);
    try { const text = await what(); await refresh(); setSaid({ tone: 'ok', text }); }
    catch (e) { setSaid({ tone: 'bad', text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const keep = (id?: string) => act(async () => {
    const target = id ? saves.find((s) => s.id === id)! : null;
    const r = await saveBacktest({ ...(target ? { id: target.id, name: target.name } : { name, group: tidy(group) || null }), query: current });
    setFromId(r.save.id); setName('');
    return target ? `Updated "${r.save.name}" to the settings on the screen.` : `Saved as "${r.save.name}"${r.save.group ? ` in ${r.save.group}` : ''}.`;
  });
  const remove = (s: BacktestSave) => act(async () => {
    const r = await deleteBacktestSave(s.id);
    setTicked((t) => t.filter((x) => x !== s.id)); setAsking(null);
    if (editing?.kind === 'save' && editing.id === s.id) setEditing(null);
    if (run?.ids.includes(s.id)) setRun(null);
    return `Deleted "${s.name}".${r.portfoliosDeleted.length ? ` The portfolio${r.portfoliosDeleted.length === 1 ? '' : 's'} ${r.portfoliosDeleted.map((x) => `"${x}"`).join(', ')} had fewer than two left and went with it.` : ''}`;
  });
  const editedSave = editing?.kind === 'save' ? saves.find((s) => s.id === editing.id) ?? null : null;
  const editedPortfolio = editing?.kind === 'portfolio' ? portfolios.find((p) => p.id === editing.id) ?? null : null;
  const editSave = (s: BacktestSave) => { onLoad(s.query); setFromId(s.id); setEditing({ kind: 'save', id: s.id }); setEditName(s.name); setEditGroup(s.group ?? ''); setSaid(null); setAsking(null); };
  const editPortfolio = (p: { id: string; name: string; saveIds: string[] }) => { setTicked(p.saveIds); setEditing({ kind: 'portfolio', id: p.id }); setEditName(p.name); setSaid(null); setAsking(null); };
  // A copy, then straight to changing it (16 Oct 2026, "clone"): its settings on the screen and its name in the edit.
  const clone = (s: BacktestSave) => act(async () => {
    const r = await cloneBacktestSave(s.id);
    editSave(r.save);
    return `Cloned "${s.name}" as "${r.save.name}". Its settings are on the screen: change them and its name, then Save changes.`;
  });
  const clonePf = (p: { id: string; name: string }) => act(async () => {
    const r = await clonePortfolio(p.id);
    editPortfolio(r.portfolio);
    return `Cloned the portfolio "${p.name}" as "${r.portfolio.name}". Tick or untick to change what is in it, then Save changes.`;
  });
  const saveEdit = () => act(async () => {
    if (editedSave) {
      const r = await saveBacktest({ id: editedSave.id, name: editName, group: tidy(editGroup) || null, query: current });
      setEditing(null);
      return `Saved the changes to "${r.save.name}"${r.save.name !== editedSave.name ? ` (it was "${editedSave.name}")` : ''}.`;
    }
    const was = editedPortfolio!;
    const r = await savePortfolio({ id: was.id, name: editName, saveIds: picked });
    // A run of it on the screen is of what it is now.
    if (run?.title === was.name) setRun({ ids: r.portfolio.saveIds, title: r.portfolio.name });
    setEditing(null);
    return `Saved the changes to the portfolio "${r.portfolio.name}"${r.portfolio.name !== was.name ? ` (it was "${was.name}")` : ''}: ${r.portfolio.saveIds.length} saved backtests.`;
  });
  const keepPortfolio = () => act(async () => {
    const r = await savePortfolio({ name: portfolioName, saveIds: picked });
    setPortfolioName('');
    return `Kept as the portfolio "${r.portfolio.name}".`;
  });
  const renameGroup = () => renaming && act(async () => {
    const to = tidy(renaming.to) || null;
    const r = await renameBacktestGroup(renaming.from, to);
    setRenaming(null);
    if (pick === renaming.from) setGroupPick(to ?? ALL);
    return to ? `Renamed the group "${renaming.from}" to "${to}" (${r.moved} saved backtest${r.moved === 1 ? '' : 's'}).` : `Took the ${r.moved} saved backtest${r.moved === 1 ? '' : 's'} of "${renaming.from}" out of any group.`;
  });

  // The list as asked for: searched, the group picked, in the order picked -- in folders while every group is shown.
  const q = search.trim().toLowerCase();
  const matches = (s: BacktestSave) => !q || s.name.toLowerCase().includes(q) || (s.group ?? '').toLowerCase().includes(q) || wordsOf(s.query).toLowerCase().includes(q);
  const inPick = (s: BacktestSave) => pick === ALL || (pick === '' ? !s.group : s.group === pick);
  const ordered = [...saves].sort(sort === 'recent' ? (a, b) => b.updatedAt - a.updatedAt : (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const visible = ordered.filter((s) => matches(s) && inPick(s));
  const foldered = groups.length > 0 && pick === ALL && !q;
  const sections: { group: string | null; items: BacktestSave[] }[] = foldered
    ? [...groups.map((g) => ({ group: g as string | null, items: visible.filter((s) => s.group === g) })), { group: null, items: visible.filter((s) => !s.group) }].filter((x) => x.items.length > 0)
    : [{ group: null, items: visible }];
  const closed = new Set(Array.isArray(closedGroups) ? closedGroups : []);
  const toggleGroup = (g: string) => setClosedGroups(closed.has(g) ? [...closed].filter((x) => x !== g) : [...closed, g]);
  const tools = saves.length >= 4 || groups.length > 0;

  const single = mode === 'single';
  const deleteAsk = (kind: 'save' | 'portfolio', label: string, onYes: () => void) => (
    <span role="group" aria-label={`Delete ${label}?`} className="flex flex-wrap items-center justify-end gap-x-2 pt-1">
      <span className="text-[12.5px] text-muted-foreground">Delete?</span>
      <button type="button" disabled={busy} onClick={onYes} className="m-0 min-h-[36px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[13px] font-semibold text-[var(--down)]">Delete</button>
      <button type="button" onClick={() => setAsking(null)} className={link}>{kind === 'save' ? 'Keep' : 'Cancel'}</button>
    </span>
  );
  const savedRow = (s: BacktestSave) => (
    <li key={s.id} className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-0 border-t border-solid border-[var(--line-soft)] py-2 first:border-t-0', editedSave?.id === s.id && 'rounded-md bg-[var(--chosen-soft)] px-1.5')}>
      <div className="min-w-0">
        <button type="button" aria-label={`Run ${s.name}`} aria-current={shown?.id === s.id ? 'true' : undefined}
          onClick={() => { onLoad(s.query); setFromId(s.id); setSaid(null); }}
          className="m-0 min-h-[44px] w-full min-w-0 appearance-none border-0 bg-transparent p-0 text-left font-[inherit]">
          <span className={cn('block text-[14px] font-semibold [overflow-wrap:anywhere]', shown?.id === s.id ? 'text-[var(--chosen)]' : 'text-foreground')}>{s.name}{shown?.id === s.id ? ' · on the screen' : ''}</span>
          <span title={wordsOf(s.query)} className="block text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [display:-webkit-box]">{wordsOf(s.query)}</span>
        </button>
        <p className="m-0 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--dim)]">
          {!foldered && s.group && <span className="rounded-full border border-solid border-border px-2 py-px text-muted-foreground">{s.group}</span>}
          <span title={new Date(s.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}>Changed {agoWords(s.updatedAt, now)}</span>
        </p>
      </div>
      {asking?.kind === 'save' && asking.id === s.id ? deleteAsk('save', s.name, () => void remove(s)) : (
        <span className="flex items-center">
          <button type="button" aria-label={`Edit ${s.name}`} title="Edit: its settings on the screen, its name and group here" aria-pressed={editedSave?.id === s.id} onClick={() => editSave(s)} className={cn(iconBtn, editedSave?.id === s.id && 'bg-muted text-foreground')}><Pencil size={16} aria-hidden /></button>
          <button type="button" aria-label={`Clone ${s.name}`} title="Clone: a copy to change" disabled={busy} onClick={() => void clone(s)} className={iconBtn}><Copy size={16} aria-hidden /></button>
          <button type="button" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => setAsking({ kind: 'save', id: s.id })} className={cn(iconBtn, 'hover:text-[var(--down)]')}><Trash2 size={16} aria-hidden /></button>
        </span>
      )}
    </li>
  );
  /** In the portfolio section a saved backtest is a tick: the whole row is the box's own label. */
  const tickRow = (s: BacktestSave) => {
    const on = picked.includes(s.id);
    return (
      <li key={s.id} className="border-0 border-t border-solid border-[var(--line-soft)] first:border-t-0">
        <label className={cn('grid min-h-[44px] cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 rounded-md px-1 py-2', on && 'bg-[var(--chosen-soft)]')}>
          <input type="checkbox" checked={on} aria-label={`Run ${s.name} together with others`} disabled={!on && picked.length >= 12}
            onChange={() => setTicked((t) => (t.includes(s.id) ? t.filter((x) => x !== s.id) : [...t, s.id]))}
            className="mt-0.5 h-5 w-5 accent-[var(--chosen)]" />
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold [overflow-wrap:anywhere]">{s.name}{!foldered && s.group ? <span className="ml-1.5 text-[11.5px] font-normal text-[var(--dim)]">· {s.group}</span> : null}</span>
            {/* Two lines on a phone: eight of these at five lines each were a screen and a half between Run and its result. All of it on a wider screen, and in the title. */}
            <span title={wordsOf(s.query)} className="block text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere] max-sm:overflow-hidden max-sm:[-webkit-box-orient:vertical] max-sm:[-webkit-line-clamp:2] max-sm:[display:-webkit-box]">{wordsOf(s.query)}</span>
          </span>
        </label>
        {/* Its methods picked here, by their record -- the Win tab included -- and kept on it (19 Oct 2026). A strategy's are the strategy's. */}
        {s.query.strategy === null && (methodsOf === s.id
          ? <SavedMethodsPicker save={s} busy={busy} onClose={() => setMethodsOf(null)}
              onUpdate={(methods) => void act(async () => {
                await saveBacktest({ id: s.id, name: s.name, query: { ...s.query, methods } });
                setMethodsOf(null);
                return methods.length ? `Kept ${methods.length} method${methods.length === 1 ? '' : 's'} on "${s.name}".` : `"${s.name}" takes every method now.`;
              })} />
          : (
            <button type="button" aria-label={`Methods of ${s.name}`} onClick={() => setMethodsOf(s.id)}
              className="m-0 mb-1.5 ml-8 min-h-[32px] appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12.5px] text-[var(--accent)] underline underline-offset-2">
              Methods · {s.query.methods.length ? `${s.query.methods.length} picked` : 'every method'} — pick by win %
            </button>
          ))}
      </li>
    );
  };
  /** The list in its folders: a group a heading that folds, renamed in place, ticked whole in the portfolio section. */
  const listOf = (row: (s: BacktestSave) => React.ReactNode) => (
    <div className="grid min-w-0 gap-1">
      {sections.map((sec) => {
        if (!foldered) return <ul key="flat" aria-label="Saved backtests" className="m-0 grid list-none gap-0 p-0">{sec.items.map(row)}</ul>;
        const g = sec.group ?? '';
        const label = sec.group ?? 'No group';
        const isClosed = closed.has(g);
        const ids = sec.items.map((x) => x.id);
        const allTicked = ids.every((id) => picked.includes(id));
        return (
          <section key={label} aria-label={`Group ${label}`} className="min-w-0 rounded-md border border-solid border-[var(--line-soft)]">
            <div className="flex min-w-0 items-center gap-1 pr-1">
              <button type="button" aria-expanded={!isClosed} onClick={() => toggleGroup(g)}
                className="m-0 flex min-h-[40px] min-w-0 flex-1 appearance-none items-center gap-1.5 border-0 bg-transparent px-2 text-left font-[inherit] text-[13px] font-semibold text-foreground">
                <ChevronDown size={15} aria-hidden className={cn('shrink-0 text-muted-foreground transition-transform', isClosed && '-rotate-90')} />
                <FolderOpen size={15} aria-hidden className="shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
                <span className="shrink-0 text-[12px] font-normal text-muted-foreground">{sec.items.length}</span>
              </button>
              {!single && (
                <button type="button" className={cn(link, 'px-1 text-[12.5px]')} aria-label={`${allTicked ? 'Untick' : 'Tick'} every one in ${label}`}
                  onClick={() => setTicked((t) => (allTicked ? t.filter((x) => !ids.includes(x)) : [...new Set([...t, ...ids])].slice(0, 12)))}>
                  {allTicked ? 'Untick all' : 'Tick all'}
                </button>
              )}
              {single && sec.group && (
                <button type="button" aria-label={`Rename the group ${label}`} title="Rename the group" onClick={() => setRenaming({ from: sec.group!, to: sec.group! })} className={iconBtn}><Pencil size={14} aria-hidden /></button>
              )}
            </div>
            {renaming?.from === sec.group && (
              <form aria-label={`Rename the group ${label}`} className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 pb-2" onSubmit={(e) => { e.preventDefault(); if (!busy) void renameGroup(); }}>
                <input value={renaming.to} onChange={(e) => setRenaming({ ...renaming, to: e.target.value })} maxLength={40} aria-label="New name of the group" className={cn(small, 'flex-1 basis-40')} placeholder="Blank: take them out of any group" />
                <button type="submit" disabled={busy || tidy(renaming.to) === renaming.from} className={cn(solid, 'h-9')}>Rename</button>
                <button type="button" className={cn(quiet, 'h-9')} onClick={() => setRenaming(null)}>Cancel</button>
              </form>
            )}
            {!isClosed && <ul aria-label={`Saved backtests in ${label}`} className="m-0 grid list-none gap-0 px-1.5 p-0">{sec.items.map(row)}</ul>}
          </section>
        );
      })}
      {visible.length === 0 && saves.length > 0 && (
        <p className="m-0 rounded-md bg-muted px-3 py-2 text-[12.5px] text-muted-foreground">
          Nothing matches{q ? ` "${search.trim()}"` : ''}{pick !== ALL ? ` in ${pick || 'no group'}` : ''}.{' '}
          <button type="button" className={cn(link, 'min-h-0')} onClick={() => { setSearch(''); setGroupPick(ALL); }}>Show every one</button>
        </p>
      )}
    </div>
  );
  /** The search, the order and the group: once there are enough to look for one. */
  const toolbar = tools && (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <label className="relative min-w-0 flex-1 basis-44">
          <Search size={15} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search the saved backtests"
            placeholder="Search" className={cn(small, 'w-full pl-8')} />
        </label>
        <select aria-label="Order the saved backtests" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={cn(small, 'shrink-0 [color-scheme:dark]')}>
          <option value="name">A–Z</option>
          <option value="recent">Last changed first</option>
        </select>
      </div>
      {groups.length > 0 && (
        <div role="group" aria-label="Which group" className="flex min-w-0 flex-wrap gap-1">
          <button type="button" aria-pressed={pick === ALL} onClick={() => setGroupPick(ALL)} className={chipCls(pick === ALL)}>All {saves.length}</button>
          {groups.map((g) => (
            <button key={g} type="button" aria-pressed={pick === g} onClick={() => setGroupPick(g)} className={chipCls(pick === g)}>{g} {saves.filter((s) => s.group === g).length}</button>
          ))}
          {saves.some((s) => !s.group) && <button type="button" aria-pressed={pick === ''} onClick={() => setGroupPick('')} className={chipCls(pick === '')}>No group {saves.filter((s) => !s.group).length}</button>}
        </div>
      )}
    </div>
  );
  const groupField = (value: string, onChange: (v: string) => void, label: string) => (
    <label className="grid min-w-0 gap-1">
      <span className="text-[12px] text-muted-foreground">Group <span className="text-[var(--dim)]">· optional</span></span>
      <input value={value} onChange={(e) => onChange(e.target.value)} maxLength={40} aria-label={label} list="saved-backtest-groups"
        placeholder={groups.length ? `e.g. ${groups[0]}` : 'e.g. 80% Win'} className={field} />
    </label>
  );
  const saidLine = said && <p role={said.tone === 'bad' ? 'alert' : 'status'} className={cn('m-0 text-[13px]', said.tone === 'bad' ? 'text-[var(--down)]' : 'text-[var(--up)]')}>{said.text}</p>;
  const howMany = single
    ? `${saves.length} saved${groups.length ? ` · ${groups.length} group${groups.length === 1 ? '' : 's'}` : ''}`
    : `${portfolios.length} portfolio${portfolios.length === 1 ? '' : 's'} · ${saves.length} saved backtest${saves.length === 1 ? '' : 's'}`;
  const newTaken = savedNamed(name);
  const editTaken = editedSave ? savedNamed(editName, editedSave.id) : editedPortfolio ? portfolioNamed(editName, editedPortfolio.id) : null;
  const pfTaken = portfolioNamed(portfolioName);

  return (
      <Panel title={single ? 'Saved backtests' : 'Portfolios'} right={<span className="text-[11.5px] text-muted-foreground">{howMany}</span>}>
        <datalist id="saved-backtest-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        {failed && !list ? <p role="alert" className="m-0 text-[13px] text-[var(--down)]">The saved backtests could not be read: {failed}</p> : !list ? <Loading error={null} what="the saved backtests" /> : single ? (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            {/* Keep what is on the screen -- or, while a saved one is edited, the changes to it. */}
            {editedSave ? (
              <form aria-label={`Edit ${editedSave.name}`} className="grid gap-1.5 rounded-md border border-solid border-[var(--accent)] px-2.5 py-2"
                onSubmit={(e) => { e.preventDefault(); if (editName.trim() && !busy && !editTaken) void saveEdit(); }}>
                <p className="m-0 text-[13px] leading-snug">
                  Editing <b className="font-semibold">{editedSave.name}</b>. Its settings are on the screen: change them there, and its name and group here.
                </p>
                <div className="grid min-w-0 gap-1.5">
                  <label className="grid min-w-0 gap-1">
                    <span className="text-[12px] text-muted-foreground">Name</span>
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={60} aria-label="Name of the saved backtest" aria-invalid={editTaken ? true : undefined} className={cn(field, editTaken && 'border-[var(--down)]')} />
                  </label>
                  {groupField(editGroup, setEditGroup, 'Group of the saved backtest')}
                </div>
                {editTaken && <p role="alert" className="m-0 text-[12.5px] text-[var(--down)]">{takenWords('save', editName)}</p>}
                <p className="m-0 text-[12px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
                  {shapeOf(editedSave.query) === shape
                    ? 'Settings unchanged so far.'
                    : <>
                      <span className="block"><b className="font-medium text-[var(--warn)]">Settings changed.</b> {`Saved: ${wordsOf(editedSave.query)}`}</span>
                      <span className="block text-foreground">{`It will be: ${wordsOf(current)}`}</span>
                    </>}
                </p>
                <span className="flex gap-2">
                  <button type="submit" disabled={!editName.trim() || busy || Boolean(editTaken) || (shapeOf(editedSave.query) === shape && tidy(editName) === editedSave.name && (tidy(editGroup) || null) === (editedSave.group ?? null))} className={cn(solid, 'flex-1')}>Save changes</button>
                  <button type="button" className={quiet} onClick={() => { setEditing(null); setSaid(null); }}>Cancel</button>
                </span>
              </form>
            ) : shown ? (
              <p className="m-0 text-[13px] text-muted-foreground">The settings on the screen are saved as <b className="font-semibold text-foreground">{shown.name}</b>.</p>
            ) : (
              <form aria-label="Save the settings on the screen" className="grid gap-1.5" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy && !newTaken) void keep(); }}>
                <label className="grid min-w-0 gap-1">
                  <span className="text-[12px] text-muted-foreground">Save the settings on the screen as</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Name for the saved backtest" aria-invalid={newTaken ? true : undefined}
                    placeholder="A name, e.g. 1h delta 0.10, dynamic target" className={cn(field, newTaken && 'border-[var(--down)]')} />
                </label>
                {newTaken && (
                  <p role="alert" className="m-0 text-[12.5px] leading-snug text-[var(--down)]">
                    {takenWords('save', name)}{' '}
                    <button type="button" disabled={busy} onClick={() => void keep(newTaken.id)} className={cn(link, 'min-h-0 text-[12.5px]')}>Update “{newTaken.name}” to these settings instead</button>
                  </p>
                )}
                <div className="flex min-w-0 items-end gap-2">
                  <div className="min-w-0 flex-1">{groupField(group, setGroup, 'Group for the saved backtest')}</div>
                  <button type="submit" disabled={!name.trim() || busy || Boolean(newTaken)} className={cn(solid, 'px-6')}>Save</button>
                </div>
                {from && (
                  <button type="button" disabled={busy} onClick={() => void keep(from.id)} className={cn(link, 'justify-self-start text-left')}>
                    Or update “{from.name}” to these settings
                  </button>
                )}
              </form>
            )}
            {saidLine}
            {saves.length === 0
              ? <Empty>Nothing saved yet. Set the backtest up as you want it, give it a name and Save: it can be run again in one tap, cloned to try a change, and several run together under Portfolio.</Empty>
              : listShown ? <>{toolbar}{listOf(savedRow)}</> : null}
            {!wide && saves.length > 0 && (
              <button type="button" aria-expanded={listOpen} onClick={() => setListOpen((v) => !v)}
                className="m-0 min-h-[44px] w-full appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[13.5px] font-medium text-foreground">
                {listOpen ? 'Hide the saved list' : `Show the ${saves.length} saved${shown ? ` · ${shown.name} is on the screen` : ''}`}
              </button>
            )}
          </div>
        ) : (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            {saidLine}
            {/* The portfolios kept, first: one tap runs one. */}
            {portfolios.length > 0 && (
              <ul aria-label="Portfolios" className="m-0 grid list-none gap-1.5 p-0">
                {portfolios.map((p) => {
                  const on = run !== null && run.title === p.name;
                  return (
                    <li key={p.id} className={cn('grid min-w-0 gap-1.5 rounded-md border border-solid px-2.5 py-2', on ? 'border-[var(--chosen)] bg-[var(--chosen-soft)]' : 'border-[var(--line-soft)]', editedPortfolio?.id === p.id && 'border-[var(--accent)]')}>
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className={cn('block text-[14px] font-semibold [overflow-wrap:anywhere]', on && 'text-[var(--chosen)]')}>{p.name}{on ? ' · running' : ''}</span>
                          <span className="block text-[11.5px] text-[var(--dim)]">{p.saveIds.length} saved backtests · changed {agoWords(p.updatedAt, now)}</span>
                        </span>
                        <button type="button" aria-label={`Run the portfolio ${p.name}`} className={cn(on ? quiet : solid, 'h-9')} onClick={() => setRun({ ids: p.saveIds, title: p.name })}>{on ? 'Run again' : 'Run'}</button>
                      </div>
                      {/* Its members, each a chip: what is in it at a glance. */}
                      <ul aria-label={`In ${p.name}`} className="m-0 flex min-w-0 list-none flex-wrap gap-1 p-0">
                        {p.saveIds.map((id) => <li key={id} className="max-w-full truncate rounded-full border border-solid border-border px-2 py-0.5 text-[11.5px] text-muted-foreground">{nameOf(id)}</li>)}
                      </ul>
                      {asking?.kind === 'portfolio' && asking.id === p.id
                        ? deleteAsk('portfolio', `the portfolio ${p.name}`, () => void act(async () => { await deletePortfolio(p.id); setAsking(null); if (run?.title === p.name) setRun(null); if (editedPortfolio?.id === p.id) setEditing(null); return `Deleted the portfolio "${p.name}". Its saved backtests are kept.`; }))
                        : (
                          <span className="flex items-center justify-end gap-0.5">
                            <button type="button" aria-label={`Edit the portfolio ${p.name}`} title="Edit: tick what is in it, change its name" aria-pressed={editedPortfolio?.id === p.id} onClick={() => editPortfolio(p)} className={cn(iconBtn, editedPortfolio?.id === p.id && 'bg-muted text-foreground')}><Pencil size={16} aria-hidden /></button>
                            <button type="button" aria-label={`Clone the portfolio ${p.name}`} title="Clone: a copy to change" disabled={busy} onClick={() => void clonePf(p)} className={iconBtn}><Copy size={16} aria-hidden /></button>
                            <button type="button" aria-label={`Delete the portfolio ${p.name}`} title="Delete" disabled={busy} onClick={() => setAsking({ kind: 'portfolio', id: p.id })} className={cn(iconBtn, 'hover:text-[var(--down)]')}><Trash2 size={16} aria-hidden /></button>
                          </span>
                        )}
                    </li>
                  );
                })}
              </ul>
            )}
            {saves.length < 2 ? (
              <Empty>A portfolio is two saved backtests or more, run together. Save them under Single backtest first{saves.length === 1 ? ' -- there is one so far' : ''}.</Empty>
            ) : (
              <section aria-label="Saved backtests to run together" className="grid gap-1.5">
                <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">{editedPortfolio ? `In “${editedPortfolio.name}”` : portfolios.length ? 'Or tick saved backtests' : 'Tick saved backtests'}</h3>
                {toolbar}
                {listOf(tickRow)}
              </section>
            )}
            {/* A portfolio being edited: its members are the ticks above, its name here. */}
            {editedPortfolio && (
              <form aria-label={`Edit the portfolio ${editedPortfolio.name}`} className="grid gap-1.5 rounded-md border border-solid border-[var(--accent)] px-2.5 py-2"
                onSubmit={(e) => { e.preventDefault(); if (editName.trim() && picked.length >= 2 && !busy && !editTaken) void saveEdit(); }}>
                <p className="m-0 text-[13px] leading-snug">
                  Editing the portfolio <b className="font-semibold">{editedPortfolio.name}</b>. Tick or untick the saved backtests above to change what is in it, and its name here.
                </p>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={60} aria-label="Name of the portfolio" aria-invalid={editTaken ? true : undefined} className={cn(field, editTaken && 'border-[var(--down)]')} />
                {editTaken && <p role="alert" className="m-0 text-[12.5px] text-[var(--down)]">{takenWords('portfolio', editName)}</p>}
                <p role={picked.length < 2 ? 'alert' : undefined} className={cn('m-0 text-[12px] leading-snug [overflow-wrap:anywhere]', picked.length < 2 ? 'text-[var(--down)]' : 'text-muted-foreground')}>
                  {picked.length < 2 ? 'A portfolio is two saved backtests or more: tick another.' : `In it: ${picked.map(nameOf).join(' + ')}.`}
                </p>
                <span className="flex gap-2">
                  <button type="submit" disabled={!editName.trim() || picked.length < 2 || busy || Boolean(editTaken) || (tidy(editName) === editedPortfolio.name && picked.join(',') === editedPortfolio.saveIds.join(','))} className={cn(solid, 'flex-1')}>Save changes</button>
                  <button type="button" className={quiet} onClick={() => { setEditing(null); setTicked([]); setSaid(null); }}>Cancel</button>
                </span>
              </form>
            )}
            {/* Two or more ticked: run them together, and keep the set. */}
            {saves.length >= 2 && !editedPortfolio && (
              <div className="grid gap-2 rounded-md bg-muted px-2.5 py-2">
                <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">
                  {picked.length < 2 ? 'Tick two or more to run them together and see what they come to as one.' : `${picked.length} ticked: ${picked.map(nameOf).join(', ')}.`}
                  {picked.length > 0 && <> <button type="button" className={cn(link, 'min-h-0 text-[12.5px]')} onClick={() => setTicked([])}>Untick all</button></>}
                </p>
                {picked.length >= 2 && (
                  <>
                    <button type="button" className={cn(solid, 'w-full')} onClick={() => setRun({ ids: picked, title: picked.map(nameOf).join(' + ') })}>Run these {picked.length} together</button>
                    <span className="text-[12px] text-muted-foreground">Or keep these {picked.length} as a portfolio, to run again in one tap:</span>
                    <form className="flex min-w-0 gap-2" onSubmit={(e) => { e.preventDefault(); if (portfolioName.trim() && !busy && !pfTaken) void keepPortfolio(); }}>
                      <input value={portfolioName} onChange={(e) => setPortfolioName(e.target.value)} maxLength={60} aria-label="Name for the portfolio" aria-invalid={pfTaken ? true : undefined} placeholder="Portfolio name" className={cn(field, pfTaken && 'border-[var(--down)]')} />
                      <button type="submit" disabled={!portfolioName.trim() || busy || Boolean(pfTaken)} className={quiet}>Keep</button>
                    </form>
                    {pfTaken && <p role="alert" className="m-0 text-[12.5px] text-[var(--down)]">{takenWords('portfolio', portfolioName)}</p>}
                  </>
                )}
              </div>
            )}

          </div>
        )}
      </Panel>
  );
}
