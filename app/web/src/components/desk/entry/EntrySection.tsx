import { useEffect, useMemo } from 'react';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { getEntryBoard, getEntryRecord } from '@/api/entry';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { Candle } from '@/types/desk';
import type { EntryMode, EntryOverlay, EntryRecord, EntryState, EntryTf, MethodRead } from '@/types/entry';
import { EntryGrid } from './EntryGrid';

/**
 * The entry section: TEST.md's twelve entry methods, each read two ways --
 * with the timeframe chain (4H/1H context -> 30m/15m setup -> 5m entry -> 3m
 * confirmation -> 1m execution) and without it (one timeframe alone) -- 24
 * setups, each TRADE, WAIT or NO TRADE.
 *
 * The server decides every state (app/server/src/entry); this screen only
 * shows it. A TRADE's entry, stop and targets are drawn on the chart above when
 * it is chosen and Setups is on; a WAIT draws nothing, as TEST.md asks. Beside
 * each method is its own paper record after fees, with the chain and without
 * it -- the only number that can say whether any of this works. No orders.
 */

const SINGLE_TFS: readonly EntryTf[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
const CHAIN_TFS: readonly EntryTf[] = ['4h', '1h', '30m', '15m', '5m', '3m', '1m'];
const keyOf = (r: Pick<MethodRead, 'mode' | 'id'>) => `${r.mode}:${r.id}`;

const STATE: Record<EntryState, { text: string; cls: string }> = {
  TRADE: { text: 'TRADE', cls: 'border-[var(--up)] text-[var(--up)]' },
  WAIT: { text: 'WAIT', cls: 'border-[var(--warn)] text-[var(--warn)]' },
  NO_TRADE: { text: 'NO TRADE', cls: 'border-border text-muted-foreground' },
};

export function EntrySection({ bars, onOverlay }: {
  /** The desk's 5m candles, for the grid's charts with the timeframe chain. */
  bars: readonly Candle[];
  /** The chosen TRADE's levels, for the chart above; null when none is chosen or Setups is off. */
  onOverlay: (o: EntryOverlay | null) => void;
}) {
  const [singleTf, setSingleTf] = usePersisted<EntryTf>('entry:single-tf', '5m');
  const [setupsOn, setSetupsOn] = usePersisted<boolean>('entry:setups-on', true);
  const [view, setView] = usePersisted<'board' | 'grid'>('entry:view', 'board');
  const [gridMode, setGridMode] = usePersisted<EntryMode>('entry:grid-mode', 'mtf');
  const [chosen, setChosen] = usePersisted<string | null>('entry:chosen', null);
  const tf = SINGLE_TFS.includes(singleTf) ? singleTf : '5m';

  const { data: board, error } = usePoll(() => getEntryBoard(tf), 15_000, { deps: [tf] });
  const { data: record } = usePoll(() => getEntryRecord(), 60_000);

  const reads = board?.reads ?? [];
  const selected = reads.find((r) => keyOf(r) === chosen) ?? reads.find((r) => r.state === 'TRADE') ?? null;

  useEffect(() => {
    const p = selected?.plan;
    onOverlay(setupsOn && selected && p && selected.dir ? {
      dir: selected.dir, entryLo: p.entryLo, entryHi: p.entryHi, stop: p.stop,
      tp1: p.tp1, tp2: p.tp2, tp3: p.tp3, rr: p.rr,
      label: `#${selected.n} ${selected.name}${selected.mode === 'mtf' ? ' (with TF)' : ` (${selected.tf})`}`,
      triggerTime: selected.triggerTime,
    } : null);
  }, [selected, setupsOn, onOverlay]);

  const counts = useMemo(() => ({
    trade: reads.filter((r) => r.state === 'TRADE').length,
    wait: reads.filter((r) => r.state === 'WAIT').length,
  }), [reads]);
  const recordOf = (r: MethodRead) => record?.records.find((x) => x.method === r.id && x.mode === r.mode && x.tf === r.tf) ?? null;

  return (
    <CollapsibleCard
      id="entry-section"
      title="Entry setups · 12 methods × with / without timeframe"
      ariaLabel="entry setups"
      right={<span className="text-[11.5px] text-muted-foreground">{board ? `${counts.trade} trade · ${counts.wait} wait · of 24` : 'reading…'}</span>}
    >
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="entry view" className="inline-flex overflow-hidden rounded-md border border-border text-[12px]">
          {(['board', 'grid'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                    className={cn('px-2.5 py-1', view === v ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
              {v === 'board' ? 'Board + chart' : '12 charts'}
            </button>
          ))}
        </div>
        <Switch label="Setups on chart" checked={setupsOn} onCheckedChange={setSetupsOn}
                description={setupsOn ? 'The chosen TRADE is drawn: entry, SL, TP1-3.' : 'Off: the plain price chart.'} />
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          Without timeframe on
          <select aria-label="timeframe without the chain" value={tf} onChange={(e) => setSingleTf(e.target.value as EntryTf)}
                  className="rounded border border-border bg-transparent px-1 py-0.5 text-foreground">
            {SINGLE_TFS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>

      {error && !board ? <p role="alert" className="m-0 text-[12px] text-[var(--down)]">Could not read the entry board: {error.message}</p> : null}

      {view === 'board' ? (
        <>
          <BoardTable title="With timeframe" hint="4H → 1H → 30m → 15m → 5m entry → 3m confirm → 1m execution"
                      reads={reads.filter((r) => r.mode === 'mtf')} selected={selected} onChoose={(r) => setChosen(keyOf(r))} recordOf={recordOf} />
          <BoardTable title="Without timeframe" hint={`${tf} alone, no higher-timeframe checks`}
                      reads={reads.filter((r) => r.mode === 'single')} selected={selected} onChoose={(r) => setChosen(keyOf(r))} recordOf={recordOf} />
          {selected ? <Detail read={selected} record={recordOf(selected)} setupsOn={setupsOn} /> : null}
        </>
      ) : (
        <EntryGrid
          mode={gridMode}
          onMode={setGridMode}
          reads={reads.filter((r) => r.mode === gridMode)}
          fiveMinute={bars}
          singleTf={tf}
          setupsOn={setupsOn}
        />
      )}

      <p className="m-0 mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        The score is setup quality out of 100, not a chance of winning. Every TRADE is written to a paper log from
        30 Sep 2026 and graded on 1m candles after taker fees; the record column is that log. The desk's research has
        found no directional rule on BTC that clears fees (docs/research/findings.md) -- nothing here places an order.
      </p>
    </CollapsibleCard>
  );
}

/** ✓ all of that timeframe's checks passed, ✗ one failed, ? could not be read, · not part of this read. */
export function tickOf(read: MethodRead, tf: EntryTf): '✓' | '✗' | '?' | '·' {
  const steps = read.steps.filter((s) => s.tf === tf);
  if (!steps.length) return '·';
  if (steps.some((s) => s.ok === false)) return '✗';
  if (steps.some((s) => s.ok === null)) return '?';
  return '✓';
}

/** "12 trades · 42% · −0.08R", or how many are still working. */
export function recordText(r: EntryRecord | null): string {
  if (!r || r.setups === 0) return 'no record yet';
  if (r.trades === 0) return `${r.setups} logged, none closed`;
  const avg = r.avgR === null ? '' : ` · ${r.avgR >= 0 ? '+' : '−'}${Math.abs(r.avgR).toFixed(2)}R`;
  return `${r.trades} trade${r.trades === 1 ? '' : 's'} · ${Math.round((100 * r.wins) / r.trades)}%${avg}`;
}

function BoardTable({ title, hint, reads, selected, onChoose, recordOf }: {
  title: string; hint: string; reads: readonly MethodRead[]; selected: MethodRead | null;
  onChoose: (r: MethodRead) => void; recordOf: (r: MethodRead) => EntryRecord | null;
}) {
  const chain = reads[0]?.mode === 'mtf';
  return (
    <section className="mb-3" aria-label={`${title} entry methods`}>
      <h3 className="m-0 mb-1 text-[12.5px] font-semibold">{title} <span className="font-normal text-muted-foreground">· {hint}</span></h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px] tabular-nums">
          <thead className="text-left text-[11px] text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">#</th>
              <th className="py-1 pr-2">Method</th>
              {chain
                ? CHAIN_TFS.map((t) => <th key={t} className="px-1 text-center">{t.toUpperCase()}</th>)
                : <th className="px-1 text-center">{reads[0]?.tf.toUpperCase() ?? ''}</th>}
              <th className="px-2">State</th>
              <th className="px-2 text-right">R:R</th>
              <th className="px-2 text-right">Score</th>
              <th className="px-2">Record (paper, after fees)</th>
            </tr>
          </thead>
          <tbody>
            {reads.map((r) => {
              const on = selected !== null && keyOf(selected) === keyOf(r);
              return (
                <tr key={keyOf(r)} className={cn('border-t border-border', on && 'bg-muted')}>
                  <td className="py-1 pr-2 text-muted-foreground">{r.n}</td>
                  <td className="py-1 pr-2">
                    <button type="button" aria-pressed={on} onClick={() => onChoose(r)} className="text-left hover:underline">
                      {r.name}
                      {r.dir ? <span className={cn('ml-1', r.dir === 'long' ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{r.dir === 'long' ? '▲' : '▼'}</span> : null}
                    </button>
                  </td>
                  {(chain ? CHAIN_TFS : [r.tf]).map((t) => {
                    const k = tickOf(r, t);
                    return <td key={t} className={cn('px-1 text-center', k === '✓' ? 'text-[var(--up)]' : k === '✗' ? 'text-[var(--down)]' : 'text-muted-foreground')}>{k}</td>;
                  })}
                  <td className="px-2"><span className={cn('rounded border px-1.5 py-px text-[10.5px] font-semibold', STATE[r.state].cls)}>{STATE[r.state].text}</span></td>
                  <td className="px-2 text-right">{r.plan ? r.plan.rr.toFixed(1) : '–'}</td>
                  <td className="px-2 text-right">{r.score ?? '–'}</td>
                  <td className="px-2 text-muted-foreground">{recordText(recordOf(r))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');

function Detail({ read, record, setupsOn }: { read: MethodRead; record: EntryRecord | null; setupsOn: boolean }) {
  const failed = read.gates.filter((g) => !g.ok);
  return (
    <section aria-label="chosen entry setup" className="rounded-lg border border-border p-2.5 text-[12px]">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
        <strong>#{read.n} {read.name}</strong>
        <span className="text-muted-foreground">{read.mode === 'mtf' ? 'with timeframe, entry on 5m' : `without timeframe, on ${read.tf}`}</span>
        <span className={cn('rounded border px-1.5 py-px text-[10.5px] font-semibold', STATE[read.state].cls)}>{STATE[read.state].text}</span>
        {read.alignment !== null ? <span className="text-muted-foreground">timeframes agreeing {read.alignment}%</span> : null}
      </div>
      <p className="m-0 mb-2">{read.reason}</p>

      {read.plan ? (
        <dl className="m-0 mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">Entry</dt><dd className="m-0">{fmt(read.plan.entryLo)} – {fmt(read.plan.entryHi)}</dd>
          <dt className="text-muted-foreground">SL</dt><dd className="m-0 text-[var(--down)]">{fmt(read.plan.stop)}</dd>
          <dt className="text-muted-foreground">TP1</dt><dd className="m-0 text-[var(--up)]">{fmt(read.plan.tp1)} <span className="text-muted-foreground">{read.plan.tpWhy[0]}</span></dd>
          {read.plan.tp2 !== null ? <><dt className="text-muted-foreground">TP2</dt><dd className="m-0 text-[var(--up)]">{fmt(read.plan.tp2)} <span className="text-muted-foreground">{read.plan.tpWhy[1]}</span></dd></> : null}
          {read.plan.tp3 !== null ? <><dt className="text-muted-foreground">TP3</dt><dd className="m-0">{fmt(read.plan.tp3)} <span className="text-muted-foreground">expected-move edge</span></dd></> : null}
          <dt className="text-muted-foreground">R:R</dt><dd className="m-0">{read.plan.rr.toFixed(2)} to TP1, after fees</dd>
        </dl>
      ) : null}
      {read.plan && !setupsOn ? <p className="m-0 mb-2 text-muted-foreground">Setups is off: the chart is plain.</p> : null}

      {read.steps.length ? (
        <ul className="m-0 mb-2 list-none p-0">
          {read.steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className={cn('w-3', s.ok === true ? 'text-[var(--up)]' : s.ok === false ? 'text-[var(--down)]' : 'text-muted-foreground')}>
                {s.ok === true ? '✓' : s.ok === false ? '✗' : '?'}
              </span>
              <span className="w-9 text-muted-foreground">{s.tf?.toUpperCase()}</span>
              <span>{s.label}{s.ok === null ? ' (not read)' : ''}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {failed.length ? (
        <p className="m-0 mb-2 text-[var(--down)]">{failed.map((g) => g.why ?? g.label).join(' · ')}</p>
      ) : null}
      {read.scoreParts.length ? (
        <p className="m-0 text-muted-foreground">
          Quality {read.score}/100 — {read.scoreParts.map((p) => `${p.name} ${p.got === null ? 'not recorded' : `${p.got}/${p.max}`}`).join(' · ')}
        </p>
      ) : null}
      <p className="m-0 mt-1 text-muted-foreground">Paper record: {recordText(record)}</p>
    </section>
  );
}
