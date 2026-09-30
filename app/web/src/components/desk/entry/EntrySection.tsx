import { useEffect, useMemo, useRef, useState } from 'react';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { getEntryAlerts, getEntryBoard, getEntryRecord } from '@/api/entry';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { EntryMode, EntryTf, MethodRead, TimeframeRow } from '@/types/entry';
import { EntryGrid } from './EntryGrid';
import { useEntryFeed, type DeskFeed } from './feed';
import { ModePanel, SINGLE_TFS } from './ModePanel';
import { MethodLegend } from './MethodLegend';
import { GateSwitches } from './GateSwitches';
import { GateChecklist } from './GateChecklist';
import { AlertSwitch } from './AlertSwitch';
import { SignalHistory } from './SignalHistory';
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

export function EntrySection({ desk, onTimeframes }: {
  /** The desk's live 5m candles, last trade, option board and positioning, for the charts. */
  desk: DeskFeed;
  /** Each read's timeframe rows, handed up for the Timeframe analysis card under the Big move catch. */
  onTimeframes?: (rows: TimeframeRow[]) => void;
}) {
  const [singleTf, setSingleTf] = usePersisted<EntryTf>('entry:single-tf', '5m');
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
  const tf = SINGLE_TFS.includes(singleTf) ? singleTf : '5m';
  const mtfTf = SINGLE_TFS.includes(mtfChartTf) ? mtfChartTf : '5m';
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
  // Each timeframe has its own record now (the server logs every one); the chain's entry is always 5m.
  const totalOf = (mode: EntryMode, at: EntryTf = '5m') => record?.totals.find((t) => t.mode === mode && t.tf === at) ?? null;
  const totalAllOf = (mode: EntryMode, at: EntryTf = '5m') => record?.totalsAll?.find((t) => t.mode === mode && t.tf === at) ?? null;
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
          <Switch label="Auto-select signals" checked={autoSelect} onCheckedChange={setAutoSelect}
                  description={autoSelect ? 'A new BUY / SELL takes its panel.' : 'Rows are chosen by hand only.'} />
          <GateSwitches onChanged={() => void rereadBoard()} />
          <Switch label="Setups on chart" checked={setupsOn} onCheckedChange={setSetupsOn}
                  description={setupsOn ? 'Entry, SL and TP drawn for a TRADE.' : 'Plain price charts.'} />
        </div>
      </header>

      {error && !board ? <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">Could not read the entry board: {error.message}</p> : null}

      {view === 'panels' ? (
        <>
          {/* The methods table three parts wide, the chosen method's hard gates the fourth; stacked below xl. */}
          <div className="mb-3 grid gap-3 xl:grid-cols-4">
            <div className="min-w-0 xl:col-span-3">
              <MethodLegend single={reads.filter((r) => r.mode === 'single')} mtf={reads.filter((r) => r.mode === 'mtf')}
                            chosenN={bothN} onChoose={chooseBoth} />
            </div>
            <GateChecklist selected={selected} mode={gatesMode === 'single' ? 'single' : 'mtf'} onMode={setGatesMode} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <ModePanel mode="single" reads={reads.filter((r) => r.mode === 'single')}
                       selected={selected.single} onChoose={choose} total={totalOf('single', tf)} totalAll={totalAllOf('single', tf)} recordOf={recordOf}
                       setupsOn={setupsOn} chartTf={tf} onChartTf={setSingleTf} chart={chart}
                       ltp={ltp} alert={<AlertSwitch mode="single" alerts={alerts} onChanged={setAlerts} />} autoPicked={autoPicked('single')} />
            <ModePanel mode="mtf" reads={reads.filter((r) => r.mode === 'mtf')}
                       selected={selected.mtf} onChoose={choose} total={totalOf('mtf')} totalAll={totalAllOf('mtf')} recordOf={recordOf}
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
        paper log and graded on 1m candles after taker fees; the records here are that log, from 30 Sep 2026, and nothing
        else. The desk's research found no directional rule on BTC that clears fees, so no order is placed from here.
      </p>
    </section>
  );
}

