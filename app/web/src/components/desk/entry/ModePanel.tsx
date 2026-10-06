import { useMemo, type ReactNode } from 'react';
import { FoldButton, useFold } from '@/components/ui/fold';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PriceChart } from '@/components/desk/PriceChart';
import type { EntryMode, EntryRecord, EntryTf, MethodRead } from '@/types/entry';
import type { ChartFeed } from './feed';
import { LiveStrip } from './LiveStrip';
import { TradeClock } from './TradeClock';
import { METHOD_VIEWS, NumberBadge, SignalChip, TICK_CLASS, ViewChips, fmt, overlayOf, recordText, tickOf, viewReads, type MethodView } from './parts';
import { usePersisted } from '@/hooks/usePersisted';

/**
 * One half of the reference layout: the 81 methods read one way -- with
 * the timeframe chain, or without it -- with their chart, table, the chosen
 * setup and its reasons. (No pros-and-cons list and no paper-record strip:
 * both removed at the owner's request; the record lives in the signal history.)
 *
 * Two words differ from the reference on purpose: the quality score is shown
 * as a score out of 100, not as "confidence %", because nothing measures a
 * chance of winning yet; and there is no TAKE TRADE button, because these
 * setups are paper-logged and never ordered (docs/decisions/0013).
 */

const CHAIN_TFS: readonly EntryTf[] = ['4h', '1h', '30m', '15m', '5m', '3m', '1m'];
/** The timeframes the methods are read on without the chain -- signalled, alerted, kept. Not 1m (the server's SINGLE_TFS). */
export const SINGLE_TFS: readonly EntryTf[] = ['3m', '5m', '15m', '30m', '1h', '2h', '4h'];
/** 1m is a chart to look at only (owner, 1 Oct 2026): no reads, no signal, no alert, no history. */
export const VIEW_ONLY_TFS: readonly EntryTf[] = ['1m'];
/** Every chip a panel's chart offers. */
export const CHART_TFS: readonly EntryTf[] = [...VIEW_ONLY_TFS, ...SINGLE_TFS];

const COPY: Record<EntryMode, { title: (n: number) => string; accent: string; sub: string; tag: string }> = {
  single: {
    title: (n) => `${n} methods · without timeframe`,
    accent: 'border-t-[#d97706]',
    sub: 'Each method on one timeframe alone -- no higher-timeframe check.',
    tag: 'More signals',
  },
  mtf: {
    title: (n) => `${n} methods + timeframe`,
    accent: 'border-t-[#26a17b]',
    sub: '4H/1H context → 30m/15m setup → 5m entry → 3m confirm → 1m execution.',
    tag: 'Fewer signals',
  },
};

