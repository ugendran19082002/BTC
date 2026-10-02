import { useEffect, useMemo, useRef, useState } from 'react';
import { FoldButton, useFold } from '@/components/ui/fold';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { getEntryAlerts, getEntryBoard, getEntryRecord } from '@/api/entry';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { EntryMode, EntryTf, MethodRead, TimeframeRow } from '@/types/entry';
import { EntryGrid } from './EntryGrid';
import { useEntryFeed, type DeskFeed } from './feed';
import { CHART_TFS, ModePanel } from './ModePanel';
import { MethodLegend } from './MethodLegend';
import { GateSwitches } from './GateSwitches';
import { GateChecklist } from './GateChecklist';
import { AlertSwitch } from './AlertSwitch';
import { SignalHistory } from './SignalHistory';
import './entry.css';

/**
 * The entry section: every entry method -- TEST.md's twelve first, then the
 * rest by the owner's numbers (74 since 1 Oct 2026) -- each read two ways --
 * without the timeframe chain (one timeframe alone) and with it (4H/1H ->
 * 30m/15m -> 5m entry -> 3m confirm -> 1m execution) -- 24 setups, laid out as
 * the owner's reference: the two ways side by side, each with its chart,
 * table, chosen setup and reasons, and the signal history underneath (its
 * TRADING tab is what is in play now). The per-panel paper-record strip and
 * the two-way comparison were removed at the owner's request.
 *
 * Each panel's chart is the desk's price chart (PriceChart), which decides no
 * entry of its own: it draws the panel's chosen TRADE when Setups is on. The
 * desk has no other chart since 30 Sep 2026.
 *
 * The server decides every state (app/server/src/entry); this screen shows it.
 * No orders: every TRADE is paper-logged and graded on 1m candles, in points and R
 * (docs/decisions/0013).
 */

const keyOf = (r: Pick<MethodRead, 'mode' | 'id'>) => `${r.mode}:${r.id}`;

