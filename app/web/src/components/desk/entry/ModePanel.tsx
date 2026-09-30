import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EntryMode, EntryRecord, EntryTf, MethodRead, TimeframeRow } from '@/types/entry';
import { EntryChart, useEntryCandles } from './EntryChart';
import { NumberBadge, SignalChip, TICK_CLASS, fmt, recordText, signedR, tickOf } from './parts';

/**
 * One half of the reference layout: the twelve methods read one way -- with
 * the timeframe chain, or without it -- with their chart, table, the chosen
 * setup, its reasons, (with the chain) the timeframe analysis, and that mode's
 * paper record.
 *
 * Two words differ from the reference on purpose: the quality score is shown
 * as a score out of 100, not as "confidence %", because nothing measures a
 * chance of winning yet; and there is no TAKE TRADE button, because these
 * setups are paper-logged and never ordered (docs/decisions/0013).
 */

const CHAIN_TFS: readonly EntryTf[] = ['4h', '1h', '30m', '15m', '5m', '3m', '1m'];
export const SINGLE_TFS: readonly EntryTf[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

const COPY: Record<EntryMode, { title: string; accent: string; sub: string; tag: string; pros: string[]; cons: string[] }> = {
  single: {
    title: '12 methods · without timeframe',
    accent: 'border-t-[#d97706]',
    sub: 'Each method on one timeframe alone -- no higher-timeframe check.',
    tag: 'More signals',
    pros: ['More setups, sooner', 'Simple: one timeframe, one chain', 'Works on any timeframe you pick'],
    cons: ['No check against the bigger trend', 'More false starts in a choppy market', 'Can enter against a major trend'],
  },
  mtf: {
    title: '12 methods + timeframe',
    accent: 'border-t-[#26a17b]',
    sub: '4H/1H context → 30m/15m setup → 5m entry → 3m confirm → 1m execution.',
    tag: 'Fewer signals',
    pros: ['Filters out setups against the bigger trend', 'Entry, stop and targets in the trend\'s context', 'Waits for the 3m and 1m to agree'],
    cons: ['Fewer setups, and later entries', 'Needs every timeframe\'s candles to be fresh', 'Can miss the start of a move'],
  },
};

export function ModePanel({ mode, reads, timeframes, selected, onChoose, total, recordOf, setupsOn, singleTf, onSingleTf }: {
  mode: EntryMode;
  reads: readonly MethodRead[];
  timeframes: readonly TimeframeRow[];
  /** This panel's chosen read. */
  selected: MethodRead | null;
  onChoose: (r: MethodRead) => void;
  /** This mode's total over all twelve methods, from the paper log. */
  total: EntryRecord | null;
  recordOf: (r: MethodRead) => EntryRecord | null;
  setupsOn: boolean;
  singleTf: EntryTf;
  onSingleTf: (tf: EntryTf) => void;
}) {
  const copy = COPY[mode];
  const [chartTf, setChartTf] = useState<EntryTf>('5m');
  const shownTf = mode === 'single' ? singleTf : chartTf;
  const bars = useEntryCandles(shownTf);
  const drawn = setupsOn && selected?.plan ? selected.plan : null;

  return (
    <section aria-label={copy.title} className={cn('min-w-0 rounded-xl border border-border border-t-4 bg-[var(--card,transparent)] p-2.5', copy.accent)}>
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="m-0 text-[14px] font-bold">{copy.title}</h3>
          <p className="m-0 text-[11.5px] text-muted-foreground">{copy.sub}</p>
        </div>
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{copy.tag}</span>
      </header>

      {/* The chart, with its timeframe control. */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
        <span className="text-muted-foreground">
          BTCUSD · {shownTf}{selected ? ` · ${selected.name}` : ''}{drawn ? '' : setupsOn ? ' · no levels (not a TRADE)' : ' · setups off'}
        </span>
        {mode === 'single' ? (
          <label className="flex items-center gap-1 text-muted-foreground">
            timeframe
            <select aria-label="timeframe without the chain" value={singleTf} onChange={(e) => onSingleTf(e.target.value as EntryTf)}
                    className="rounded border border-border bg-transparent px-1 py-0.5 text-foreground">
              {SINGLE_TFS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        ) : (
          <div role="group" aria-label="chart timeframe" className="inline-flex overflow-hidden rounded border border-border">
            {SINGLE_TFS.map((x) => (
              <button key={x} type="button" aria-pressed={chartTf === x} onClick={() => setChartTf(x)}
                      className={cn('px-1.5 py-0.5', chartTf === x ? 'bg-[#2563eb] text-white' : 'text-muted-foreground')}>
                {x}
              </button>
            ))}
          </div>
        )}
      </div>
      <EntryChart bars={bars} plan={drawn} dir={selected?.dir ?? null} label={`${copy.title} chart`} />

      <div className="mt-2 grid gap-2 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <MethodTable mode={mode} reads={reads} selected={selected} onChoose={onChoose} recordOf={recordOf} />
        <div className="grid content-start gap-2">
          <SelectedCard read={selected} />
          <Reasons read={selected} />
          {mode === 'mtf' ? <TimeframeAnalysis rows={timeframes} /> : null}
        </div>
      </div>

      <details className="mt-2 rounded-lg border border-border p-2 text-[12px]">
        <summary className="cursor-pointer font-semibold">Pros and cons · {mode === 'mtf' ? 'with' : 'without'} timeframe</summary>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          <ul className="m-0 list-none p-0" aria-label="pros">{copy.pros.map((p) => <li key={p}><span className="text-[var(--up)]">✓</span> {p}</li>)}</ul>
          <ul className="m-0 list-none p-0" aria-label="cons">{copy.cons.map((p) => <li key={p}><span className="text-[var(--down)]">✗</span> {p}</li>)}</ul>
        </div>
        <p className="m-0 mt-1.5 text-[11px] text-muted-foreground">What each way is meant to do. Whether it does is the paper record below -- not this list.</p>
      </details>

      <RecordStrip total={total} />
    </section>
  );
}

function MethodTable({ mode, reads, selected, onChoose, recordOf }: {
  mode: EntryMode; reads: readonly MethodRead[]; selected: MethodRead | null;
  onChoose: (r: MethodRead) => void; recordOf: (r: MethodRead) => EntryRecord | null;
}) {
  const chain = mode === 'mtf';
  return (
    <div className="min-w-0 rounded-lg border border-border">
      <div className="px-2 pt-1.5 text-[12.5px] font-semibold">12 entry methods <span className="font-normal text-muted-foreground">{chain ? '· with timeframe proof' : `· ${reads[0]?.tf ?? ''} only`}</span></div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px] tabular-nums" aria-label={`${mode === 'mtf' ? 'with' : 'without'} timeframe methods`}>
          <thead className="text-left text-[10.5px] text-muted-foreground">
            <tr>
              <th className="py-1 pl-2">Method</th>
              {chain ? CHAIN_TFS.map((t) => <th key={t} className="px-0.5 text-center font-normal">{t.toUpperCase()}</th>) : null}
              <th className="px-1 text-center">Signal</th>
              <th className="px-1 text-right" title="Setup quality out of 100 -- not a chance of winning">Quality</th>
              <th className="sr-only">Choose</th>
            </tr>
          </thead>
          <tbody>
            {reads.map((r) => {
              const on = selected?.id === r.id;
              return (
                <tr key={r.id} className={cn('border-t border-border', on && 'bg-muted outline outline-1 outline-[#38bdf8]')}>
                  <td className="py-1 pl-2">
                    <button type="button" aria-pressed={on} onClick={() => onChoose(r)} title={recordText(recordOf(r))}
                            className="flex items-center gap-1.5 text-left hover:underline">
                      <NumberBadge read={r} /><span className="truncate">{r.name}</span>
                    </button>
                  </td>
                  {chain ? CHAIN_TFS.map((t) => {
                    const k = tickOf(r, t);
                    return <td key={t} className={cn('px-0.5 text-center', TICK_CLASS[k])}>{k}</td>;
                  }) : null}
                  <td className="px-1 text-center"><SignalChip read={r} /></td>
                  <td className="px-1 text-right">{r.score ?? '–'}</td>
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

function SelectedCard({ read }: { read: MethodRead | null }) {
  if (!read) return <div className="rounded-lg border border-border p-2 text-[12px] text-muted-foreground">Choose a method.</div>;
  const p = read.plan;
  const head = read.state === 'TRADE'
    ? { text: read.dir === 'short' ? 'SHORT SETUP' : 'LONG SETUP', cls: read.dir === 'short' ? 'bg-[#e2504f] text-white' : 'bg-[#26a17b] text-white' }
    : read.state === 'WAIT'
      ? { text: `WAIT${read.dir ? ` · ${read.dir} forming` : ''}`, cls: 'bg-[#b7791f] text-white' }
      : { text: 'NO TRADE', cls: 'bg-muted text-muted-foreground' };
  const mid = p ? (p.entryLo + p.entryHi) / 2 : null;
  const risk = p && mid !== null ? Math.abs(mid - p.stop) : null;
  const reward = p && mid !== null ? Math.abs(p.tp1 - mid) : null;
  const rOf = (tp: number) => (risk && mid !== null ? Math.abs(tp - mid) / risk : null);
  const pct = (pts: number) => (mid ? `${((100 * pts) / mid).toFixed(2)}%` : '');
  const row = (k: string, v: React.ReactNode, cls?: string) => (
    <><dt className="text-muted-foreground">{k}</dt><dd className={cn('m-0 text-right', cls)}>{v}</dd></>
  );
  return (
    <section aria-label="selected setup" className="rounded-lg border border-border text-[12px]">
      <div className="px-2 pt-1.5 font-semibold">Selected setup</div>
      <div className={cn('mx-2 my-1.5 rounded py-1 text-center text-[14px] font-bold', head.cls)}>{head.text}</div>
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
  const blocking = read.gates.filter((g) => !g.ok);
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
        {blocking.map((g) => (
          <li key={g.key} className="flex gap-1.5 text-[var(--down)]"><span>✗</span><span>{g.why ?? g.label}</span></li>
        ))}
      </ul>
    </section>
  );
}

function TimeframeAnalysis({ rows }: { rows: readonly TimeframeRow[] }) {
  if (!rows.length) return null;
  const arrow = (t: -1 | 0 | 1, label: string) => (label === 'Not read' ? '?' : t === 1 ? '↑' : t === -1 ? '↓' : '→');
  const cls = (t: -1 | 0 | 1) => (t === 1 ? 'text-[var(--up)]' : t === -1 ? 'text-[var(--down)]' : 'text-muted-foreground');
  return (
    <section aria-label="timeframe analysis" className="rounded-lg border border-border p-2 text-[12px]">
      <div className="mb-1 font-semibold">Timeframe analysis</div>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((r) => (
            <tr key={r.tf} className="border-t border-border first:border-t-0">
              <td className="py-0.5 pr-2 font-semibold">{r.tf.toUpperCase()}</td>
              <td className={cn('pr-2', cls(r.trend))}>{arrow(r.trend, r.label)} {r.label}</td>
              <td className="pr-2 text-muted-foreground">{r.structure}</td>
              <td className="text-right text-[11px] text-muted-foreground">{r.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1.5 flex flex-wrap gap-1" aria-label="timeframe trend view">
        {rows.map((r) => (
          <span key={r.tf} className={cn('rounded border border-border px-1 text-[10.5px]', cls(r.trend))}>{r.tf.toUpperCase()} {arrow(r.trend, r.label)}</span>
        ))}
      </div>
    </section>
  );
}

function RecordStrip({ total }: { total: EntryRecord | null }) {
  const has = total !== null && total.trades > 0;
  const cells: [string, string, string?][] = [
    ['Trades', has ? String(total!.trades) : '–'],
    ['Win rate', has ? `${Math.round((100 * total!.wins) / total!.trades)}%` : '–'],
    ['Profit factor', has && total!.profitFactor !== null ? total!.profitFactor.toFixed(2) : '–'],
    ['Net R', has && total!.sumR !== null ? signedR(total!.sumR, 1) : '–', has && (total!.sumR ?? 0) < 0 ? 'text-[var(--down)]' : 'text-[var(--up)]'],
    ['Max DD', has && total!.maxDrawdownR !== null ? `${total!.maxDrawdownR.toFixed(1)}R` : '–', 'text-[var(--down)]'],
  ];
  return (
    <section aria-label="paper record" className="mt-2 rounded-lg border border-border p-2">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="font-semibold">Paper record · all 12, at 5m, after fees</span>
        <span className="text-[11px] text-muted-foreground">{total && total.setups ? `${total.setups} logged${total.working ? `, ${total.working} working` : ''}` : 'no setups logged yet'}</span>
      </div>
      <dl className="m-0 grid grid-cols-5 gap-1 text-center">
        {cells.map(([k, v, c]) => (
          <div key={k} className="rounded bg-muted px-1 py-1">
            <dt className="text-[10.5px] text-muted-foreground">{k}</dt>
            <dd className={cn('m-0 text-[14px] font-bold tabular-nums', v === '–' ? 'text-muted-foreground' : c)}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