export function ModePanel({ mode, reads, selected, onChoose, recordOf, setupsOn, chartTf, onChartTf, chart, alert, autoPicked = false, ltp = null, count }: {
  mode: EntryMode;
  reads: readonly MethodRead[];
  /** How many methods the section reads (the title's number), when this panel has none to show -- 1m is chart-only. */
  count?: number;
  /** This panel's chosen read. */
  selected: MethodRead | null;
  onChoose: (r: MethodRead) => void;
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
}) {
  const [open, setOpen] = useFold(`entry-panel-${mode}`);
  const copy = COPY[mode];
  // Kept while the choice holds: a new object each tick would rebuild the chart's whole scene.
  const drawn = useMemo(() => overlayOf(selected, setupsOn), [selected, setupsOn]);

  return (
    <section aria-label={copy.title(count ?? reads.length)} data-folded={!open} className={cn('fold-host min-w-0 rounded-xl border border-border border-t-4 bg-[var(--panel)] p-2.5', copy.accent)}>
      <header className="fold-head mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="m-0 flex items-center gap-1 text-[14px] font-bold"><FoldButton open={open} onToggle={() => setOpen(!open)} label={copy.title(count ?? reads.length)} className="-ml-1" />{copy.title(count ?? reads.length)}</h3>
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
            {CHART_TFS.map((x) => (
              <button key={x} type="button" aria-pressed={chartTf === x} onClick={() => onChartTf(x)}
                      title={VIEW_ONLY_TFS.includes(x) ? `${x}: chart only -- no signals, no alerts` : undefined}
                      className={cn('min-w-[30px] px-1.5 py-0.5', chartTf === x ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                {x}
              </button>
            ))}
          </div>
        </div>
      </div>
      <PriceChart {...chart(chartTf)} tf={chartTf} entry={drawn} size="panel" label={`${copy.title(count ?? reads.length)} chart`} />

      {/* The table full width, then the chosen setup beside its reasons: a panel is half the screen at most. */}
      {mode === 'single' && VIEW_ONLY_TFS.includes(chartTf) ? (
        <p role="note" aria-label="view only" className="m-0 mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">
          <b className="text-foreground">{chartTf} is chart-only.</b> No signals, no Telegram alerts and nothing in the signal history on {chartTf} --
          its bars are too fast for these methods' stops. Pick 3m or higher to read the methods.
        </p>
      ) : (
      <div className="mt-2 grid gap-2">
        <MethodTable mode={mode} reads={reads} selected={selected} onChoose={onChoose} recordOf={recordOf} autoPicked={autoPicked} />
        <div className="grid gap-2 sm:grid-cols-2">
          <SelectedCard read={selected} ltp={ltp} />
          <div className="grid content-start gap-2">
            <Reasons read={selected} />
          </div>
        </div>
      </div>
      )}
    </section>
  );
}

function MethodTable({ mode, reads, selected, onChoose, recordOf, autoPicked }: {
  mode: EntryMode; reads: readonly MethodRead[]; selected: MethodRead | null;
  onChoose: (r: MethodRead) => void; recordOf: (r: MethodRead) => EntryRecord | null;
  autoPicked: boolean;
}) {
  const chain = mode === 'mtf';
  const [view, setView] = usePersisted<MethodView>(`entry:${mode}-view`, 'all');
  const shown = viewReads(reads, view);
  const counts = Object.fromEntries(METHOD_VIEWS.map((v) => [v, viewReads(reads, v).length]));
  // The chosen method stays in the table, whatever the view.
  if (selected && !shown.some((r) => r.id === selected.id)) shown.unshift(selected);
  return (
    <div className="min-w-0 rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-1.5 px-2 pt-1.5">
        <span className="text-[12.5px] font-semibold">{reads.length} entry methods <span className="font-normal text-muted-foreground">{chain ? '· with timeframe proof' : `· ${reads[0]?.tf ?? ''} only`}</span></span>
        <ViewChips value={view} onChange={setView} label={`${mode === 'mtf' ? 'with' : 'without'} timeframe view`} counts={counts} />
      </div>
      {/* A long list: signals first, the body scrolling under a fixed header. */}
      <div className="mt-1 max-h-[420px] overflow-auto">
        <table className="w-full border-collapse text-[12px] tabular-nums" aria-label={`${mode === 'mtf' ? 'with' : 'without'} timeframe methods`}>
          <thead className="sticky top-0 z-10 bg-[var(--card,var(--panel))] text-left text-[10.5px] text-muted-foreground">
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
            {shown.map((r) => {
              const on = selected?.id === r.id;
              return (
                // The chosen row, unmistakable: a tint, an edge on the left, and "AUTO" when a signal chose it.
                <tr key={r.id} aria-selected={on}
                    className={cn('border-t border-border', on && 'bg-[var(--accent-soft)] shadow-[inset_3px_0_0_var(--accent)]')}>
                  <td className="py-1 pl-2">
                    {/* The number only: the names are in the method table above both panels. */}
                    <button type="button" aria-pressed={on} onClick={() => onChoose(r)} aria-label={`${r.code ?? r.n} ${r.name}`}
                            title={`${r.code ?? r.n}. ${r.name} -- ${recordText(recordOf(r))}`} className="inline-flex items-center rounded-full align-middle">
                      <NumberBadge read={r} />
                    </button>
                    {on && autoPicked ? <span className="ml-1 rounded bg-primary px-1 text-[9px] font-bold text-primary-foreground" title="Chosen by auto-select: this is the signal">AUTO</span> : null}
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
      {read.state === 'TRADE' ? <TradeClock read={read} /> : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-2 pb-2 tabular-nums">
        {row('Method', `#${read.code ?? read.n} ${read.name}`)}
        {row('Timeframe', read.mode === 'mtf' ? '4H/1H → 15m → 5m entry → 1m' : `${read.tf} only`)}
        {row('Quality', read.score === null ? '–' : `${read.score}/100`, 'text-foreground')}
        {p && risk !== null && reward !== null ? (
          <>
            {row('Entry', `${fmt(p.entryLo)} – ${fmt(p.entryHi)}`)}
            {row('Stop loss', <>{fmt(p.stop)}<Why text={p.why?.stop} /></>, 'text-[var(--down)]')}
            {row('Target 1', <>{fmt(p.tp1)} ({rOf(p.tp1)!.toFixed(1)}R)<Why text={p.why?.tp1} /></>, 'text-[var(--up)]')}
            {p.tp2 !== null ? row('Target 2', <>{fmt(p.tp2)} ({rOf(p.tp2)!.toFixed(1)}R)<Why text={p.why?.tp2} /></>, 'text-[var(--up)]') : null}
            {p.tp3 !== null ? row('Target 3', <>{fmt(p.tp3)} ({rOf(p.tp3)!.toFixed(1)}R)<Why text={p.why?.tp3} /></>) : null}
            {row('Risk', `${fmt(risk)} (${pct(risk)})`)}
            {row('Reward', `${fmt(reward)} (${pct(reward)})`)}
            {row('R:R', p.rr.toFixed(2), 'font-semibold')}
          </>
        ) : null}
      </dl>
      {read.state !== 'TRADE' ? <p className="m-0 px-2 pb-2 text-muted-foreground">{read.reason}</p> : null}
      <div className="mx-2 mb-2 rounded border border-dashed border-border py-1 text-center text-[11px] text-muted-foreground">
        {read.state === 'TRADE' ? 'Paper-logged and graded on 1m candles · no order is placed' : 'No levels until every confirmation holds'}
      </div>
    </section>
  );
}

/** Under a level: why it is there, small -- the method's own SL/TP rule. */
function Why({ text }: { text: string | null | undefined }) {
  return text ? <span className="block text-[10.5px] font-normal text-muted-foreground">{text}</span> : null;
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
