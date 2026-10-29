import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { getMarketBreakdown, getMarketReport } from '@/api/market-report';
import { useSynced } from '@/hooks/useSynced';
import { pct } from '@/lib/format';
import {
  dayLabel, exitLines, isWholeContract, moneyText, netText, num, pairOf, ptsText, sparkOf, timeIst, toneOf, windowLabel, winRate,
  type Source, type TimeWindow,
} from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { DayStats, MarketDay, MarketReportResponse, Row, Tot } from '@/types/market-report';
import { Empty, Loading, Panel, Pill, Segmented, Stat, Stats } from '@/components/mobile/parts';
import { PairList } from '@/components/mobile/PairList';
import { useExpiryRange } from '@/components/report/ExpiryRange';
import { Updating, useAnswer } from '@/components/report/Updating';

/**
 * The market report (owner, 13 Oct 2026): "every day, the market's trend -- 5:31 PM to 5:29 PM, how the whole
 * expiry went": each expiry day, newest first, with its high and low in points, its zigzag, its ATR and where
 * that stands, how far its largest candle stood out, and one of twenty names for its shape; and what the signal
 * history and the real orders made on it. A day opens onto which exit closed its trades -- the perp's target or
 * stop, the option's own -- its best and worst pairs, and its timeframes and strategies.
 *
 * Trimmed the same day to that and nothing else (owner: "only each expiry day, newest first -- nothing else"):
 * the panels by kind of day and by method, what stood out, and the filters were taken out, here and on the server.
 *
 * One component for both places it is asked for: the phone's More menu, and the desk's own Market report menu.
 * Laid out for a thumb first; `wide` lets the day cards sit side by side on a desk.
 *
 * Two records, never added together: the signal history is in BTC perp points (and R), the real orders in
 * rupees after charges. Each day says both in a line; an opened day lists one at a time.
 */

const SOURCES: { key: Source; label: string; spoken: string }[] = [
  { key: 'real', label: 'Real orders', spoken: 'Real orders, in rupees after charges' },
  { key: 'signal', label: 'Signal history', spoken: 'Signal history, in BTC perp points' },
];
const FAMILY_TONE = { up: 'up', down: 'down', range: 'dim', turn: 'warn' } as const;

const netClass = (n: number) => (n > 0 ? 'text-[var(--up)]' : n < 0 ? 'text-[var(--down)]' : '');

/** One record in a line: "342 closed · 48% won · +₹1,076", and what is still open. */
function RecordLine({ label, source, tot }: { label: string; source: Source; tot: Tot }) {
  const rate = winRate(tot);
  return (
    <div className="flex items-baseline justify-between gap-2 text-[13px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right tabular-nums">
        {tot.n === 0 && tot.open === 0 ? <span className="text-muted-foreground">none</span> : (
          <>
            <span className="text-muted-foreground">{tot.n.toLocaleString('en-US')} closed{rate !== null ? ` · ${pct(rate, 0)} won` : ''}{tot.open ? ` · ${tot.open} open` : ''} · </span>
            <b className={cn('whitespace-nowrap font-semibold', netClass(tot.net))}>{netText(source, tot.net)}</b>
          </>
        )}
      </span>
    </div>
  );
}

/** A day as a line: its half-hour closes, the high and the low marked. */
function Spark({ line, up, label }: { line: number[]; up: boolean; label: string }) {
  const W = 320, H = 56;
  const s = sparkOf(line, W, H);
  if (!s) return null;
  const colour = up ? 'var(--up)' : 'var(--down)';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className="block w-full" style={{ height: H }}>
      <path d={s.d} fill="none" stroke={colour} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={s.hi[0]} cy={s.hi[1]} r={3} fill="var(--up)" />
      <circle cx={s.lo[0]} cy={s.lo[1]} r={3} fill="var(--down)" />
    </svg>
  );
}

