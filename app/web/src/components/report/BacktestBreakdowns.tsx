import { useState, type ReactNode } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import { pct } from '@/lib/format';
import { moneyText, ptsText } from '@/lib/market-report';
import type { PairStat } from '@/lib/method-pairs';
import { cn } from '@/lib/utils';
import type { BacktestParams, BoardGrain, BtExit, BtRow, BtSkip, BtTot, SignalBacktestResponse } from '@/types/signal-backtest';
import { Panel, Segmented, Stat, Stats } from '@/components/mobile/parts';
import { PairList } from '@/components/mobile/PairList';
import { Entry, FOLD, Ledger, Table, count, netClass, rate } from '@/components/report/backtest-parts';
import { PerpVsOptions } from '@/components/report/PerpVsOptions';

/**
 * A result broken down, the same for one backtest and for saved backtests run together (owner, 17 Oct 2026: "the
 * backtest's output screen and the portfolio's do not match -- best practice, user friendly"): when the perp's SL was
 * hit, which exit closed the trades, volatility at the fill, time frames, the best and worst
 * pairs, every method, and the kind of day. Each part a panel of its own, folded and opened as the rest; the parts that
 * differ -- the sessions and the expiry days -- are the caller's, put in their places.
 */

/** What a result is broken down by (server `BtBreakdown`): one backtest's own fields, and a run together's `breakdown`. */
export type Breakdown = Pick<SignalBacktestResponse, 'pairs' | 'byTf' | 'byMethod' | 'byPattern' | 'byFamily' | 'byVol'>;

export const EXITS: { key: BtExit; label: string }[] = [
  { key: 'perp-tgt', label: 'Perp TGT' }, { key: 'perp-sl', label: 'Perp SL' }, { key: 'option-tgt', label: 'Option TGT' },
  { key: 'option-sl', label: 'Option SL' }, { key: 'option-tsl', label: 'Option TSL' }, { key: 'option-be', label: 'Option SL at entry' }, { key: 'window-end', label: 'Window end' },
];

/**
 * The parts of a result to jump to (owner, 16 Oct 2026: "on a phone the result runs to a dozen screens"): kept at the
 * top while the result is scrolled, sideways where it does not fit. Only the parts on the screen are offered.
 */
export function ResultNav({ parts, has }: { parts: readonly { id: string; label: string }[]; has: (id: string) => boolean }) {
  const shown = parts.filter((x) => has(x.id));
  return (
    <nav aria-label="Jump to a part of the result" className="sticky top-0 z-10 -mx-1 flex gap-1.5 overflow-x-auto bg-[var(--bg)] px-1 py-1.5">
      {shown.map((x) => (
        <button key={x.id} type="button" onClick={() => document.getElementById(x.id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
          className="m-0 h-9 shrink-0 appearance-none whitespace-nowrap rounded-full border border-solid border-border bg-transparent px-3 font-[inherit] text-[13px] font-medium text-foreground">
          {x.label}
        </button>
      ))}
    </nav>
  );
}

/** Every method as options, across its timeframes: those in profit and those in loss, ten of each to begin with. */
export function MethodsAsOptions({ rows, wide }: { rows: readonly BtRow[]; wide: boolean }) {
  const [all, setAll] = useState(false);
  const traded = rows.filter((m) => m.n > 0);
  const best = traded.filter((m) => m.net > 0).sort((a, b) => b.net - a.net);
  const worst = traded.filter((m) => m.net < 0).sort((a, b) => a.net - b.net);
  const FIRST = 10;
  return (
    <Panel title="By method" right={<span className="text-[11.5px] text-muted-foreground">{traded.length} traded</span>}>
      <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4', wide && 'lg:grid-cols-2')}>
        <section aria-label="Methods in profit as options">
          <h3 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">In profit · {best.length}</h3>
          <Table caption="Backtest: methods in profit" first="Method" rows={all ? best : best.slice(0, FIRST)} perp />
        </section>
        <section aria-label="Methods in loss as options">
          <h3 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">In loss · {worst.length}</h3>
          <Table caption="Backtest: methods in loss" first="Method" rows={all ? worst : worst.slice(0, FIRST)} perp />
        </section>
      </div>
      {(best.length > FIRST || worst.length > FIRST) && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all}
          className="mt-2 min-h-[40px] w-full rounded-md border-0 bg-muted font-[inherit] text-[13px] font-medium text-foreground">
          {all ? `Show the first ${FIRST} of each` : `Show all ${traded.length} methods`}
        </button>
      )}
    </Panel>
  );
}