export function EntrySection({ desk, onTimeframes, belowHeader }: {
  /** The desk's live 5m candles, last trade, option board and positioning, for the charts. */
  desk: DeskFeed;
  /** Each read's timeframe rows, handed up for the Timeframe analysis card under the Big move catch. */
  onTimeframes?: (rows: TimeframeRow[]) => void;
  /** Right under the header card (Perp / Mark / Index / Basis), before the panels: the signal strategies. */
  belowHeader?: React.ReactNode;
}) {
  const [singleTf, setSingleTf] = usePersisted<EntryTf>('entry:single-tf', '5m');
  const [open, setOpen] = useFold('entry-setups');
  const [setupsOn, setSetupsOn] = usePersisted<boolean>('entry:setups-on', true);
  const [view, setView] = usePersisted<'panels' | 'grid'>('entry:view-2', 'panels');
  const [gridMode, setGridMode] = usePersisted<EntryMode>('entry:grid-mode', 'mtf');
  const [chosen, setChosen] = usePersisted<{ single: string | null; mtf: string | null }>(
    'entry:chosen-2', { single: null, mtf: null },
  );
  const [mtfChartTf, setMtfChartTf] = usePersisted<EntryTf>('entry:mtf-chart-tf', '5m');
  const [gatesMode, setGatesMode] = usePersisted<EntryMode>('entry:gates-mode', 'mtf');
  // A signal chooses itself: with this on, a TRADE (BUY / SELL) takes the panel over whatever was picked by hand.
  const [autoSelect, setAutoSelect] = usePersisted<boolean>('entry:auto-select', true);
  // Telegram switches for both ways, read once and updated from what the server answers.
  const { data: alertsRead } = usePoll(() => getEntryAlerts(), 120_000);
  const [alerts, setAlerts] = useState(alertsRead ?? null);
  useEffect(() => { if (alertsRead) setAlerts(alertsRead); }, [alertsRead]);
  // The without panel's timeframe: its chart, and its reads unless it is a view-only one (1m: chart alone).
  const tf = CHART_TFS.includes(singleTf) ? singleTf : '5m';
  const mtfTf = CHART_TFS.includes(mtfChartTf) ? mtfChartTf : '5m';
  const shownTfs: EntryTf[] = view === 'panels' ? [tf, mtfTf] : [gridMode === 'mtf' ? '5m' : tf];
  const chart = useEntryFeed(desk, shownTfs);

  // Every 5 s (the server holds a read 3 s): a signal shows within seconds of the candle that made it.
  const { data: board, error, refresh: rereadBoard } = usePoll(() => getEntryBoard(tf), 5_000, { deps: [tf] });
  // The live price for the cards: the stream's last trade (~0.1 s), else the board's own.
  const ltp = desk.ltp ? { price: desk.ltp.price, at: desk.ltp.at } : board?.ltp ?? null;
  const { data: record } = usePoll(() => getEntryRecord(), 60_000);

  const reads = useMemo(() => board?.reads ?? [], [board]);
  useEffect(() => { if (board) onTimeframes?.(board.timeframes); }, [board, onTimeframes]);
  const pick = (mode: EntryMode) => {
    const mine = reads.filter((r) => r.mode === mode);
    // Unchosen: a TRADE, else a WAIT, else the most-formed refusal -- never "nothing forming" when something is.
    const formed = mine.filter((r) => r.dir !== null).sort((x, y) => (y.score ?? 0) - (x.score ?? 0))[0];
    return mine.find((r) => keyOf(r) === chosen[mode]) ?? mine.find((r) => r.state === 'TRADE') ?? mine.find((r) => r.state === 'WAIT') ?? formed ?? mine[0] ?? null;
  };
  const selected = { single: pick('single'), mtf: pick('mtf') };

  /*
   * Auto-select: a **new** signal (a TRADE not seen before -- method, way,
   * direction, trigger bar) chooses itself in its panel, the strongest first.
   * Only new ones: a signal that has been on the board for ten minutes does not
   * keep pulling the panel back from a row picked by hand. "AUTO" marks the
   * row while the choice is still the signal's.
   */
  const seenSignals = useRef(new Set<string>());
  const [autoKey, setAutoKey] = useState<Partial<Record<EntryMode, string>>>({});
  useEffect(() => {
    if (!autoSelect || !reads.length) return;
    const next = { ...chosen };
    const nextAuto = { ...autoKey };
    let changed = false;
    for (const mode of ['single', 'mtf'] as const) {
      const signals = reads.filter((r) => r.mode === mode && r.state === 'TRADE')
        .map((r) => ({ r, id: `${keyOf(r)}:${r.dir}:${r.triggerTime}` }));
      const fresh = signals.filter((s) => !seenSignals.current.has(s.id)).sort((x, y) => (y.r.score ?? 0) - (x.r.score ?? 0))[0];
      for (const s of signals) seenSignals.current.add(s.id);
      if (fresh) { next[mode] = keyOf(fresh.r); nextAuto[mode] = keyOf(fresh.r); changed = true; }
    }
    if (changed) { setChosen(next); setAutoKey(nextAuto); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads, autoSelect]);
  const autoPicked = (mode: EntryMode) => autoSelect && !!autoKey[mode] && chosen[mode] === autoKey[mode];

  const counts = { trade: reads.filter((r) => r.state === 'TRADE').length, wait: reads.filter((r) => r.state === 'WAIT').length };
  const recordOf = (r: MethodRead) => record?.records.find((x) => x.method === r.id && x.mode === r.mode && x.tf === r.tf) ?? null;
  const choose = (r: MethodRead) => setChosen({ ...chosen, [r.mode]: keyOf(r) });
  // From the method table: the same method on both sides.
  const chooseBoth = (id: string) => {
    const s = reads.find((r) => r.mode === 'single' && r.id === id);
    const m = reads.find((r) => r.mode === 'mtf' && r.id === id);
    setChosen({ single: s ? keyOf(s) : chosen.single, mtf: m ? keyOf(m) : chosen.mtf });
  };
  const bothId = selected.single && selected.mtf && selected.single.id === selected.mtf.id ? selected.single.id : null;
  // How many methods the board reads each way (74 since 1 Oct 2026), and so how many reads in all.
  const nMethods = new Set(reads.map((r) => r.id)).size || 12;
  const nReads = reads.length || 2 * nMethods;

  return (
    <section aria-label="entry setups" data-folded={!open} className="fold-host desk-entry mt-3">
      {/*
        One card: what the board says now on the left, the controls on the right.
        On a phone the controls drop under it as a two-column grid -- nothing
        runs off the screen -- and on a window they sit in one toolbar.
      */}
      <header className="fold-head mb-3 rounded-xl border border-border bg-[var(--panel)] p-3 shadow-[0_2px_12px_rgba(0,0,0,0.3)]">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h2 className="m-0 flex flex-wrap items-center gap-x-2 text-[16px] font-bold">
              <FoldButton open={open} onToggle={() => setOpen(!open)} label="entry setups" className="-ml-1.5" />
              Entry setups
              <span className="text-[12px] font-normal text-muted-foreground">{nMethods} methods × without / with timeframe = {nReads}</span>
            </h2>
            <div aria-label="board status" className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
              <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold', board ? 'bg-[var(--up-bg)] text-[var(--up)]' : 'bg-muted text-muted-foreground')}>
                <span aria-hidden className={cn('size-1.5 rounded-full', board ? 'animate-pulse bg-[var(--up)]' : 'bg-muted-foreground')} />
                {board ? 'Live' : 'Reading…'}
              </span>
              {board ? (
                <>
                  <span className="sr-only">{`${counts.trade} trade · ${counts.wait} wait · ${nReads - counts.trade - counts.wait} no trade`}</span>
                  <span aria-hidden className="rounded-full bg-[#26a17b]/20 px-2 py-0.5 font-semibold text-[#26a17b]">{counts.trade} TRADE</span>
                  <span aria-hidden className="rounded-full bg-[#b7791f]/20 px-2 py-0.5 font-semibold text-[#d69e2e]">{counts.wait} WAIT</span>
                  <span aria-hidden className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{nReads - counts.trade - counts.wait} NO TRADE</span>
                  <span className="text-muted-foreground">read {new Date(board.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · on closed candles</span>
                </>
              ) : null}
            </div>
            <PriceStrip perp={ltp?.price ?? null} mark={board?.quote?.mark ?? null} index={board?.quote?.index ?? null} />
          </div>
          <div className="grid w-full grid-cols-2 items-center gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:gap-3">
            <div role="group" aria-label="entry view" className="col-span-2 inline-flex overflow-hidden rounded-md border border-border text-[12px] sm:col-span-1">
              {(['panels', 'grid'] as const).map((v) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                        className={cn('flex-1 px-3 py-1.5 font-semibold sm:flex-none', view === v ? 'bg-[#2563eb] text-white' : 'text-muted-foreground hover:bg-muted')}>
                  {v === 'panels' ? 'Side by side' : 'Charts'}
                </button>
              ))}
            </div>
            <span aria-hidden className="hidden h-8 w-px bg-border sm:block" />
            <Switch label="Auto-select signals" checked={autoSelect} onCheckedChange={setAutoSelect}
                    description={autoSelect ? 'A new BUY / SELL takes its panel.' : 'Rows are chosen by hand only.'} />
            <Switch label="Setups on chart" checked={setupsOn} onCheckedChange={setSetupsOn}
                    description={setupsOn ? 'Entry, SL and TP drawn for a TRADE.' : 'Plain price charts.'} />
            <span aria-hidden className="hidden h-8 w-px bg-border sm:block" />
            <div className="col-span-2 sm:col-span-1"><GateSwitches onChanged={() => void rereadBoard()} /></div>
          </div>
        </div>
      </header>

      {/* Kept when the setups fold: the signal strategies have a fold of their own. */}
      {belowHeader && <div className="fold-keep">{belowHeader}</div>}

      {error && !board ? <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">Could not read the entry board: {error.message}</p> : null}

      {view === 'panels' ? (
        <>
          {/* The methods table three parts wide, the chosen method's hard gates the fourth; stacked below xl. */}
          <div className="mb-3 grid gap-3 xl:grid-cols-4">
            <div className="min-w-0 xl:col-span-3">
              <MethodLegend single={reads.filter((r) => r.mode === 'single')} mtf={reads.filter((r) => r.mode === 'mtf')}
                            chosenId={bothId} onChoose={chooseBoth} />
            </div>
            <GateChecklist selected={selected} mode={gatesMode === 'single' ? 'single' : 'mtf'} onMode={setGatesMode} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <ModePanel mode="single" reads={reads.filter((r) => r.mode === 'single')} count={nMethods}
                       selected={selected.single} onChoose={choose} recordOf={recordOf}
                       setupsOn={setupsOn} chartTf={tf} onChartTf={setSingleTf} chart={chart}
                       ltp={ltp} alert={<AlertSwitch mode="single" alerts={alerts} onChanged={setAlerts} />} autoPicked={autoPicked('single')} />
            <ModePanel mode="mtf" reads={reads.filter((r) => r.mode === 'mtf')} count={nMethods}
                       selected={selected.mtf} onChoose={choose} recordOf={recordOf}
                       setupsOn={setupsOn} chartTf={mtfTf} onChartTf={setMtfChartTf} chart={chart}
                       ltp={ltp} alert={<AlertSwitch mode="mtf" alerts={alerts} onChanged={setAlerts} />} autoPicked={autoPicked('mtf')} />
          </div>
          <SignalHistory />
        </>
      ) : (
        <EntryGrid mode={gridMode} onMode={setGridMode} reads={reads.filter((r) => r.mode === gridMode)} singleTf={tf} setupsOn={setupsOn} chart={chart} />
      )}

      <p className="m-0 mt-2 text-[11px] leading-relaxed text-[var(--dim)]">
        Quality is a setup score out of 100, not a chance of winning -- nothing measures that yet. Every TRADE is written to a
        paper log and graded on 1m candles, in points and R; the records here are that log, from 30 Sep 2026, and nothing
        else. No order is placed from here.
      </p>
    </section>
  );
}

/**
 * The three prices, each named for its job, so one is never read for another
 * (1 Oct 2026: a tab title showing the index was taken for the perpetual, and
 * a target looked passed that was not). The perpetual is what trades -- entry,
 * SL and TP are its levels; the mark is the fair-price check; the index is
 * context, and the basis says how far apart they are.
 */
export function PriceStrip({ perp, mark, index }: { perp: number | null; mark: number | null; index: number | null }) {
  if (perp === null && mark === null && index === null) return null;
  const f = (v: number | null) => (v === null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const basis = perp !== null && index !== null ? perp - index : null;
  const item = (label: string, value: string, job: string, strong = false) => (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className={strong ? 'font-semibold text-foreground' : 'text-muted-foreground'}>{label}</span>
      <b className={cn('tabular-nums', strong ? 'text-foreground' : 'font-medium text-muted-foreground')}>{value}</b>
      <span className="text-[10px] text-muted-foreground">{job}</span>
    </span>
  );
  return (
    <div aria-label="prices" className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11.5px]">
      {item('Perp', f(perp), 'entry · SL · TP', true)}
      {item('Mark', f(mark), 'risk check')}
      {item('Index', f(index), 'context')}
      {basis !== null ? item('Basis', `${basis >= 0 ? '+' : '−'}${Math.abs(basis).toFixed(1)}`, 'perp − index') : null}
    </div>
  );
}

