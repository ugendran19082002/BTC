import { useMemo } from 'react';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { getEntryBoard, getEntryRecord } from '@/api/entry';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { EntryMode, EntryRecord, EntryTf, MethodRead } from '@/types/entry';
import { EntryGrid } from './EntryGrid';
import { useEntryFeed, type DeskFeed } from './feed';
import { ModePanel, SINGLE_TFS } from './ModePanel';
import { MethodLegend } from './MethodLegend';
import { signedR } from './parts';
import './entry.css';

/**
 * The entry section: TEST.md's twelve entry methods, each read two ways --
 * without the timeframe chain (one timeframe alone) and with it (4H/1H ->
 * 30m/15m -> 5m entry -> 3m confirm -> 1m execution) -- 24 setups, laid out as
 * the owner's reference: the two ways side by side, each with its chart,
 * table, chosen setup, reasons and paper record, and the two records compared
 * underneath.
 *
 * Each panel's chart is the desk's price chart (PriceChart), which decides no
 * entry of its own: it draws the panel's chosen TRADE when Setups is on. The
 * desk has no other chart since 30 Sep 2026.
 *
 * The server decides every state (app/server/src/entry); this screen shows it.
 * No orders: every TRADE is paper-logged and graded after fees
 * (docs/decisions/0013).
 */

const keyOf = (r: Pick<MethodRead, 'mode' | 'id'>) => `${r.mode}:${r.id}`;