const pairOf = (r: BtRow): PairStat => ({
  key: r.key, name: r.name, tf: r.tf ?? '', trades: r.n, wins: r.wins, losses: r.losses,
  winRate: rate(r), profitFactor: r.lost > 0 ? r.won / r.lost : null, net: r.net,
});

/** A day's pricing in a word, beside its name. */
export const GRAIN: Record<BoardGrain, string> = { 'own-1m': '1m prices', 'mark-1m': '1m est.', '5m': '5m prices' };

/** What the options were priced on, in a sentence: said only when the server says it. */
export function pricedWords(p: Record<BoardGrain, number> | undefined): string | null {
  if (!p) return null;
  const own = p['own-1m'] ?? 0, mark = p['mark-1m'] ?? 0, five = p['5m'] ?? 0, all = own + mark + five;
  if (all === 0) return null;
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const fine = [own ? `${days(own)} on the desk's own 1-minute record` : null, mark ? `${days(mark)} on Delta's 1-minute mark with the desk's recorded spread (an estimate)` : null].filter(Boolean).join(', ');
  if (five === 0) return `Option prices a minute at a time: ${fine}.`;
  const rest = `${days(five)} on 5-minute prices -- a day still running, or one whose 1-minute prices are still being fetched from Delta`;
  return fine ? `Option prices a minute at a time on ${own + mark} of ${days(all)}: ${fine}. The other ${rest}.` : `Option prices: ${rest}.`;
}

/**
 * Why the signals not traded were not, a phrase each, in the order the backtest checks them. `run`: of saved
 * backtests run together, said of all of them; else of one backtest's own settings (or its strategy's, `byStrategy`).
 */
export function skippedParts(sk: Partial<Record<BtSkip, number>>, o: { byStrategy: boolean; params?: Partial<BacktestParams>; floor?: number; run?: boolean }): string[] {
  const p = o.params ?? {}, n = (k: BtSkip) => sk[k] ?? 0;
  const floor = o.floor ?? 0;
  return [
    n('outside-window') ? `${count(n('outside-window'))} outside ${o.run ? 'their hours' : o.byStrategy ? 'its days and hours' : 'the hours chosen'}` : null,
    n('no-entry-window') ? `${count(n('no-entry-window'))} inside ${o.run ? 'a' : 'its'} no-entry window` : null,
    n('distance') ? `${count(n('distance'))} with the SL or TGT outside ${o.run ? 'their range' : o.byStrategy ? 'its distances' : 'the range set'}` : null,
    n('volatility') ? `${count(n('volatility'))} not in ${o.run ? 'the volatility asked for' : `${p.vol ?? 'that'} volatility`}` : null,
    n('at-limit') ? `${count(n('at-limit'))} while ${o.run ? 'that one' : 'it'} already had its most open` : null,
    n('desk-limit') ? `${count(n('desk-limit'))} while ${o.run ? 'the account was full' : `${p.deskMax} were open`} (at most open)` : null,
    n('side-limit') ? `${count(n('side-limit'))} while that side was at its CE / PE max` : null,
    n('no-strike') ? `${count(n('no-strike'))} with no strike inside the rule${o.run || o.byStrategy ? ' worth its floor' : floor > 0 ? ` worth $${floor}` : ''}` : null,
    n('no-board') ? `${count(n('no-board'))} with no option prices recorded then` : null,
    n('no-exit-price') ? `${count(n('no-exit-price'))} with no price to exit at` : null,
  ].filter((x): x is string => x !== null);
}

/** What the charges were, in a line under the ledger: the same words for one backtest and a run together. */
export function ChargesNote({ t }: { t: BtTot }) {
  return (
    <p className="m-0 mt-1 px-1 text-[12px] text-muted-foreground">
      Charges: Delta&apos;s fee on each fill (the lower of 0.01% of the BTC value and 3.5% of the premium) and 18% GST on it, on the sale and on the buy-back -- {t.n > 0 ? moneyText(-t.charges / t.n) : '—'} a trade, {t.net + t.charges !== 0 ? `${Math.round((100 * t.charges) / Math.abs(t.net + t.charges))}% of the result before them` : ''}.
    </p>
  );
}

