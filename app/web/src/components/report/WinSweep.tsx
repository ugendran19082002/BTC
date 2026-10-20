import { useState, type KeyboardEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import { pct } from '@/lib/format';
import { dayLabel, moneyText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { BtDayTrades, WinSweepAsk, WinSweepCell, WinSweepCellKey, WinSweepResult, WinSweepRow } from '@/types/signal-backtest';
import { DayTradesSheet } from '@/components/report/DayTrades';
import { Chip, Empty, Panel } from '@/components/mobile/parts';
import { Switch } from '@/components/ui/switch';
import { count, netClass } from '@/components/report/backtest-parts';
import { RunWinPick, winPickFor, winPickProblem, type WinPick } from '@/components/report/RunWinPick';

/**
 * Methods by win % at several bars at once (owner, 20 Oct 2026, after a table of net at win 50% to 75% worked by hand:
 * "an editable range -- the win %, the strategies and the least trades -- in the backtest and the portfolio section").
 *
 * A range of win % (from, to, a step), one or more least trades, the days the methods are picked on -- as the run's own
 * methods by win % -- and which rows: the run's saved backtests, ticked, or the settings, whole or by time frame. Each
 * cell is a backtest of that row with the methods that passed that bar: what a run with that one bar would make.
 *
 * Asked for with a tap, not with every change: it is a backtest for every list of methods the bars make.
 */

/** The most values the server takes: every pair of them is a backtest a row. */
export const SWEEP_PCTS_MAX = 12;
export const SWEEP_TRADES_MAX = 4;

type SweepDraft = { from: string; to: string; step: string; trades: string; split: boolean; skip: string[]; pick?: WinPick };
const SWEEP_DEFAULT: SweepDraft = { from: '50', to: '75', step: '5', trades: '1, 3', split: false, skip: [] };
const PCT_PRESETS = [
  { label: '50–75 by 5', from: 50, to: 75, step: 5 },
  { label: '50–90 by 10', from: 50, to: 90, step: 10 },
  { label: '60–80 by 5', from: 60, to: 80, step: 5 },
] as const;
const TRADE_PRESETS = ['1', '3', '1, 3', '1, 3, 5'] as const;

/** The win % values a range gives, from the first up by the step, the last included where the step lands on it. Or why not. */
export function pctsOf(from: string, to: string, step: string): number[] | string {
  const a = Number(from), b = Number(to), s = Number(step);
  if (![a, b].every((x) => from.trim() !== '' && to.trim() !== '' && Number.isInteger(x) && x >= 1 && x <= 100)) return 'The win % from and to are whole numbers from 1 to 100.';
  if (a > b) return 'The win % "from" is above the "to".';
  if (!(step.trim() !== '' && Number.isInteger(s) && s >= 1 && s <= 99)) return 'The step is a whole number of points, 1 or more.';
  const out: number[] = [];
  for (let x = a; x <= b; x += s) out.push(x);
  if (out.length > SWEEP_PCTS_MAX) return `That is ${out.length} win % values; at most ${SWEEP_PCTS_MAX} -- a bigger step, or a shorter range.`;
  return out;
}

/** The least trades typed, "1, 3": each a whole number 1 to 100, once, rising. Or why not. */
export function tradesOf(text: string): number[] | string {
  const xs = text.split(/[\s,]+/).filter((x) => x !== '').map(Number);
  if (!xs.length) return 'Type one or more least trades: 1, 3.';
  if (xs.some((x) => !(Number.isInteger(x) && x >= 1 && x <= 100))) return 'Each least trades is a whole number from 1 to 100.';
  const out = [...new Set(xs)].sort((a, b) => a - b);
  if (out.length > SWEEP_TRADES_MAX) return `At most ${SWEEP_TRADES_MAX} least-trades values at once.`;
  return out;
}

const field = 'h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] pl-3 text-[16px] tabular-nums text-foreground';
const span = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const daysWords = (from: string, to: string) => `${from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`} (${span(from, to)} day${span(from, to) === 1 ? '' : 's'})`;
const wonText = (c: NonNullable<WinSweepCell>) => (c.n ? pct(c.wins / c.n, 0) : '—');

/** The column of the row's best net among the bars, or -1 where none traded. */
function bestOf(cells: readonly WinSweepCell[]): number {
  let at = -1;
  cells.forEach((c, j) => { if (c && (at === -1 || c.net > cells[at]!.net)) at = j; });
  return at;
}

/** A cell: its net, trades and won %; with `onOpen`, a tap opens its trades one by one. */
function Cell({ c, best = false, label, onOpen }: { c: WinSweepCell; best?: boolean; label: string; onOpen?: () => void }) {
  if (c === null) {
    return <td className="px-2 py-1.5 text-right align-top text-muted-foreground"><span aria-label={`${label}: no method passed, nothing traded`}>—</span></td>;
  }
  const said = `${label}: ${moneyText(c.net)}, ${count(c.n)} trades, won ${wonText(c)}, ${count(c.methods)} methods${best ? ', the row\'s best' : ''}`;
  const body = (
    <>
      <span className={cn('block whitespace-nowrap', netClass(c.net), best && 'font-semibold')}>{moneyText(c.net)}{best && <span aria-hidden className="ml-0.5 text-[10px]">▲</span>}</span>
      <span className={cn('block whitespace-nowrap text-[11px] text-muted-foreground', onOpen && 'underline decoration-dotted underline-offset-2')}>{count(c.n)} · {wonText(c)}{onOpen && ' ›'}</span>
    </>
  );
  return (
    <td className={cn('px-2 py-1.5 text-right align-top', best && 'bg-[var(--chosen-soft)]')} aria-label={onOpen && c.n > 0 ? undefined : said}>
      {onOpen && c.n > 0 ? (
        <button type="button" onClick={onOpen} aria-label={`${said}: its trades`}
          className="m-0 -my-1 block min-h-[40px] w-full appearance-none border-0 bg-transparent px-0 py-1 text-right font-[inherit] text-[inherit]">
          {body}
        </button>
      ) : body}
    </td>
  );
}

/** One least-trades value: every row at every bar, as saved and every method beside them, the total under them. */
function SweepTable({ r, i, rows, onUse, onOpen }: {
  r: WinSweepResult; i: number; rows: WinSweepRow[]; onUse?: (pct: number, minTrades: number) => void;
  /** A row's cell tapped: its trades, one by one. */
  onOpen?: (row: WinSweepRow, cell: WinSweepCellKey, words: string) => void;
}) {
  const mt = r.minTrades[i]!;
  const worked = rows.filter((x) => x.problem === null);
  const total = r.total.cells[i]!;
  const top = bestOf(total);
  const th = 'sticky left-0 z-[1] bg-[var(--panel)] px-2 py-1.5 text-left';
  return (
    <section aria-label={`At least ${mt} trade${mt === 1 ? '' : 's'}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <h3 className="m-0 text-[14px] font-semibold">Net at each win % · at least {mt} trade{mt === 1 ? '' : 's'}</h3>
      <div className="min-w-0 overflow-x-auto rounded-md border border-[var(--line-soft)]">
        <table className="w-full border-collapse text-[13px] tabular-nums">
          <caption className="sr-only">Net after charges at each win %, of {mt}+ trades; under each, trades and won %</caption>
          <thead>
            <tr className="text-[11.5px] text-muted-foreground">
              <th scope="col" className={cn(th, 'font-medium')}>Strategy</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">As saved</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">All</th>
              {r.pcts.map((p) => <th key={p} scope="col" className="px-2 py-1.5 text-right font-medium">{p}%</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              if (x.problem !== null) {
                return (
                  <tr key={x.id} className="border-t border-[var(--line-soft)]">
                    <th scope="row" className={cn(th, 'font-medium')}>{x.name}</th>
                    <td colSpan={2 + r.pcts.length} className="px-2 py-1.5 text-[12px] text-muted-foreground">{x.problem}</td>
                  </tr>
                );
              }
              const best = bestOf(x.cells[i]!);
              return (
                <tr key={x.id} className="border-t border-[var(--line-soft)]">
                  <th scope="row" className={cn(th, 'font-medium')}>{x.name}</th>
                  <Cell c={x.saved} label={`${x.name}, as saved`} onOpen={onOpen && (() => onOpen(x, 'saved', 'as saved'))} />
                  <Cell c={x.all} label={`${x.name}, every method`} onOpen={onOpen && (() => onOpen(x, 'all', 'every method'))} />
                  {x.cells[i]!.map((c, j) => (
                    <Cell key={r.pcts[j]} c={c} best={j === best} label={`${x.name}, ${r.pcts[j]}%`}
                      onOpen={onOpen && (() => onOpen(x, { pct: r.pcts[j]!, minTrades: mt }, `${r.pcts[j]}% of ${mt}+`))} />
                  ))}
                </tr>
              );
            })}
            {worked.length > 1 && (
              <tr className="border-t-2 border-[var(--line)] font-semibold">
                <th scope="row" className={cn(th, 'font-semibold')}>Total</th>
                <Cell c={r.total.saved} label="Total, as saved" />
                <Cell c={r.total.all} label="Total, every method" />
                {total.map((c, j) => <Cell key={r.pcts[j]} c={c} best={j === top} label={`Total, ${r.pcts[j]}%`} />)}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {top >= 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <span>
            Best{worked.length > 1 ? ' total' : ''}: <b className="font-semibold">{r.pcts[top]}% of {mt}+</b> -- <span className={netClass(total[top]!.net)}>{moneyText(total[top]!.net)}</span>,
            {' '}{count(total[top]!.n)} trades, won {wonText(total[top]!)}
            {r.total.all && <> ({total[top]!.net >= r.total.all.net ? '+' : ''}{moneyText(total[top]!.net - r.total.all.net)} on every method)</>}.
          </span>
          {onUse && (
            <button type="button" onClick={() => onUse(r.pcts[top]!, mt)}
              className="min-h-[40px] rounded-md border border-[var(--accent)] bg-transparent px-3 font-[inherit] text-[13px] font-semibold text-[var(--accent)]">
              Use {r.pcts[top]}% of {mt}+ for the run
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function WinSweep({ scope, askKey, read, readTrades, run, members, onUse, wide = false }: {
  /** Whose: the single backtest's settings, or a run together's saved backtests. Each keeps its own values in this browser. */
  scope: 'single' | 'portfolio';
  /** What the result is of -- the backtest's or the run's own question -- so a sweep of other settings is said to be. */
  askKey: string;
  /** `ids`: the saved backtests ticked, of a run together; null for the single backtest. */
  read: (a: WinSweepAsk, ids: string[] | null) => Promise<WinSweepResult>;
  /** One row's cell, trade by trade, asked with what the sweep on the screen was worked with. */
  readTrades?: (a: WinSweepAsk, row: string, cell: WinSweepCellKey) => Promise<BtDayTrades>;
  /** The run's days: what the days picked on are checked against. */
  run: { from: string; to: string };
  /** A run together's saved backtests, to tick the rows from. */
  members?: { id: string; name: string }[];
  /** A bar taken over to the run's own methods by win %, with the days picked on here. */
  onUse?: (w: WinPick) => void;
  wide?: boolean;
}) {
  const [stored, setStored] = usePersisted<SweepDraft>(`signalBacktest.winSweep.${scope}`, SWEEP_DEFAULT);
  const d: SweepDraft = { ...SWEEP_DEFAULT, ...stored };
  // Picked on days the run is not on, to begin with -- an honest test; the same days are a tap away, and said for what they are.
  const pick: WinPick = d.pick ?? winPickFor(run);
  const put = (o: Partial<SweepDraft>) => setStored({ ...d, ...o });
  const pcts = pctsOf(d.from, d.to, d.step), trades = tradesOf(d.trades);
  const ids = members ? members.map((m) => m.id).filter((id) => !d.skip.includes(id)) : null;
  const pickProblem = winPickProblem(pick, run).problem;
  const problem = typeof pcts === 'string' ? pcts : typeof trades === 'string' ? trades
    : ids !== null && ids.length === 0 ? 'Tick one or more saved backtests.' : pickProblem;
  const ask: WinSweepAsk | null = problem === null && typeof pcts !== 'string' && typeof trades !== 'string'
    ? { pcts, minTrades: trades, on: pick.on, days: pick.days, pickFrom: pick.pickFrom, pickTo: pick.pickTo, split: scope === 'single' && d.split } : null;
  const [res, setRes] = useState<{ key: string; ask: WinSweepAsk; data: WinSweepResult | null; error: Error | null; busy: boolean } | null>(null);
  // The cell whose trades are open: its row, which cell, and the words for the sheet's title.
  const [open, setOpen] = useState<{ row: WinSweepRow; cell: WinSweepCellKey; words: string } | null>(null);
  const keyOf = (a: WinSweepAsk) => JSON.stringify({ askKey, a, ids });
  const stale = res !== null && res.data !== null && !res.busy && ask !== null && res.key !== keyOf(ask);
  const go = () => {
    if (!ask) return;
    const key = keyOf(ask);
    setRes((x) => ({ key, ask, data: x?.data ?? null, error: null, busy: true }));
    read(ask, ids).then(
      (data) => setRes((x) => (x?.key === key ? { key, ask, data, error: null, busy: false } : x)),
      (error: Error) => setRes((x) => (x?.key === key ? { key, ask, data: x.data, error, busy: false } : x)),
    );
  };
  const r = res?.data ?? null;
  const shown = r ? r.rows.filter((x) => x.problem !== null || (x.all?.n ?? 0) > 0) : [];
  const idle = r ? r.rows.filter((x) => x.problem === null && (x.all?.n ?? 0) === 0) : [];
  const bars = typeof pcts !== 'string' && typeof trades !== 'string' ? pcts.length * trades.length : 0;
  const rowsCount = ids?.length ?? 1;
  const enter = (e: KeyboardEvent) => { if (e.key === 'Enter') go(); };
  const one = (key: 'from' | 'to' | 'step', label: string, unit: string) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[12.5px] font-medium">{label}</span>
      <span className="relative min-w-0">
        <input type="number" inputMode="numeric" min={1} max={100} aria-label={`Win % ${label.toLowerCase()}`} value={d[key]}
          onChange={(e) => put({ [key]: e.target.value })} onKeyDown={enter} className={cn(field, unit.length > 1 ? 'pr-11' : 'pr-7')} />
        <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{unit}</span>
      </span>
    </label>
  );
  return (
    <Panel title={scope === 'portfolio' ? 'Methods by win % · sweep · over the run' : 'Methods by win % · sweep'}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        <p className="m-0 text-[13px] leading-snug text-muted-foreground">
          {scope === 'portfolio' ? 'Each saved backtest ticked' : 'The settings above'} traded with only the methods that won at least each win % of at least so many trades, on the days picked on below --
          one table a least trades, every win % side by side. <b className="font-medium text-foreground">Research only: nothing saved or live changes.</b>
        </p>
        <fieldset className="m-0 grid min-w-0 gap-2 rounded-md border border-[var(--line-soft)] px-3 py-2">
          <legend className="px-1 text-[13px] font-semibold">Win %</legend>
          <div role="group" aria-label="Win % ranges" className="flex flex-wrap gap-1.5">
            {PCT_PRESETS.map((p) => (
              <Chip key={p.label} on={d.from === String(p.from) && d.to === String(p.to) && d.step === String(p.step)}
                onClick={() => put({ from: String(p.from), to: String(p.to), step: String(p.step) })}>{p.label}</Chip>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 max-[340px]:grid-cols-1">
            {one('from', 'From', '%')}{one('to', 'To', '%')}{one('step', 'Step', 'pts')}
          </div>
          <p className="m-0 text-[12px] tabular-nums text-muted-foreground">{typeof pcts === 'string' ? '—' : pcts.map((x) => `${x}%`).join(' · ')}</p>
        </fieldset>
        <fieldset className="m-0 grid min-w-0 gap-2 rounded-md border border-[var(--line-soft)] px-3 py-2">
          <legend className="px-1 text-[13px] font-semibold">Least trades</legend>
          <div role="group" aria-label="Least trades presets" className="flex flex-wrap gap-1.5">
            {TRADE_PRESETS.map((t) => <Chip key={t} on={typeof trades !== 'string' && trades.join(', ') === t} onClick={() => put({ trades: t })}>{t}</Chip>)}
          </div>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[12.5px] font-medium">Least trades, one or more</span>
            <input type="text" inputMode="numeric" aria-label="Least trades, one or more" value={d.trades} placeholder="1, 3"
              onChange={(e) => put({ trades: e.target.value })} onKeyDown={enter} className={cn(field, 'pr-3')} />
          </label>
          {typeof trades !== 'string' && trades[0]! < 3 && <span className="text-[11.5px] text-[var(--warn)]">One or two trades is luck, not a record: 1 of 1 is 100%.</span>}
        </fieldset>
        <fieldset className="m-0 grid min-w-0 gap-2 rounded-md border border-[var(--line-soft)] px-3 py-2">
          <legend className="px-1 text-[13px] font-semibold">{scope === 'portfolio' ? 'Strategies' : 'Rows'}</legend>
          {members ? (
            <div role="group" aria-label="Saved backtests in the sweep" className="flex flex-wrap gap-1.5">
              <Chip on={d.skip.length === 0} onClick={() => put({ skip: d.skip.length === 0 ? members.map((m) => m.id) : [] })}>All</Chip>
              {members.map((m) => (
                <Chip key={m.id} on={!d.skip.includes(m.id)} onClick={() => put({ skip: d.skip.includes(m.id) ? d.skip.filter((x) => x !== m.id) : [...d.skip, m.id] })}>{m.name}</Chip>
              ))}
            </div>
          ) : (
            <Switch checked={d.split} onCheckedChange={(split) => put({ split })} label="Each time frame on its own row"
              description="Each time frame of the settings alone, its methods picked on its own record -- as saved backtests by time frame would be." />
          )}
        </fieldset>
        <fieldset className="m-0 grid min-w-0 gap-2 rounded-md border border-[var(--line-soft)] px-3 py-2">
          <legend className="px-1 text-[13px] font-semibold">Picked on</legend>
          <RunWinPick daysOnly value={pick} run={run} onChange={(w) => put({ pick: w })} whose={scope === 'portfolio' ? "Each saved backtest's" : "The settings'"} />
        </fieldset>
        <p role={problem ? 'alert' : 'status'} className={cn('m-0 text-[12.5px] leading-snug', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
          {problem ?? `${bars} bar${bars === 1 ? '' : 's'} × ${rowsCount} row${rowsCount === 1 ? '' : 's'}${scope === 'single' && d.split ? ' a time frame' : ''}: a backtest for each list of methods they make -- the same list once. Up to a minute on a long range.`}
        </p>
        <div className={cn('grid gap-2', wide ? 'grid-cols-[auto_auto] justify-start' : 'grid-cols-[minmax(0,1fr)_auto]')}>
          <button type="button" onClick={go} disabled={problem !== null || res?.busy === true}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-0 bg-[var(--chosen)] px-4 font-[inherit] text-[14px] font-semibold text-[var(--chosen-ink)] disabled:opacity-40">
            {res?.busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            {res?.busy ? 'Sweeping…' : r ? 'Sweep again' : 'Sweep'}
          </button>
          {JSON.stringify({ ...d, pick: undefined }) !== JSON.stringify({ ...SWEEP_DEFAULT, pick: undefined }) && (
            <button type="button" onClick={() => setStored(SWEEP_DEFAULT)} className="h-11 rounded-lg border border-border bg-transparent px-3 font-[inherit] text-[13.5px] text-foreground">Back to the defaults</button>
          )}
        </div>
        {res?.error && <p role="alert" className="m-0 text-[13px] text-[var(--down)]">Could not sweep: {res.error.message}</p>}
        {res?.busy && !r && <p role="status" className="m-0 text-[13px] text-muted-foreground">Picking and backtesting at every bar… up to a minute on a long range.</p>}
        {stale && <p role="status" className="m-0 rounded-md bg-[var(--chosen-soft)] px-3 py-2 text-[13px]">The settings or the bars changed since: below is the last sweep. Tap Sweep again for these.</p>}
        {r && (
          <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 transition-opacity', (stale || res?.busy) && 'opacity-50')} aria-busy={res?.busy}>
            <p className="m-0 text-[12.5px] leading-snug">
              <span className="text-muted-foreground">Picked on </span>{daysWords(r.pick.from, r.pick.to)}
              <span className="text-muted-foreground">, run on </span>{daysWords(r.from, r.to)}
              {r.pick.from === r.from && r.pick.to === r.to && <span className="text-[var(--warn)]"> -- the same days: in-sample, better than it can be</span>}.
            </p>
            {shown.length === 0 ? <Empty>No trade on these days to sweep.</Empty> : r.minTrades.map((_, i) => (
              <SweepTable key={r.minTrades[i]} r={r} i={i} rows={shown}
                onUse={onUse ? (p, mt) => onUse({ ...pick, pct: p, minTrades: mt }) : undefined}
                onOpen={readTrades && !res?.busy ? (row, cell, words) => setOpen({ row, cell, words }) : undefined} />
            ))}
            <p className="m-0 text-[12px] leading-snug text-muted-foreground">
              Net after charges, in rupees; under each, trades · won %{readTrades ? ' -- tap it for the trades, one by one' : ''}. ▲ the row&apos;s best; — no method passed the bar, so nothing traded. As saved: its own methods; All: every method.
              {' '}Each {scope === 'portfolio' ? 'saved backtest' : 'row'} alone, on its own limit{scope === 'portfolio' ? ' -- not the run\'s shared one' : ''}; {count(r.runs)} backtests.
              {idle.length > 0 && ` No trades: ${idle.map((x) => x.name).join(', ')}.`}
              {span(r.from, r.to) < 10 ? ` Run on ${span(r.from, r.to)} days: a short test -- a difference between bars can be luck.` : ''}
            </p>
          </div>
        )}
      </div>
      {/* One cell's trades, asked with what the sweep on the screen was worked with -- not the values typed since. */}
      <DayTradesSheet day={open && res ? `${open.row.id}|${JSON.stringify(open.cell)}|${res.key}` : null}
        title={open ? `${open.row.name} · ${open.words}` : undefined}
        read={() => readTrades!(res!.ask, open!.row.id, open!.cell)} onClose={() => setOpen(null)} />
    </Panel>
  );
}