export function EntrySection({ desk }: {
  /** The desk's live 5m candles, last trade, option board and positioning, for the charts. */
  desk: DeskFeed;
}) {
  const [singleTf, setSingleTf] = usePersisted<EntryTf>('entry:single-tf', '5m');
  const [setupsOn, setSetupsOn] = usePersisted<boolean>('entry:setups-on', true);
  const [view, setView] = usePersisted<'panels' | 'grid'>('entry:view-2', 'panels');
  const [gridMode, setGridMode] = usePersisted<EntryMode>('entry:grid-mode', 'mtf');
  const [chosen, setChosen] = usePersisted<{ single: string | null; mtf: string | null }>(
    'entry:chosen-2', { single: null, mtf: null },
  );
  const [mtfChartTf, setMtfChartTf] = usePersisted<EntryTf>('entry:mtf-chart-tf', '5m');
  const tf = SINGLE_TFS.includes(singleTf) ? singleTf : '5m';
  const mtfTf = SINGLE_TFS.includes(mtfChartTf) ? mtfChartTf : '5m';
  const shownTfs: EntryTf[] = view === 'panels' ? [tf, mtfTf] : [gridMode === 'mtf' ? '5m' : tf];
  const chart = useEntryFeed(desk, shownTfs);

  const { data: board, error } = usePoll(() => getEntryBoard(tf), 15_000, { deps: [tf] });
  const { data: record } = usePoll(() => getEntryRecord(), 60_000);

  const reads = useMemo(() => board?.reads ?? [], [board]);
  const pick = (mode: EntryMode) => {
    const mine = reads.filter((r) => r.mode === mode);
    // Unchosen: a TRADE, else a WAIT, else the most-formed refusal -- never "nothing forming" when something is.
    const formed = mine.filter((r) => r.dir !== null).sort((x, y) => (y.score ?? 0) - (x.score ?? 0))[0];
    return mine.find((r) => keyOf(r) === chosen[mode]) ?? mine.find((r) => r.state === 'TRADE') ?? mine.find((r) => r.state === 'WAIT') ?? formed ?? mine[0] ?? null;
  };
  const selected = { single: pick('single'), mtf: pick('mtf') };

  const counts = { trade: reads.filter((r) => r.state === 'TRADE').length, wait: reads.filter((r) => r.state === 'WAIT').length };
  const recordOf = (r: MethodRead) => record?.records.find((x) => x.method === r.id && x.mode === r.mode && x.tf === r.tf) ?? null;
  const totalOf = (mode: EntryMode) => record?.totals.find((t) => t.mode === mode && t.tf === '5m') ?? null;
  const choose = (r: MethodRead) => setChosen({ ...chosen, [r.mode]: keyOf(r) });
  // From the method table: the same method on both sides.
  const chooseBoth = (n: number) => {
    const s = reads.find((r) => r.mode === 'single' && r.n === n);
    const m = reads.find((r) => r.mode === 'mtf' && r.n === n);
    setChosen({ single: s ? keyOf(s) : chosen.single, mtf: m ? keyOf(m) : chosen.mtf });
  };
  const bothN = selected.single && selected.mtf && selected.single.n === selected.mtf.n ? selected.single.n : null;

  return (
    <section aria-label="entry setups" className="desk-entry mt-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="m-0 text-[16px] font-bold">Entry setups <span className="font-normal text-muted-foreground">· 12 methods × without / with timeframe = 24</span></h2>
          <p className="m-0 text-[11.5px] text-muted-foreground">
            {board ? `${counts.trade} trade · ${counts.wait} wait · ${24 - counts.trade - counts.wait} no trade · read ${new Date(board.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'reading…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="entry view" className="inline-flex overflow-hidden rounded-md border border-border text-[12px]">
            {(['panels', 'grid'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                      className={cn('px-2.5 py-1', view === v ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
                {v === 'panels' ? 'Side by side' : '12 charts'}
              </button>
            ))}
          </div>
          <Switch label="Setups on chart" checked={setupsOn} onCheckedChange={setSetupsOn}
                  description={setupsOn ? 'Entry, SL and TP drawn for a TRADE.' : 'Plain price charts.'} />
        </div>
      </header>

      {error && !board ? <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">Could not read the entry board: {error.message}</p> : null}

      {view === 'panels' ? (
        <>
          <MethodLegend single={reads.filter((r) => r.mode === 'single')} mtf={reads.filter((r) => r.mode === 'mtf')}
                        chosenN={bothN} onChoose={chooseBoth} />
          <div className="grid gap-3 lg:grid-cols-2">
            <ModePanel mode="single" reads={reads.filter((r) => r.mode === 'single')} timeframes={board?.timeframes ?? []}
                       selected={selected.single} onChoose={choose} total={totalOf('single')} recordOf={recordOf}
                       setupsOn={setupsOn} chartTf={tf} onChartTf={setSingleTf} chart={chart} />
            <ModePanel mode="mtf" reads={reads.filter((r) => r.mode === 'mtf')} timeframes={board?.timeframes ?? []}
                       selected={selected.mtf} onChoose={choose} total={totalOf('mtf')} recordOf={recordOf}
                       setupsOn={setupsOn} chartTf={mtfTf} onChartTf={setMtfChartTf} chart={chart} />
          </div>
          <Comparison single={totalOf('single')} mtf={totalOf('mtf')} />
        </>
      ) : (
        <EntryGrid mode={gridMode} onMode={setGridMode} reads={reads.filter((r) => r.mode === gridMode)} singleTf={tf} setupsOn={setupsOn} chart={chart} />
      )}

      <p className="m-0 mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        Quality is a setup score out of 100, not a chance of winning -- nothing measures that yet. Every TRADE is written to a
        paper log and graded on 1m candles after taker fees; the records here are that log, from 30 Sep 2026, and nothing
        else. The desk's research found no directional rule on BTC that clears fees, so no order is placed from here.
      </p>
    </section>
  );
}

/** The two ways' paper records side by side: the reference's historical comparison, from the real log. */
function Comparison({ single, mtf }: { single: EntryRecord | null; mtf: EntryRecord | null }) {
  const has = (r: EntryRecord | null) => r !== null && r.trades > 0;
  const row = (label: string, f: (r: EntryRecord) => string) => (
    <tr key={label} className="border-t border-border">
      <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">{label}</th>
      <td className="px-3 text-right tabular-nums">{has(single) ? f(single!) : '–'}</td>
      <td className="px-3 text-right tabular-nums">{has(mtf) ? f(mtf!) : '–'}</td>
    </tr>
  );
  return (
    <section aria-label="with and without timeframe compared" className="mt-3 rounded-xl border border-border p-2.5 text-[12px]">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-[13px] font-bold">Without vs with timeframe · paper record</h3>
        <span className="text-[11px] text-muted-foreground">all 12 methods, 5m entries, after fees{!has(single) && !has(mtf) ? ' · no closed trades yet' : ''}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="text-[11px] text-muted-foreground">
            <tr><th className="text-left font-normal">Metric</th><th className="px-3 text-right">Without timeframe</th><th className="px-3 text-right">With timeframe</th></tr>
          </thead>
          <tbody>
            <tr className="border-t border-border">
              <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">Setups logged</th>
              <td className="px-3 text-right tabular-nums">{single?.setups ?? 0}</td>
              <td className="px-3 text-right tabular-nums">{mtf?.setups ?? 0}</td>
            </tr>
            {row('Trades closed', (r) => String(r.trades))}
            {row('Win rate', (r) => `${Math.round((100 * r.wins) / r.trades)}%`)}
            {row('Avg win', (r) => (r.avgWinR === null ? '–' : signedR(r.avgWinR)))}
            {row('Avg loss', (r) => (r.avgLossR === null ? '–' : signedR(r.avgLossR)))}
            {row('Profit factor', (r) => (r.profitFactor === null ? '–' : r.profitFactor.toFixed(2)))}
            {row('Net', (r) => (r.sumR === null ? '–' : signedR(r.sumR, 1)))}
            {row('Max drawdown', (r) => (r.maxDrawdownR === null ? '–' : `${r.maxDrawdownR.toFixed(1)}R`))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