/** A day, on average (owner, 13 Oct 2026): over the expiry days that traded, and the days in profit and in loss each on their own. */
export function DayAverages({ days, net }: { days: readonly { n: number; net: number }[]; net: number }) {
  const traded = days.filter((d) => d.n > 0);
  if (traded.length === 0) return null;
  const up = traded.filter((d) => d.net > 0), down = traded.filter((d) => d.net < 0);
  const mean = (xs: typeof traded) => xs.reduce((a, d) => a + d.net, 0) / xs.length;
  const words = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  return (
    <div className="mt-2">
      <Ledger>
        <Entry label={`A day, on average · ${words(traded.length)}`} tone={net > 0 ? 'up' : net < 0 ? 'down' : undefined}>{moneyText(net / traded.length)}</Entry>
        <Entry label={`A day in profit · ${words(up.length)}`} tone="up">{up.length ? moneyText(mean(up)) : '—'}</Entry>
        <Entry label={`A day in loss · ${words(down.length)}`} tone="down">{down.length ? moneyText(mean(down)) : '—'}</Entry>
      </Ledger>
    </div>
  );
}

/** What the winners made and the losers lost, two to a row (six-figure rupees do not fit a third of a phone), and the same trades on the perp. */
export function WinnersLosers({ t }: { t: BtTot }) {
  return (
    <>
      <div className="mt-2">
        <Stats cols={2}>
          <Stat label="Winners made" tone="up">{moneyText(t.won)}</Stat>
          <Stat label="Losers lost" tone="down">{moneyText(-t.lost)}</Stat>
        </Stats>
      </div>
      <p className="m-0 mt-2 text-[13px]">
        <span className="text-muted-foreground">The same trades on the perp: </span>
        <b className={cn('font-semibold tabular-nums', netClass(t.perpPts))}>{ptsText(t.perpPts)}</b>
      </p>
    </>
  );
}