/** Which exit closed one record's trades: the perp's target and stop, the option's own, and the rest -- count, share, and what they made. */
function ExitsTable({ source, tot }: { source: Source; tot: Tot }) {
  const lines = exitLines(tot);
  const what = source === 'signal' ? 'signal history' : 'real orders';
  if (lines.length === 0) return <Empty>Nothing in the {what} has closed here.</Empty>;
  return (
    <table className="w-full border-collapse text-[13px] tabular-nums">
      <caption className="sr-only">Which exit closed the trades, {what}</caption>
      <thead>
        <tr className="text-left text-[11.5px] text-muted-foreground">
          <th scope="col" className="py-1 pr-2 font-medium">Closed by</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Share</th>
          <th scope="col" className="py-1 text-right font-medium">Net</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((x) => (
          <tr key={x.key} className="border-t border-[var(--line-soft)]">
            <th scope="row" className="py-1.5 pr-2 text-left font-medium">{x.label}</th>
            <td className="py-1.5 pr-2 text-right">{x.n.toLocaleString('en-US')}</td>
            <td className="py-1.5 pr-2 text-right text-muted-foreground">{pct(x.share, 0)}</td>
            <td className={cn('whitespace-nowrap py-1.5 text-right font-semibold', netClass(x.net))}>{netText(source, x.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The exits of the record the lists show; on a desk, both records side by side. */
function Exits({ source, signal, real, wide }: { source: Source; signal: Tot; real: Tot; wide: boolean }) {
  const one = (src: Source) => (
    <section aria-label={`Closed by which exit, ${src === 'signal' ? 'signal history' : 'real orders'}`}>
      <h4 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">Closed by which exit · {src === 'signal' ? 'signal history' : 'real orders'}</h4>
      <ExitsTable source={src} tot={src === 'signal' ? signal : real} />
    </section>
  );
  return wide ? <div className="grid gap-3 lg:grid-cols-2">{one('real')}{one('signal')}</div> : one(source);
}

/** Rows of one grouping -- timeframes, strategies -- as a small table: closed, won, and what they made. */
function RowsTable({ caption, first, rows, source }: { caption: string; first: string; rows: readonly Row[]; source: Source }) {
  const shown = rows.filter((r) => r.n > 0 || r.open > 0);
  if (shown.length === 0) return null;
  return (
    <table className="w-full border-collapse text-[13px] tabular-nums">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-[11.5px] text-muted-foreground">
          <th scope="col" className="py-1 pr-2 font-medium">{first}</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Closed</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Won</th>
          <th scope="col" className="py-1 text-right font-medium">Net</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.key} className="border-t border-[var(--line-soft)]">
            <th scope="row" className="max-w-[9rem] py-1.5 pr-2 text-left font-medium [overflow-wrap:anywhere]">{r.name}</th>
            <td className="py-1.5 pr-2 text-right">{r.n.toLocaleString('en-US')}{r.open ? <span className="text-muted-foreground"> +{r.open}</span> : null}</td>
            <td className="py-1.5 pr-2 text-right">{pct(winRate(r), 0)}</td>
            <td className={cn('whitespace-nowrap py-1.5 text-right font-semibold', netClass(r.net))}>{netText(source, r.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One expiry day opened: which exit closed its trades, its best and worst pairs, by timeframe and by strategy --
 * of one record at a time, chosen here (the switch sat at the top of the page while the page had other panels).
 */
function Breakdown({ day, account, source, onSource, wide }: { day: string; account: number | null; source: Source; onSource: (s: Source) => void; wide: boolean }) {
  const read = useAnswer(JSON.stringify([day, account]), () => getMarketBreakdown(day, account), 180_000);
  if (!read.data) return <Loading error={read.error} what="the breakdown" />;
  const side = read.data[source];
  const amount = (p: { net: number }) => netText(source, p.net);
  const best = side.pairs.filter((p) => p.n > 0 && p.net > 0).map(pairOf);
  const worst = side.pairs.filter((p) => p.n > 0 && p.net < 0).map(pairOf).sort((a, b) => a.net - b.net || b.trades - a.trades);
  const what = source === 'signal' ? 'signal history' : 'real orders';
  return (
    <div className="mt-3 grid gap-3 border-t border-[var(--line-soft)] pt-3">
      <Segmented label="Which record the lists show" value={source} options={SOURCES} onChange={onSource} />
      <Updating busy={read.stale} failed={read.failed} what="the breakdown">
        <Exits source={source} signal={read.data.signal.total} real={read.data.real.total} wide={wide} />
        <div className={cn('grid gap-3', wide && 'lg:grid-cols-2')}>
          <PairList title={`Best pairs · ${what}`} tone="up" pairs={best} amount={amount} empty="No method and time frame in profit here." />
          <PairList title={`Worst pairs · ${what}`} tone="down" pairs={worst} amount={amount} empty="No method and time frame in loss here." />
        </div>
        <div className={cn('grid gap-3', wide && 'lg:grid-cols-2')}>
          <section aria-label="By time frame">
            <h4 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">By time frame · {what}</h4>
            {side.byTf.some((r) => r.n > 0 || r.open > 0) ? <RowsTable caption={`By time frame, ${what}`} first="Time frame" rows={side.byTf} source={source} /> : <Empty>None here.</Empty>}
          </section>
          {source === 'real' && (
            <section aria-label="By strategy">
              <h4 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">By strategy · real orders</h4>
              {side.byStrategy.length ? <RowsTable caption="By strategy, real orders" first="Strategy" rows={side.byStrategy} source="real" /> : <Empty>No order here.</Empty>}
            </section>
          )}
        </div>
      </Updating>
    </div>
  );
}

/** "Open" / "Close" under a card: the whole width, a thumb's height. */
function Toggle({ open, onClick, what }: { open: boolean; onClick: () => void; what: string }) {
  return (
    <button
      type="button" onClick={onClick} aria-expanded={open}
      className="mt-2.5 flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-md border-0 bg-muted font-[inherit] text-[13px] font-medium text-foreground"
    >
      {open ? 'Hide' : 'Show'} {what}
      <ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
    </button>
  );
}

const ratio = (n: number | null, places = 2) => (n === null ? '—' : `${n.toFixed(places)}×`);

/** The figures of a day, as tiles: what was asked for by name first, the rest behind "More figures". */
function DayFigures({ s }: { s: DayStats }) {
  const [more, setMore] = useState(false);
  return (
    <>
      <Stats cols={3}>
        <Stat label="High" tone="up">{num(s.high)}</Stat>
        <Stat label="Low" tone="down">{num(s.low)}</Stat>
        <Stat label="High − low">{num(s.rangePts)} pts</Stat>
        <Stat label="Open → close" tone={toneOf(s.netPts)}>{ptsText(s.netPts).replace(' pts', '')}</Stat>
        <Stat label="Zigzag swings">{s.zigzag.swings}</Stat>
        <Stat label="Zigzag total">{num(s.zigzag.totalPts)} pts</Stat>
      </Stats>
      {/* Two to a row: "Volatility expansion ratio" has to read whole on a 360px phone. */}
      <div className="mt-2">
        <Stats cols={2}>
          <Stat label="ATR (15m candles)">{num(s.atr)} pts</Stat>
          <Stat label="ATR percentile" tone={s.atrPercentile === null ? 'dim' : s.atrPercentile >= 75 ? 'warn' : undefined}>{s.atrPercentile === null ? '—' : `${s.atrPercentile} of 100`}</Stat>
          <Stat label="Candle expansion ratio" tone={s.candleExpansion >= 6 ? 'warn' : undefined}>{ratio(s.candleExpansion, 1)}</Stat>
          <Stat label="Volatility expansion ratio" tone={s.volExpansion !== null && s.volExpansion >= 1.3 ? 'warn' : undefined}>{ratio(s.volExpansion)}</Stat>
          <Stat label="Most above the open" tone="up">+{num(s.upPts)} pts</Stat>
          <Stat label="Most below the open" tone="down">−{num(s.downPts)} pts</Stat>
        </Stats>
      </div>
      {more && (
        <dl className="m-0 mt-2 grid grid-cols-1 gap-x-4 text-[13px] sm:grid-cols-2">
          {([
            ['Open / close', `${num(s.open)} → ${num(s.close)}`],
            ['Range', `${(s.rangePct * 100).toFixed(2)}% of the price`],
            ['High made at', timeIst(s.highAt)],
            ['Low made at', timeIst(s.lowAt)],
            ['Largest 15m candle', `${num(s.bigCandle.pts)} pts ${s.bigCandle.up ? 'up' : 'down'} at ${timeIst(s.bigCandle.at)} · ${Math.round(s.bigCandle.shareOfRange * 100)}% of the range`],
            ['ATR as % of price', `${(s.atrPct * 100).toFixed(2)}%`],
            ['Largest swing up / down', `${num(s.zigzag.maxUpPts)} / ${num(s.zigzag.maxDownPts)} pts`],
            ['Average swing', `${num(s.zigzag.avgPts)} pts (a swing is ${num(s.zigzag.thresholdPts)} pts or more)`],
            ['Path over range', `${s.pathRatio.toFixed(1)}× (1× is a straight line)`],
            ['Trend efficiency', `${Math.round(s.efficiency * 100)}% · closed ${Math.round(s.dirShare * 100)}% of its range from the open`],
            ['The day in thirds', s.thirds.map((t) => ptsText(t.netPts).replace(' pts', '')).join(' · ')],
            ['Late against early candles', `${s.lateVsEarly.toFixed(2)}×`],
            ['Minutes of tape', `${s.bars.toLocaleString('en-US')} of 1,440`],
          ] as const).map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-t border-[var(--line-soft)] py-1.5">
              <dt className="shrink-0 text-muted-foreground">{k}</dt>
              <dd className="m-0 min-w-0 text-right tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <button
        type="button" onClick={() => setMore((v) => !v)} aria-expanded={more}
        className="mt-1.5 min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]"
      >
        {more ? 'Fewer figures' : 'More figures'}
      </button>
    </>
  );
}

function PatternPill({ report, pattern, family }: { report: MarketReportResponse; pattern: string | null; family: MarketDay['family'] }) {
  const p = report.catalogue.find((x) => x.key === pattern);
  if (!p) return <Pill tone="dim">No tape</Pill>;
  return <Pill tone={FAMILY_TONE[family ?? 'range']}>#{p.id} {p.name}</Pill>;
}

function DayCard({ report, d, account, source, onSource, wide }: { report: MarketReportResponse; d: MarketDay; account: number | null; source: Source; onSource: (s: Source) => void; wide: boolean }) {
  const [open, setOpen] = useState(false);
  const p = report.catalogue.find((x) => x.key === d.pattern);
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3 className="m-0 text-[15px] font-semibold">
          {dayLabel(d.day)} <span className="text-[12px] font-normal text-muted-foreground">expiry</span>
          {d.live && <span className="ml-2 align-middle"><Pill tone="accent">In progress</Pill></span>}
        </h3>
        <PatternPill report={report} pattern={d.pattern} family={d.family} />
      </div>
      <p className="m-0 mt-0.5 text-[11.5px] text-muted-foreground">{dayLabel(new Date(d.from + 5.5 * 3_600_000).toISOString().slice(0, 10))} 5:30 PM → {dayLabel(d.day)} 5:30 PM IST</p>
      {d.stats ? (
        <>
          {p && <p className="m-0 mt-1.5 text-[13px] font-medium">{p.meaning}{d.live ? ' — so far' : ''}</p>}
          {d.why && <p className="m-0 mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{d.why}</p>}
          <div className="my-2"><Spark line={d.stats.line} up={d.stats.netPts >= 0} label={`BTC perp over the ${dayLabel(d.day)} expiry day: high ${num(d.stats.high)}, low ${num(d.stats.low)}`} /></div>
          <DayFigures s={d.stats} />
        </>
      ) : (
        <Empty>Too little of the tape was recorded for this day to measure it ({d.bars} minutes).</Empty>
      )}
      <div className="mt-2 grid gap-1 border-t border-[var(--line-soft)] pt-2">
        <RecordLine label="Signal history" source="signal" tot={d.signal} />
        <RecordLine label="Real orders" source="real" tot={d.real} />
      </div>
      <Toggle open={open} onClick={() => setOpen((v) => !v)} what="exits, pairs and time frames" />
      {open && <Breakdown day={d.day} account={account} source={source} onSource={onSource} wide={wide} />}
    </Panel>
  );
}

export function MarketReport({ account, now = Date.now(), wide = false }: {
  /** The broker account whose real orders are read; null is every account's. The signal history has no account. */
  account: number | null;
  now?: number;
  /** On the desk: the day cards may sit side by side. */
  wide?: boolean;
}) {
  const expiry = useExpiryRange('marketReport', now);
  const [source, setSource] = useSynced<Source>('marketReport.source', 'real');
  const [allDays, setAllDays] = useState(false);
  const range = expiry.range;
  // The answer is kept with what was asked: the days of the range before are greyed while the new one is read.
  const read = useAnswer(JSON.stringify([range, account]), () => getMarketReport(range, account), 120_000);
  const r = read.data;
  const head = (
    <>
      {wide && <h2 className="m-0 mt-2 px-1 text-[15px] font-semibold">Market report <span className="text-[12.5px] font-normal text-muted-foreground">· each expiry day&apos;s kind of market, and what the methods made on it</span></h2>}
      {expiry.control}
    </>
  );
  if (!r) return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">{head}<Panel><Loading error={read.error} what="the market report" /></Panel></div>;

  const newestFirst = [...r.days].reverse();
  const FIRST = wide ? 6 : 4;
  const shownDays = allDays ? newestFirst : newestFirst.slice(0, FIRST);
  return (
    // One column exactly as wide as the screen: a bare grid sizes its column to the widest row inside it.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      {head}
      <Updating busy={read.stale} failed={read.failed} what="the market report">
        <section aria-label="Each expiry day" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
          <h2 className="m-0 px-1 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">Each expiry day, newest first</h2>
          {newestFirst.length === 0 && <Panel><Empty>No expiry day in this range.</Empty></Panel>}
          <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'lg:grid-cols-2 2xl:grid-cols-3')}>
            {shownDays.map((d) => <DayCard key={d.day} report={r} d={d} account={account} source={source} onSource={setSource} wide={false} />)}
          </div>
          {newestFirst.length > FIRST && (
            <button
              type="button" onClick={() => setAllDays((v) => !v)} aria-expanded={allDays}
              className="min-h-[44px] w-full rounded-md border-0 bg-muted font-[inherit] text-[13.5px] font-medium text-foreground"
            >
              {allDays ? `Show the newest ${FIRST}` : `Show all ${newestFirst.length} days`}
            </button>
          )}
        </section>
        <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
          An expiry day runs 5:30 PM to 5:30 PM IST, one daily contract from open to settlement; a trade is counted in the day it was entered in. Signal
          history: every signal that went in the trade, on the BTC perp, in points, without charges. Real orders: what the strategies sold on those signals,
          in rupees after charges{account === null ? ', every account' : ''}. The figures are from the desk&apos;s one-minute tape of the perp: ATR is the
          average true range of the day&apos;s 15-minute candles, its percentile is against the 30 expiry days before, volatility expansion against the 5
          before, and candle expansion is the largest candle over the usual one.
        </p>
      </Updating>
    </div>
  );
}
