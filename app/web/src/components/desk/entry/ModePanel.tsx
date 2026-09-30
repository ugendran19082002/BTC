import { useMemo, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PriceChart } from '@/components/desk/PriceChart';
import type { EntryMode, EntryRecord, EntryTf, MethodRead } from '@/types/entry';
import type { ChartFeed } from './feed';
import { LiveStrip } from './LiveStrip';
import { NumberBadge, SignalChip, TICK_CLASS, fmt, overlayOf, recordText, signedR, tickOf } from './parts';

/**
 * One half of the reference layout: the twelve methods read one way -- with
 * the timeframe chain, or without it -- with their chart, table, the chosen
 * setup, its reasons, and that mode's
 * paper record. (No pros-and-cons list: removed at the owner's request.)
 *
 * Two words differ from the reference on purpose: the quality score is shown
 * as a score out of 100, not as "confidence %", because nothing measures a
 * chance of winning yet; and there is no TAKE TRADE button, because these
 * setups are paper-logged and never ordered (docs/decisions/0013).
 */

const CHAIN_TFS: readonly EntryTf[] = ['4h', '1h', '30m', '15m', '5m', '3m', '1m'];
export const SINGLE_TFS: readonly EntryTf[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

const COPY: Record<EntryMode, { title: string; accent: string; sub: string; tag: string }> = {
  single: {
    title: '12 methods · without timeframe',
    accent: 'border-t-[#d97706]',
    sub: 'Each method on one timeframe alone -- no higher-timeframe check.',
    tag: 'More signals',
  },
  mtf: {
    title: '12 methods + timeframe',
    accent: 'border-t-[#26a17b]',
    sub: '4H/1H context → 30m/15m setup → 5m entry → 3m confirm → 1m execution.',
    tag: 'Fewer signals',
  },
};

export function ModePanel({ mode, reads, selected, onChoose, total, recordOf, setupsOn, chartTf, onChartTf, chart, alert, autoPicked = false, ltp = null, totalAll = null }: {
  mode: EntryMode;
  reads: readonly MethodRead[];
  /** This panel's chosen read. */
  selected: MethodRead | null;
  onChoose: (r: MethodRead) => void;
  /** This mode's total over all twelve methods, from the paper log. */
  total: EntryRecord | null;
  recordOf: (r: MethodRead) => EntryRecord | null;
  setupsOn: boolean;
  /**
   * The chart's timeframe. Without the chain it is also the reads' timeframe;
   * with it, any of the chain's, to look at (the reads stay at 5m).
   */
  chartTf: EntryTf;
  onChartTf: (tf: EntryTf) => void;
  /** The shared chart data, per timeframe (feed.ts). */
  chart: (tf: EntryTf) => ChartFeed;
  /** This way's Telegram switch, for the header. */
  alert?: ReactNode;
  /** The selected read was chosen by auto-select (a signal came), not by hand. */
  autoPicked?: boolean;
  /** The live last trade, for the selected TRADE's live strip. */
  ltp?: { price: number; at: number } | null;
  /** This way's record with gate-off setups included, shown apart from `total`. */
  totalAll?: EntryRecord | null;
}) {
  const copy = COPY[mode];
  // Kept while the choice holds: a new object each tick would rebuild the chart's whole scene.
  const drawn = useMemo(() => overlayOf(selected, setupsOn), [selected, setupsOn]);

  return (
    <section aria-label={copy.title} className={cn('min-w-0 rounded-xl border border-border border-t-4 bg-[var(--card,transparent)] p-2.5', copy.accent)}>
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="m-0 text-[14px] font-bold">{copy.title}</h3>
          <p className="m-0 text-[11.5px] text-muted-foreground">{copy.sub}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{copy.tag}</span>
          {alert}
        </div>
      </header>

      {/* The chart, with its timeframe control. */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
        <span className="text-muted-foreground">
          BTCUSD · {chartTf}{selected ? ` · ${selected.name}` : ''}{drawn ? '' : setupsOn ? ' · no levels (not a TRADE)' : ' · setups off'}
        </span>
        {/*
          One timeframe switch on both sides, chips rather than a native select:
          the browser's own dropdown opened white-on-grey over the dark desk.
          Without the chain it also moves the reads; with it, only the view.
        */}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{mode === 'single' ? 'read on' : 'view'}</span>
          <div role="group" aria-label={mode === 'single' ? 'timeframe without the chain' : 'chart timeframe'}
               className="inline-flex overflow-hidden rounded border border-border">
            {SINGLE_TFS.map((x) => (
              <button key={x} type="button" aria-pressed={chartTf === x} onClick={() => onChartTf(x)}
                      className={cn('min-w-[30px] px-1.5 py-0.5', chartTf === x ? 'bg-[#2563eb] text-white' : 'text-muted-foreground hover:bg-muted')}>
                {x}
              </button>
            ))}
          </div>
        </div>
      </div>
      <PriceChart {...chart(chartTf)} tf={chartTf} entry={drawn} size="panel" label={`${copy.title} chart`} />

      {/* The table full width, then the chosen setup beside its reasons: a panel is half the screen at most. */}
      <div className="mt-2 grid gap-2">
        <MethodTable mode={mode} reads={reads} selected={selected} onChoose={onChoose} recordOf={recordOf} autoPicked={autoPicked} />
        <div className="grid gap-2 sm:grid-cols-2">
          <SelectedCard read={selected} ltp={ltp} />
          <div className="grid content-start gap-2">
            <Reasons read={selected} />
          </div>
        </div>
      </div>

      <RecordStrip total={total} totalAll={totalAll} tf={chartTf} mode={mode} />
    </section>
  );
}

function MethodTable({ mode, reads, selected, onChoose, recordOf, autoPicked }: {
  mode: EntryMode; reads: readonly MethodRead[]; selected: MethodRead | null;
  onChoose: (r: MethodRead) => void; recordOf: (r: MethodRead) => EntryRecord | null;
  autoPicked: boolean;
}) {
  const chain = mode === 'mtf';
  return (
    <div className="min-w-0 rounded-lg border border-border">
      <div className="px-2 pt-1.5 text-[12.5px] font-semibold">12 entry methods <span className="font-normal text-muted-foreground">{chain ? '· with timeframe proof' : `· ${reads[0]?.tf ?? ''} only`}</span></div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px] tabular-nums" aria-label={`${mode === 'mtf' ? 'with' : 'without'} timeframe methods`}>
          <thead className="text-left text-[10.5px] text-muted-foreground">
            <tr>
              <th className="py-1 pl-2" title="The method's number: names are in the table above">#</th>
              {chain ? CHAIN_TFS.map((t) => <th key={t} className="px-0.5 text-center font-normal">{t.toUpperCase()}</th>) : null}
              <th className="px-1 text-center">Signal</th>
              <th className="px-1 text-right" title="Setup quality out of 100 -- not a chance of winning">Quality</th>
              {/* With the chain's seven ticks a phone has no room for the why: it is in the selected setup below. */}
              <th className={cn('px-1', chain && 'hidden sm:table-cell')}>Why</th>
              <th className="sr-only">Choose</th>
            </tr>
          </thead>
          <tbody>
            {reads.map((r) => {
              const on = selected?.id === r.id;
              return (
                // The chosen row, unmistakable: a tint, an edge on the left, and "AUTO" when a signal chose it.
                <tr key={r.id} aria-selected={on}
                    className={cn('border-t border-border', on && 'bg-[rgba(37,99,235,0.16)] shadow-[inset_3px_0_0_#2563eb]')}>
                  <td className="py-1 pl-2">
                    {/* The number only: the names are in the method table above both panels. */}
                    <button type="button" aria-pressed={on} onClick={() => onChoose(r)} aria-label={`${r.n} ${r.name}`}
                            title={`${r.n}. ${r.name} -- ${recordText(recordOf(r))}`} className="inline-flex items-center rounded-full align-middle">
                      <NumberBadge read={r} />
                    </button>
                    {on && autoPicked ? <span className="ml-1 rounded bg-[#2563eb] px-1 text-[9px] font-bold text-white" title="Chosen by auto-select: this is the signal">AUTO</span> : null}
                  </td>
                  {chain ? CHAIN_TFS.map((t) => {
                    const k = tickOf(r, t);
                    return <td key={t} className={cn('px-0.5 text-center', TICK_CLASS[k])}>{k}</td>;
                  }) : null}
                  <td className="px-1 text-center"><SignalChip read={r} /></td>
                  <td className="px-1 text-right tabular-nums">{r.score ?? '–'}</td>
                  <td className={cn('max-w-[14rem] px-1 text-[11px] text-muted-foreground', chain && 'hidden sm:table-cell')}><span className="line-clamp-1" title={r.reason}>{r.reason}</span></td>
                  <td className="pr-1 text-muted-foreground"><ChevronRight aria-hidden size={14} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SelectedCard({ read, ltp }: { read: MethodRead | null; ltp: { price: number; at: number } | null }) {
  if (!read) return <div className="rounded-lg border border-border p-2 text-[12px] text-muted-foreground">Choose a method.</div>;
  const p = read.plan;
  const head = read.state === 'TRADE'
    ? { text: read.dir === 'short' ? 'SHORT SETUP' : 'LONG SETUP', cls: read.dir === 'short' ? 'bg-[#e2504f] text-white' : 'bg-[#26a17b] text-white' }
    : read.state === 'WAIT'
      ? { text: `WAIT${read.dir ? ` · ${read.dir} forming` : ''}`, cls: 'bg-[#b7791f] text-white' }
      : { text: read.dir ? `NO TRADE · ${read.dir} refused` : 'NO TRADE', cls: 'bg-muted text-muted-foreground' };
  // Gates switched off that would have refused this read.
  const overridden = read.gates.filter((g) => !g.enabled && g.ok === false);
  // Measured from where it fills -- the edge price reaches first (the top for a long) -- as the server and the paper log do.
  const fill = p ? (read.dir === 'short' ? p.entryLo : p.entryHi) : null;
  const risk = p && fill !== null ? Math.abs(fill - p.stop) : null;
  const reward = p && fill !== null ? Math.abs(p.tp1 - fill) : null;
  const rOf = (tp: number) => (risk && fill !== null ? Math.abs(tp - fill) / risk : null);
  const pct = (pts: number) => (fill ? `${((100 * pts) / fill).toFixed(2)}%` : '');
  const row = (k: string, v: React.ReactNode, cls?: string) => (
    <><dt className="text-muted-foreground">{k}</dt><dd className={cn('m-0 text-right', cls)}>{v}</dd></>
  );
  return (
    <section aria-label="selected setup" className="rounded-lg border border-border text-[12px]">
      <div className="px-2 pt-1.5 font-semibold">Selected setup</div>
      <div className={cn('mx-2 my-1.5 rounded py-1 text-center text-[14px] font-bold', head.cls)}>{head.text}</div>
      {/* A TRADE that only stands because a gate is switched off says so, loudly: with every gate on it would be NO TRADE. */}
      {read.state === 'TRADE' && overridden.length ? (
        <p role="alert" className="mx-2 mb-1.5 mt-0 rounded border border-[var(--warn)] bg-[rgba(240,185,11,0.08)] px-2 py-1 text-[11.5px] text-[var(--warn)]">
          ⚠ Only a TRADE because {overridden.map((g) => g.label).join(', ')} {overridden.length === 1 ? 'is' : 'are'} switched off -- with every gate on this is NO TRADE ({overridden.map((g) => `${g.label} ${g.value ?? ''}`.trim()).join(' · ')}).
        </p>
      ) : null}
      {read.state === 'TRADE' && p && read.dir ? <LiveStrip plan={p} dir={read.dir} ltp={ltp} /> : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-2 pb-2 tabular-nums">
        {row('Method', `#${read.n} ${read.name}`)}
        {row('Timeframe', read.mode === 'mtf' ? '4H/1H → 15m → 5m entry → 1m' : `${read.tf} only`)}
        {row('Quality', read.score === null ? '–' : `${read.score}/100`, 'text-foreground')}
        {p && risk !== null && reward !== null ? (
          <>
            {row('Entry', `${fmt(p.entryLo)} – ${fmt(p.entryHi)}`)}
            {row('Stop loss', fmt(p.stop), 'text-[var(--down)]')}
            {row('Target 1', `${fmt(p.tp1)} (${rOf(p.tp1)!.toFixed(1)}R)`, 'text-[var(--up)]')}
            {p.tp2 !== null ? row('Target 2', `${fmt(p.tp2)} (${rOf(p.tp2)!.toFixed(1)}R)`, 'text-[var(--up)]') : null}
            {p.tp3 !== null ? row('Target 3', `${fmt(p.tp3)} (${rOf(p.tp3)!.toFixed(1)}R)`) : null}
            {row('Risk', `${fmt(risk)} (${pct(risk)})`)}
            {row('Reward', `${fmt(reward)} (${pct(reward)})`)}
            {row('R:R after fees', p.rr.toFixed(2), 'font-semibold')}
          </>
        ) : null}
      </dl>
      {read.state !== 'TRADE' ? <p className="m-0 px-2 pb-2 text-muted-foreground">{read.reason}</p> : null}
      <div className="mx-2 mb-2 rounded border border-dashed border-border py-1 text-center text-[11px] text-muted-foreground">
        {read.state === 'TRADE' ? 'Paper-logged and graded after fees · no order is placed' : 'No levels until every confirmation holds'}
      </div>
    </section>
  );
}

function Reasons({ read }: { read: MethodRead | null }) {
  if (!read || !read.steps.length) return null;
  return (
    <section aria-label="key reasons" className="rounded-lg border border-border p-2 text-[12px]">
      <div className="mb-1 font-semibold">Key reasons</div>
      <ul className="m-0 list-none p-0">
        {read.steps.map((s, i) => (
          <li key={i} className="flex gap-1.5">
            <span className={TICK_CLASS[s.ok === true ? '✓' : s.ok === false ? '✗' : '?']}>{s.ok === true ? '●' : s.ok === false ? '✗' : '?'}</span>
            <span className="w-8 shrink-0 text-muted-foreground">{s.tf?.toUpperCase()}</span>
            <span>{s.label}{s.ok === null ? ' (not read)' : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One line of a record: "12 trades · 42% won · PF 1.3 · +2.1R", or null with none closed. */
function recordLine(r: EntryRecord | null): string | null {
  if (!r || r.trades === 0) return null;
  const pf = r.profitFactor === null ? '' : ` · PF ${r.profitFactor.toFixed(2)}`;
  const net = r.sumR === null ? '' : ` · ${signedR(r.sumR, 1)}`;
  return `${r.trades} trade${r.trades === 1 ? '' : 's'} · ${Math.round((100 * r.wins) / r.trades)}% won${pf}${net}`;
}

/**
 * This way's paper record. The figures are the rules as designed -- every gate
 * on. Setups taken with a gate switched off are shown under them, labelled,
 * never mixed in. With nothing closed yet it says what is happening rather
 * than a row of dashes.
 */
function RecordStrip({ total, totalAll, tf, mode }: { total: EntryRecord | null; totalAll: EntryRecord | null; tf: EntryTf; mode: EntryMode }) {
  const has = total !== null && total.trades > 0;
  const cells: [string, string, string?][] = [
    ['Trades', has ? String(total!.trades) : '–'],
    ['Win rate', has ? `${Math.round((100 * total!.wins) / total!.trades)}%` : '–'],
    ['Profit factor', has && total!.profitFactor !== null ? total!.profitFactor.toFixed(2) : '–'],
    ['Net R', has && total!.sumR !== null ? signedR(total!.sumR, 1) : '–', has && (total!.sumR ?? 0) < 0 ? 'text-[var(--down)]' : 'text-[var(--up)]'],
    ['Max DD', has && total!.maxDrawdownR !== null ? `${total!.maxDrawdownR.toFixed(1)}R` : '–', 'text-[var(--down)]'],
  ];
  const offCount = totalAll?.gatesOff ?? total?.gatesOff ?? 0;
  const offLine = offCount ? recordLine(totalAll) : null;
  // What is going on, in words, while there is nothing closed to count.
  const state = has ? null
    : total && total.working ? `${total.working} setup${total.working === 1 ? '' : 's'} working -- figures appear as they close (TP1, stop or time-out).`
      : total && total.setups ? `${total.setups} logged, ${total.expired} expired unfilled -- none closed yet.`
        : 'No TRADE with every gate on yet. The log writes one the moment it forms, and grades it on the 1m candles after fees.';
  return (
    <section aria-label="paper record" className="mt-2 rounded-lg border border-border p-2">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[12px]">
        <span className="font-semibold">Paper record · all 12, at {mode === 'mtf' ? '5m' : tf}, after fees</span>
        <span className="text-[11px] text-muted-foreground">every gate on{total && total.setups ? ` · ${total.setups} logged${total.working ? `, ${total.working} working` : ''}` : ''}</span>
      </div>
      <dl className="m-0 grid grid-cols-3 gap-1 text-center sm:grid-cols-5">
        {cells.map(([k, v, c]) => (
          <div key={k} className="rounded bg-muted px-1 py-1">
            <dt className="text-[10.5px] text-muted-foreground">{k}</dt>
            <dd className={cn('m-0 text-[14px] font-bold tabular-nums', v === '–' ? 'text-muted-foreground' : c)}>{v}</dd>
          </div>
        ))}
      </dl>
      {state ? <p className="m-0 mt-1.5 text-[11px] text-muted-foreground">{state}</p> : null}
      {offCount ? (
        <p aria-label="including gate-off setups" className="m-0 mt-1.5 rounded border border-dashed border-[var(--warn)] px-2 py-1 text-[11px] text-[var(--warn)]">
          Including {offCount} setup{offCount === 1 ? '' : 's'} taken with a gate off: {offLine ?? 'none closed yet'}. Not the rules' record -- shown apart.
        </p>
      ) : null}
    </section>
  );
}