export function BacktestBreakdowns({ total: t, b, wide, idPrefix, sessions, expiryDays, widen }: {
  total: BtTot; b: Breakdown; wide: boolean;
  /** What the parts' ids begin with, for the jump bar: `bt` for one backtest, `pf` for a run together. */
  idPrefix: string;
  /** The caller's own: the sessions panel, and the expiry days panel beside the kind of day. */
  sessions?: ReactNode; expiryDays?: ReactNode;
  /** The perp levels three ways (`WidenCompare`), where widening is on: the caller's, as it knows how to ask again. */
  widen?: ReactNode;
}) {
  const [grouping, setGrouping] = usePersisted<'kind' | 'family'>('signalBacktest.grouping', 'family');
  const sl = t.exits['perp-sl'], tg = t.exits['perp-tgt'];
  const best = b.pairs.filter((p) => p.n > 0 && p.net > 0).map(pairOf);
  const worst = b.pairs.filter((p) => p.n > 0 && p.net < 0).map(pairOf).sort((x, y) => x.net - y.net || y.trades - x.trades);
  const perpOf = new Map(b.pairs.map((p) => [p.key, p.perpPts]));
  const note = (p: PairStat) => `perp ${ptsText(perpOf.get(p.key) ?? 0)}`;
  const amount = (p: { net: number }) => moneyText(p.net);
  return (
    <>
      {sl && sl.n > 0 && (
        <Panel title="When the perp's SL was hit">
          <p className="m-0 text-[14px] leading-snug">
            The perp reached the signal&apos;s stop on <b>{count(sl.n)}</b> trades. The option was <b className="text-[var(--up)]">still a profit on {count(sl.wins)}</b> of them
            ({pct(sl.wins / sl.n, 0)}) and a loss on {count(sl.n - sl.wins)}. Together: <b className={netClass(sl.net)}>{moneyText(sl.net)}</b>, {moneyText(sl.net / sl.n)} a trade.
          </p>
          {tg && tg.n > 0 && (
            <p className="m-0 mt-2 text-[13px] leading-snug text-muted-foreground">
              For comparison, the perp reached the target on {count(tg.n)} trades: the option was a profit on {pct(tg.wins / tg.n, 0)} of them,{' '}
              <span className={netClass(tg.net)}>{moneyText(tg.net)}</span> together, {moneyText(tg.net / tg.n)} a trade.
            </p>
          )}
        </Panel>
      )}

      {t.n > 0 && (
        <>
          <div id={`${idPrefix}-exits`} className={cn('grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)] gap-3', wide && 'lg:grid-cols-2')}>
            <Panel title="Closed by which exit">
              <table className={FOLD.table}>
                <caption className="sr-only">Backtest: which exit closed the trades</caption>
                <thead className={FOLD.head}>
                  <tr className="text-left text-[11.5px] text-muted-foreground">
                    <th scope="col" className="py-1 pr-2 font-medium">Closed by</th>
                    <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
                    <th scope="col" className="py-1 pr-2 text-right font-medium">In profit</th>
                    <th scope="col" className="py-1 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody className={FOLD.body}>
                  {EXITS.flatMap((e) => {
                    const x = t.exits[e.key];
                    return x && x.n > 0 ? [(
                      <tr key={e.key} className={FOLD.row}>
                        <th scope="row" className={FOLD.name}>{e.label}</th>
                        <td className={FOLD.trades}>{count(x.n)}</td>
                        <td className={FOLD.inProfit}>{pct(x.wins / x.n, 0)}</td>
                        <td className={FOLD.net}>
                          <span className={cn('block whitespace-nowrap font-semibold', netClass(x.net))}>{moneyText(x.net)}</span>
                          <span className={cn('block whitespace-nowrap text-[11.5px]', netClass(x.net))}>{moneyText(x.net / x.n)}</span>
                        </td>
                      </tr>
                    )] : [];
                  })}
                </tbody>
              </table>
            </Panel>
            {(b.byVol?.length ?? 0) > 0 && (
              <Panel title="By volatility when the signal filled">
                <Table caption="Backtest by volatility" first="Volatility" rows={b.byVol!} />
              </Panel>
            )}
            <Panel title="By time frame">
              <Table caption="Backtest by time frame" first="Time frame" rows={b.byTf.map((x) => (x.key === 'chain' ? { ...x, name: 'TF chain' } : x))} perp />
            </Panel>
          </div>

          <div id={`${idPrefix}-pairs`} className={cn('grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)] gap-3', wide && 'lg:grid-cols-2')}>
            <PairList title="Best pairs as options" tone="up" pairs={best} amount={amount} note={note} empty="No method and time frame in profit as an option here." />
            <PairList title="Worst pairs as options" tone="down" pairs={worst} amount={amount} note={note} empty="No method and time frame in loss as an option here." />
          </div>

          <div id={`${idPrefix}-methods`} className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]"><MethodsAsOptions rows={b.byMethod} wide={wide} /></div>

          {/* The perp and the options apart, on the same trades (18 Oct 2026): a good perp line is not a good options one. */}
          <div id={`${idPrefix}-perp`} className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]"><PerpVsOptions total={t} rows={b.byMethod} pairs={b.pairs} byTf={b.byTf} /></div>
          {widen && <div className="grid min-w-0 grid-cols-[minmax(0,1fr)]">{widen}</div>}

          {sessions && <div id={`${idPrefix}-sessions`} className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]">{sessions}</div>}

          <div id={`${idPrefix}-days`} className={cn('grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)] gap-3', wide && 'lg:grid-cols-2')}>
            <Panel title="By kind of day">
              <Segmented label="Group the days by" value={grouping} onChange={setGrouping}
                options={[{ key: 'family', label: 'Trend family', spoken: 'By family: up trend, down trend, range, turn' }, { key: 'kind', label: 'Market type', spoken: 'By each market type' }]} />
              <div className="mt-2"><Table caption="Backtest by kind of day" first={grouping === 'family' ? 'Family' : 'Market type'} rows={grouping === 'family' ? b.byFamily : b.byPattern} days /></div>
            </Panel>
            {expiryDays}
          </div>
        </>
      )}
    </>
  );
}
