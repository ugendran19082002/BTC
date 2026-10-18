import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { getBacktestTrades, getLiveCheck, getSignalBacktest, getVolStudy, getVolStudyTrades } from '@/api/signal-backtest';
import { usePersisted } from '@/hooks/usePersisted';
import { pct } from '@/lib/format';
import { dayLabel, moneyText, timeIst } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import { time12 } from '@/lib/time';
import type { BacktestParams, BacktestQuery, BacktestSave, SavedQuery, TradePick } from '@/types/signal-backtest';
import { ALL_OPEN, Chip, Empty, FoldAll, Loading, Panel, PanelFolds, Segmented, Stat, Stats, type FoldState } from '@/components/mobile/parts';
import { FilterBar, FilterPicker, METHODS, STRATEGIES, type FilterSort } from '@/components/mobile/FilterPicker';
import { WIN_AT_LEAST_PCT } from '@/lib/win-line';
import { BacktestCurve } from '@/components/report/BacktestCurve';
import { DayTradesSheet } from '@/components/report/DayTrades';
import { SessionTable } from '@/components/report/SessionTable';
import { NoEntryFields, type SetField } from '@/components/strategy/form-parts';
import { backtestHours, backtestNoEntryProblems, noEntryQuery } from '@/lib/backtest-no-entry';
import type { NoEntry, StrategyConfig } from '@/types/strategy';
import { useExpiryRange } from '@/components/report/ExpiryRange';
import { Updating, useAnswer } from '@/components/report/Updating';
import { Entry, Ledger, SETTLE_MS, Table, count, each, marginWorking, netClass, rate } from '@/components/report/backtest-parts';
import { PortfolioRun, SavedBacktests, type TogetherRun } from '@/components/report/SavedBacktests';
import { LiveCheck } from '@/components/report/LiveCheck';
import { VolStudy } from '@/components/report/VolStudy';
import { BacktestStrikeBlocks } from '@/components/report/BacktestStrikeBlocks';
import { BacktestTsl } from '@/components/report/BacktestTsl';
import { BacktestPerpWiden } from '@/components/report/BacktestPerpWiden';
import { BacktestBreakEven } from '@/components/report/BacktestBreakEven';
import { breakEvenWords, tslProblems, tslWords } from '@/lib/backtest-tsl';
import { backtestBlockProblems, strikeBlocksWords } from '@/lib/backtest-strike-blocks';
import { BacktestBreakdowns, ChargesNote, DayAverages, GRAIN, ResultNav, WinnersLosers, pricedWords, skippedParts } from '@/components/report/BacktestBreakdowns';
import { AS_SAVED, type PortfolioCap, type PortfolioHours, type PortfolioLimit, type PortfolioOver } from '@/api/backtest-saves';
import { BACKTEST_DEFAULTS as DEFAULTS, PREMIUM_FLOOR as FLOOR, overWords, perpWidenWords, settingsWords } from '@/components/report/backtest-words';

/**
 * The backtest (owner, 13 Oct 2026): "can the signal history be backtested on the past contracts' market price?
 * Keep the perp's TGT and SL. When the perp's SL is hit the contract has often decayed, and the trade is a profit."
 *
 * Every signal that went in the trade, sold as an option at its fill -- the put on a BUY, the call on a SELL, at
 * the strike the rule picks from the board as it stood -- and bought back when the perp reached the signal's stop
 * or target, or the option its own target or stop first, or at the window's end. The owner's question has a panel
 * of its own: of the trades the perp's SL closed, how many were a profit all the same.
 *
 * One component for the phone's More menu and the foot of the desk's Methods screen, like the market report.
 * The settings are few and are chips, not fields: a backtest that needs typing is not read on a phone.
 */

const RULES: { key: BacktestParams['rule']; label: string; spoken: string }[] = [
  { key: 'delta', label: 'Strike by delta', spoken: 'Pick the strike by delta' },
  { key: 'premium', label: 'Strike by premium', spoken: 'Pick the strike by premium' },
];
const WINDOWS: { key: BacktestParams['window']; label: string; spoken: string }[] = [
  { key: 'desk', label: '9:30 PM–3:59 PM', spoken: 'Only signals from 9:30 PM to 3:59 PM' },
  { key: 'all', label: 'Whole day', spoken: 'Signals of the whole expiry day' },
  { key: 'custom', label: 'Custom', spoken: 'Signals in hours of your own' },
];
/** The same choice over a run together, with the one it starts on: each saved backtest's own hours. */
const RUN_WINDOWS: { key: PortfolioHours['window']; label: string; spoken: string }[] = [
  { key: 'saved', label: 'As saved', spoken: 'Each saved backtest keeps its own hours' },
  ...WINDOWS,
];

/**
 * Hours of the owner's own (13 Oct 2026, "custom"): a From and a To time, IST, the end not included -- read
 * forward from the From time, as a strategy's own hours are, so 10:00 PM to 2:00 AM runs past midnight.
 */
function CustomHours({ from, to, onApply, onClose }: { from: string; to: string; onApply: (from: string, to: string) => void; onClose: () => void }) {
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const ok = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const problem = !ok(a) || !ok(b) ? 'Pick both times.' : a === b ? 'The From and To times must differ.' : null;
  const field = 'h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-2 text-[16px] text-foreground [color-scheme:dark]';
  return (
    <div className="grid gap-2 rounded-md border border-[var(--line-soft)] p-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12.5px] text-[var(--time)]">From (IST)</span>
          <input type="time" className={field} value={a} onChange={(e) => setA(e.target.value)} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12.5px] text-[var(--time)]">To (IST)</span>
          <input type="time" className={field} value={b} onChange={(e) => setB(e.target.value)} />
        </label>
      </div>
      <p role={problem ? 'alert' : 'status'} className={cn('m-0 text-[13px]', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
        {problem ?? `Signals filled from ${time12(a)} to ${time12(b)}${b < a ? ', past midnight' : ''}. A trade still exits by its own SL, TGT or the expiry.`}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={onClose} className="h-11 rounded-lg border border-border bg-transparent font-[inherit] text-[14px] text-foreground">Cancel</button>
        <button type="button" disabled={problem !== null} onClick={() => onApply(a, b)}
          className="h-11 rounded-lg border-0 bg-[var(--chosen)] font-[inherit] text-[14px] font-semibold text-[var(--chosen-ink)] disabled:opacity-40">Use these hours</button>
      </div>
    </div>
  );
}
const DELTAS = [0.05, 0.1, 0.15, 0.2];
const PREMIUMS = [25, 50, 75, 100];
const STOPS: { value: number; label: string }[] = [{ value: 1, label: '+100%' }, { value: 1.5, label: '+150%' }, { value: 3, label: '+300%' }, { value: 0, label: 'No stop' }];
const LOTS = [1, 10, 16];
/** The least premium an option is sold for, dollars: the desk's own 10 to begin with; 0 is no floor (owner, 13 Oct 2026). */
const MIN_PREMIUMS = [0, 10, 15, 20];
const TARGETS: { value: number; label: string }[] = [{ value: 0.7, label: '70%' }, { value: 0.8, label: '80%' }, { value: 0.9, label: '90%' }, { value: 0, label: 'No target' }];

/**
 * One setting's own number (owner, 13 Oct 2026: "custom"): typed, in the unit the row reads in, checked against the
 * same limits the server holds it to, and applied on Enter or on leaving the field. `toShown` and `fromShown` turn
 * the stored value into what is typed and back -- a stop of 1.5 is typed as 150 (%).
 */
type Custom = { unit: string; min: number; max: number; step: number; whole?: boolean; toShown: (v: number) => number; fromShown: (v: number) => number; label: (v: number) => string };
const CUSTOM = {
  delta: { unit: 'delta', min: 0.02, max: 0.5, step: 0.01, toShown: (v) => v, fromShown: (v) => Math.round(v * 100) / 100, label: (v) => v.toFixed(2) },
  premium: { unit: '$', min: 10, max: 500, step: 1, toShown: (v) => v, fromShown: (v) => Math.round(v * 10) / 10, label: (v) => `$${v}` },
  stop: { unit: '% over', min: 0, max: 1000, step: 10, toShown: (v) => Math.round(v * 100), fromShown: (v) => Math.round(v) / 100, label: (v) => (v > 0 ? `+${Math.round(v * 100)}%` : 'No stop') },
  target: { unit: '% kept', min: 0, max: 99, step: 5, toShown: (v) => Math.round(v * 100), fromShown: (v) => Math.round(v) / 100, label: (v) => (v > 0 ? `${Math.round(v * 100)}%` : 'No target') },
  lots: { unit: 'lots', min: 1, max: 1000, step: 1, whole: true, toShown: (v) => v, fromShown: (v) => v, label: (v) => String(v) },
  deskMax: { unit: 'open', min: 0, max: 500, step: 1, whole: true, toShown: (v) => v, fromShown: (v) => v, label: (v) => (v > 0 ? String(v) : 'No limit') },
  minPremium: { unit: '$', min: 0, max: 500, step: 1, toShown: (v) => v, fromShown: (v) => Math.round(v * 10) / 10, label: (v) => (v > 0 ? `$${v}` : 'Off') },
  sidePct: { unit: '%', min: 1, max: 100, step: 5, toShown: (v) => v, fromShown: (v) => Math.round(v), label: (v) => `${v}%` },
} satisfies Record<string, Custom>;

type Range = { slMin: number; slMax: number; tgtMin: number; tgtMax: number };
const RANGE_KEYS = ['slMin', 'slMax', 'tgtMin', 'tgtMax'] as const;
/** What is wrong with a range, in words, or null: as the server checks it. */
export function rangeProblem(r: Range): string | null {
  if (RANGE_KEYS.some((k) => !(r[k] >= 0 && r[k] <= 20_000))) return 'Each distance is from 0 (off) to 20,000 points.';
  if (r.slMin > 0 && r.slMax > 0 && r.slMax < r.slMin) return 'The SL maximum must not be under its minimum.';
  if (r.tgtMin > 0 && r.tgtMax > 0 && r.tgtMax < r.tgtMin) return 'The TGT maximum must not be under its minimum.';
  return null;
}

/**
 * "Take a signal only if its SL and TGT are in range" (owner, 13 Oct 2026), laid out as the strategy form lays it:
 * SL ≥ and ≤, TGT ≥ and ≤, BTC points from the perp entry, 0 off. Typed into drafts and applied on leaving a field
 * or on Enter, all four together -- a minimum is never sent with a maximum under it.
 */
function SlTgtRange({ value, onApply }: { value: Range; onApply: (r: Range) => void }) {
  const [draft, setDraft] = useState<Record<keyof Range, string>>(() => ({ slMin: String(value.slMin), slMax: String(value.slMax), tgtMin: String(value.tgtMin), tgtMax: String(value.tgtMax) }));
  /*
   * The fields follow the range in force when it changes from outside (15 Oct 2026): a saved backtest put on the
   * screen showed its 200s below and the last one's 250s in the fields -- and leaving a field would have put the 250s
   * back. Nothing is applied while a field is being typed in, so this never overwrites typing.
   */
  useEffect(() => {
    setDraft({ slMin: String(value.slMin), slMax: String(value.slMax), tgtMin: String(value.tgtMin), tgtMax: String(value.tgtMax) });
  }, [value.slMin, value.slMax, value.tgtMin, value.tgtMax]);
  const parsed: Range = { slMin: Number(draft.slMin || 0), slMax: Number(draft.slMax || 0), tgtMin: Number(draft.tgtMin || 0), tgtMax: Number(draft.tgtMax || 0) };
  const problem = rangeProblem(parsed);
  const apply = () => { if (problem === null && RANGE_KEYS.some((k) => parsed[k] !== value[k])) onApply(parsed); };
  const field = (k: keyof Range, label: string) => (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className="relative min-w-0 flex-1">
        <input type="number" inputMode="numeric" min={0} max={20_000} step={10} aria-label={`${k.startsWith('sl') ? 'SL' : 'TGT'} ${k.endsWith('Min') ? 'at least' : 'at most'}, points`}
          value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} onBlur={apply} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
          className="h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] pl-3 pr-9 text-[15px] tabular-nums text-foreground [color-scheme:dark]" />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">pts</span>
      </span>
    </label>
  );
  const on = RANGE_KEYS.some((k) => value[k] > 0);
  return (
    <section aria-label="SL and TGT range" className="grid gap-2 border-0 border-b border-solid border-[var(--line-soft)] pb-3">
      <div className="text-[13px] font-semibold">Take a signal only if its SL and TGT are in range</div>
      <p className="m-0 text-[12px] leading-snug text-muted-foreground">BTC points from the perp entry to the signal&apos;s SL, and to its TGT1: at least (≥) and at most (≤). 0 is off; each is its own condition.</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <div className="col-span-2 text-[12.5px] font-medium text-[var(--down)]">SL</div>
        {field('slMin', '≥')}{field('slMax', '≤')}
        <div className="col-span-2 text-[12.5px] font-medium text-[var(--up)]">TGT</div>
        {field('tgtMin', '≥')}{field('tgtMax', '≤')}
      </div>
      <p role={problem ? 'alert' : 'status'} className={cn('m-0 text-[12.5px]', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
        {problem ?? (on
          ? `Taken: SL ${value.slMin > 0 ? `≥ ${value.slMin}` : ''}${value.slMin > 0 && value.slMax > 0 ? ' and ' : ''}${value.slMax > 0 ? `≤ ${value.slMax}` : ''}${!(value.slMin > 0 || value.slMax > 0) ? 'any' : ''} pts · TGT ${value.tgtMin > 0 ? `≥ ${value.tgtMin}` : ''}${value.tgtMin > 0 && value.tgtMax > 0 ? ' and ' : ''}${value.tgtMax > 0 ? `≤ ${value.tgtMax}` : ''}${!(value.tgtMin > 0 || value.tgtMax > 0) ? 'any' : ''} pts`
          : 'Off: every signal, whatever its SL and TGT.')}
      </p>
      {on && <button type="button" onClick={() => { setDraft({ slMin: '0', slMax: '0', tgtMin: '0', tgtMax: '0' }); onApply({ slMin: 0, slMax: 0, tgtMin: 0, tgtMax: 0 }); }}
        className="justify-self-start min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">Turn the range off</button>}
    </section>
  );
}

type Step = { at: string; pct: number };
/** Every two hours from 11:30 PM to 3:30 PM: the times a schedule's steps fall on, as the owner's own strategies have them. */
const STEP_TIMES = ['23:30', '01:30', '03:30', '05:30', '07:30', '09:30', '11:30', '13:30', '15:30'];
/** A schedule from one share to another in even steps, every two hours: 70 → 97 is +3 each time. */
const ladder = (from: number, to: number): Step[] => STEP_TIMES.map((at, i) => ({ at, pct: Math.round(from + ((to - from) * (i + 1)) / STEP_TIMES.length) / 100 }));
const LADDERS: { label: string; start: number; steps: Step[] }[] = [
  { label: '70% → 97%', start: 0.7, steps: ladder(70, 97) },
  { label: '60% → 90%', start: 0.6, steps: ladder(60, 90) },
  { label: '70% → 99%', start: 0.7, steps: ladder(70, 99) },
];
/** What is wrong with a schedule, in words, or null: as the server checks it. */
export function stepsProblem(rows: readonly { at: string; pct: string }[]): string | null {
  if (rows.length === 0) return 'Add at least one step, or choose Fixed.';
  if (rows.length > 24) return 'At most 24 steps.';
  if (rows.some((r) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.at))) return 'Give every step a time.';
  if (rows.some((r) => r.pct.trim() === '' || !(Number(r.pct) >= 1 && Number(r.pct) <= 99))) return 'Each step keeps from 1% to 99% of the premium.';
  if (new Set(rows.map((r) => r.at)).size !== rows.length) return 'Two steps have the same time.';
  return null;
}
/** The expiry day's own order of the clock: forward from 5:30 PM, so 11:30 PM comes before 1:30 AM. */
const dayOrder = (at: string) => { const [h, m] = at.split(':').map(Number) as [number, number]; return (h * 60 + m - (17 * 60 + 30) + 1_440) % 1_440; };

/**
 * A target by the clock (owner, 13 Oct 2026: "fixed, or dynamic time-based -- first which, then its settings"), as
 * the strategy form has it: where it starts, then a time and a per cent for each step. Edited as a draft -- a
 * ready ladder, a strategy's own steps copied, or typed -- and used with one tap, so a half-typed time is never
 * backtested.
 */
function TargetSteps({ start, steps, copyFrom, onApply }: {
  start: number; steps: readonly Step[];
  copyFrom: { name: string; pct: number; steps: Step[] }[];
  onApply: (start: number, steps: Step[]) => void;
}) {
  const asRows = (xs: readonly Step[]) => xs.map((x) => ({ at: x.at, pct: String(Math.round(x.pct * 10_000) / 100) }));
  const [first, setFirst] = useState(String(Math.round(start * 100)));
  const [rows, setRows] = useState(() => asRows(steps));
  const startOk = Number(first) >= 1 && Number(first) <= 99;
  const problem = !startOk ? 'The target starts at 1% to 99% of the premium.' : stepsProblem(rows);
  const parsed = (): Step[] => rows.map((r) => ({ at: r.at, pct: Math.round(Number(r.pct) * 100) / 10_000 })).sort((a, b) => dayOrder(a.at) - dayOrder(b.at));
  const same = steps.length > 0 && Math.round(start * 100) === Number(first) && JSON.stringify(parsed()) === JSON.stringify(steps);
  const load = (s: number, xs: readonly Step[]) => { setFirst(String(Math.round(s * 100))); setRows(asRows(xs)); };
  // Whose steps are in use, where they are a strategy's own unchanged: what the list shows as chosen.
  const from = copyFrom.findIndex((x) => Math.round(x.pct * 100) === Math.round(start * 100) && JSON.stringify(x.steps) === JSON.stringify(steps));
  const field = 'h-11 min-w-0 rounded-md border border-border bg-[var(--bg)] px-2 text-[15px] tabular-nums text-foreground [color-scheme:dark]';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-md border border-[var(--line-soft)] p-3 max-sm:p-2">
      {copyFrom.length > 0 ? (
        // The steps are the strategies' own (owner, 13 Oct 2026: "don't fill steps in -- the strategy has them, take them from there"): choosing one uses it at once.
        <label className="grid gap-1">
          <span className="text-[12px] text-muted-foreground">Target steps of</span>
          <select aria-label="Whose target steps" value={from === -1 ? '' : String(from)}
            onChange={(e) => { const x = copyFrom[Number(e.target.value)]; if (e.target.value !== '' && x) { load(x.pct, x.steps); onApply(x.pct, x.steps); } }}
            className="h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-3 text-[15px] text-foreground [color-scheme:dark]">
            {from === -1 && <option value="">Your own steps, below</option>}
            {copyFrom.map((x, i) => <option key={`${x.name}-${i}`} value={i}>{x.name} · {Math.round(x.pct * 100)}% → {Math.round((x.steps.at(-1)?.pct ?? x.pct) * 100)}%, {x.steps.length} step{x.steps.length === 1 ? '' : 's'}</option>)}
          </select>
        </label>
      ) : (
        // No strategy has time steps to take: a ready schedule to start from instead.
        <div role="group" aria-label="Ready schedules" className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-muted-foreground">No strategy has target steps to take. Start from:</span>
          {LADDERS.map((l) => <Chip key={l.label} on={false} onClick={() => load(l.start, l.steps)}>{l.label}</Chip>)}
        </div>
      )}
      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-[13px] text-muted-foreground">Starts at</span>
        <input type="number" inputMode="decimal" min={1} max={99} aria-label="Target to start with, per cent" value={first} onChange={(e) => setFirst(e.target.value)} className={cn(field, 'w-24')} />
        <span className="text-[12.5px] text-muted-foreground">% of the premium kept</span>
      </label>
      <ol className="m-0 grid list-none gap-1.5 p-0" aria-label="Target steps">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center gap-2 max-sm:gap-1.5">
            <input type="time" aria-label={`Step ${i + 1} time, IST`} value={r.at} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, at: e.target.value } : x)))} className={cn(field, 'w-0 min-w-[7.75rem] flex-1 max-sm:px-1.5')} />
            <input type="number" inputMode="decimal" min={1} max={99} aria-label={`Step ${i + 1} per cent`} value={r.pct} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, pct: e.target.value } : x)))} className={cn(field, 'w-20 max-sm:w-14')} />
            <span className="text-[12.5px] text-muted-foreground">%</span>
            <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-md border-0 bg-transparent text-[18px] text-muted-foreground max-sm:w-9">×</button>
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => setRows([...rows, { at: '', pct: rows.at(-1)?.pct ?? first }])} disabled={rows.length >= 24}
        className="h-10 justify-self-start rounded-md border border-border bg-transparent px-3 font-[inherit] text-[13.5px] text-foreground disabled:opacity-40">Add a step</button>
      <p role={problem ? 'alert' : 'status'} className={cn('m-0 text-[12.5px] leading-snug', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
        {problem ?? (same ? 'In use. At each time the target of every open trade moves to that share, and a trade sold after starts at it. Times are IST, read from 5:30 PM.' : 'Changed: not in use yet.')}
      </p>
      {!same && (
        <button type="button" disabled={problem !== null} onClick={() => onApply(Number(first) / 100, parsed())}
          className="h-11 rounded-lg border-0 bg-[var(--chosen)] font-[inherit] text-[14px] font-semibold text-[var(--chosen-ink)] disabled:opacity-40">Use these steps</button>
      )}
    </div>
  );
}

/**
 * One group of settings under its own heading, that folds to a line of what it is set to (owner, 16 Oct 2026: "the
 * backtest's settings, expand and collapse, user friendly"). Folded or not is the screen's to keep (`shut`).
 */
function Section({ title, summary, open = true, onToggle, children }: {
  title: string;
  /** What it is set to, in a line: shown while it is folded. */
  summary?: string;
  open?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  return (
    // One column that may be narrower than what is in it: a bare `grid` column is as wide as its widest child, and pushed the phone's page sideways.
    <section aria-label={title} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 rounded-md border border-[var(--line-soft)] p-3 max-sm:rounded-none max-sm:border-0 max-sm:border-t max-sm:px-0 max-sm:pb-1 max-sm:pt-3 max-sm:first:border-t-0 max-sm:first:pt-0">
      <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">
        {onToggle ? (
          <button type="button" aria-expanded={open} onClick={onToggle}
            className="m-0 -my-1 flex min-h-[32px] w-full appearance-none items-center gap-1.5 border-0 bg-transparent p-0 text-left font-[inherit] text-[12px] font-semibold uppercase tracking-[0.6px] text-muted-foreground hover:text-foreground">
            <ChevronDown size={14} aria-hidden className={cn('shrink-0 transition-transform', !open && '-rotate-90')} />
            {title}
          </button>
        ) : title}
      </h3>
      {!open && summary && <p aria-label={`${title}: as set`} className="m-0 -mt-1 pl-5 text-[12.5px] normal-case leading-snug tracking-normal text-foreground [overflow-wrap:anywhere]">{summary}</p>}
      {open && children}
    </section>
  );
}

/** The "Custom" chip of a row and, once tapped, its field. On while the value is not one of the row's own. */
function CustomValue({ value, presets, spec, name, onChange }: { value: number; presets: readonly number[]; spec: Custom; name: string; onChange: (v: number) => void }) {
  const mine = !presets.some((p) => Math.abs(p - value) < 1e-9);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(String(spec.toShown(value)));
  const n = Number(text);
  const problem = text.trim() === '' || !Number.isFinite(n) ? 'Type a number.'
    : n < spec.min || n > spec.max ? `From ${spec.min} to ${spec.max}.`
      : spec.whole && !Number.isInteger(n) ? 'A whole number.' : null;
  const apply = () => { if (problem === null) { onChange(spec.fromShown(n)); setOpen(false); } };
  return (
    <>
      <Chip on={mine || open} onClick={() => { setText(String(spec.toShown(value))); setOpen((o) => !o); }}>
        {mine && !open ? `Custom · ${spec.label(value)}` : 'Custom'}
      </Chip>
      {open && (
        <span className="flex shrink-0 items-center gap-1.5">
          <input
            type="number" inputMode="decimal" aria-label={`${name}, your own`} autoFocus
            min={spec.min} max={spec.max} step={spec.step} value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') setOpen(false); }}
            className="h-10 w-24 rounded-md border border-border bg-[var(--bg)] px-2 text-[15px] text-foreground [color-scheme:dark]"
          />
          <span className="text-[12.5px] text-muted-foreground">{spec.unit}</span>
          <button type="button" onClick={apply} disabled={problem !== null}
            className="h-10 rounded-md border-0 bg-[var(--chosen)] px-3 font-[inherit] text-[13.5px] font-semibold text-[var(--chosen-ink)] disabled:opacity-40">Use</button>
          {problem && <span role="alert" className="text-[12.5px] text-[var(--down)]">{problem}</span>}
        </span>
      )}
    </>
  );
}
const DESK_MAX = [0, 20, 35, 58];
const SIDE_PCTS = [50, 60, 70, 80, 90, 100];
/** Each side's most open, as the desk rounds it (strategy/types.ts `sideCaps`): at least one, never more than the whole. */
const sideOf = (max: number, pctOf: number) => Math.min(max, Math.max(1, Math.round((max * pctOf) / 100)));

function ChipRow({ label, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 px-1 text-[12px] text-muted-foreground">{label}</div>
      {/* Wrapped, not scrolled sideways: a Custom field and what is wrong with it must stay on the screen. */}
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Rows of one grouping as a table of four columns, which is what a 360px phone holds: trades, how many made money,
 * and the net with what one trade made under it. What the same trades made on the perp goes under the name.
 */
/**
 * One setting of a run together, as a switch (owner, 14 Oct 2026: "on the portfolio side the filter is off and each
 * backtest runs with its own filter; switched on, that filter is taken for now and applied to every backtest").
 * Off, the row is one line and says so; on, it says the value in force and shows the single backtest's own control
 * for it.
 */
function RunFilter({ name, on, said, onToggle, children }: { name: string; on: boolean; said: string; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-0 border-t border-solid border-[var(--line-soft)] pt-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[13.5px] font-medium text-foreground">{name}</span>
          <span className={cn('block text-[12px] leading-snug', on ? 'text-foreground' : 'text-muted-foreground')}>{on ? `For the run: ${said}` : 'Off · each saved backtest’s own'}</span>
        </span>
        {/* A finger's height around a switch's width: the track alone is 24px tall. */}
        <button type="button" role="switch" aria-checked={on} aria-label={`${name}, for the run`} onClick={onToggle}
          className="m-0 inline-flex min-h-[44px] flex-none cursor-pointer appearance-none items-center border-0 bg-transparent p-0 pl-2">
          <span className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', on ? 'bg-[var(--chosen)]' : 'bg-[var(--line)]')}>
            <span className={cn('block h-5 w-5 rounded-full shadow transition-transform', on ? 'translate-x-[22px] bg-[var(--chosen-ink)]' : 'translate-x-0.5 bg-muted-foreground')} />
          </span>
        </button>
      </div>
      {on && <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 pb-1.5">{children}</div>}
    </div>
  );
}

/**
 * The settings a run together can be given for the run: the single backtest's strike, option target (fixed or by
 * the clock), option stop, lots, minimum premium and SL / TGT range -- each off to begin with. One switched on
 * starts from what the Single backtest section has for it, so "try all of them with what I have set up there" is
 * a tap. The hours and the limit on open trades have rows of their own above.
 */
function RunFilters({ over, onChange, seed, stepSources, wide }: {
  over: PortfolioOver; onChange: (o: PortfolioOver) => void;
  /** The Single backtest section's settings: where a switch starts. */
  seed: BacktestParams;
  stepSources: { name: string; pct: number; steps: Step[]; enabled: boolean }[];
  wide: boolean;
}) {
  // Dynamic chosen and its steps not in use yet: the editor is open, the run still by the fixed target.
  const [dynamicDraft, setDynamicDraft] = useState(false);
  const put = (o: PortfolioOver) => onChange({ ...over, ...o });
  const flip = <K extends keyof PortfolioOver>(key: K, start: NonNullable<PortfolioOver[K]>) => {
    if (over[key] === undefined) { put({ [key]: start }); return; }
    const next = { ...over };
    delete next[key];
    onChange(next);
  };
  const { strike, target, stop, lots, minPremium, range, noEntry, vol, strikeBlocks, tsl, perpWiden, breakEven } = over;
  const values = strike?.rule === 'premium' ? PREMIUMS : DELTAS;
  const dynamic = (target?.targetSteps?.length ?? 0) > 0 || dynamicDraft;
  const switchedOn = Object.keys(over).length;
  const said = (p: Partial<BacktestParams>) => overWords(p)[0] ?? '';
  return (
    <section aria-label="Settings for the run" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-1">
        <span className="text-[13px] font-semibold">Settings for the run <span className="font-normal text-muted-foreground">· {switchedOn === 0 ? 'all off' : `${switchedOn} on`}</span></span>
        {switchedOn > 0 && <button type="button" onClick={() => { setDynamicDraft(false); onChange({}); }} className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">Switch all off</button>}
      </div>
      <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
        Off, each saved backtest runs with its own. Switched on, that one setting is taken for this run and put over every saved backtest in it -- nothing saved is changed.
      </p>

      <RunFilter name="Strike" on={!!strike} said={strike ? said(strike) : ''} onToggle={() => flip('strike', { rule: seed.rule, value: seed.value })}>
        {strike && <>
          <Segmented dense label="How the strike is picked, for the run" value={strike.rule} options={RULES} onChange={(rule) => put({ strike: { rule, value: rule === 'delta' ? 0.1 : 50 } })} />
          <ChipRow wide={wide} label={strike.rule === 'delta' ? 'Sell the nearest strike with a delta of at most' : 'Sell the dearest strike priced at most'}>
            {values.map((v) => <Chip key={v} on={strike.value === v} onClick={() => put({ strike: { ...strike, value: v } })}>{strike.rule === 'delta' ? v.toFixed(2) : `$${v}`}</Chip>)}
            <CustomValue key={strike.rule} value={strike.value} presets={values} spec={strike.rule === 'delta' ? CUSTOM.delta : CUSTOM.premium}
              name={strike.rule === 'delta' ? 'Delta limit, for the run' : 'Premium limit, for the run'} onChange={(value) => put({ strike: { ...strike, value } })} />
          </ChipRow>
        </>}
      </RunFilter>

      {/* A strike rule by time of day over every one worked by settings (18 Oct 2026): the form's blocks, held to the whole day. */}
      <RunFilter name="Strike by time of day" on={!!strikeBlocks} said={strikeBlocks ? said({ strikeBlocks: strikeBlocks.blocks }) : ''}
        onToggle={() => flip('strikeBlocks', { blocks: seed.strikeBlocks ?? [] })}>
        {strikeBlocks && (
          <BacktestStrikeBlocks hours={{ entryTime: '17:30', exitTime: '17:25' }} rule={null} blocks={strikeBlocks.blocks}
            firstWords={<>Each saved backtest&apos;s own strike rule -- or the run&apos;s <b className="font-semibold">Strike</b>, where it is switched on -- from the start of its hours.</>}
            onChange={(n) => put({ strikeBlocks: { blocks: n.strikeBlocks } })} />
        )}
      </RunFilter>
      <RunFilter name="Option target" on={!!target} said={target ? said(target.targetSteps?.length ? target : { targetPct: target.targetPct })  : ''}
        onToggle={() => { setDynamicDraft(false); flip('target', { targetPct: seed.targetPct, ...(seed.targetSteps?.length ? { targetSteps: seed.targetSteps } : {}) }); }}>
        {target && <>
          <Segmented dense label="The option's own target, for the run" value={dynamic ? 'dynamic' : 'fixed'}
            options={[{ key: 'fixed', label: 'Fixed target', spoken: 'One target all day, for the run' }, { key: 'dynamic', label: 'Dynamic · by time', spoken: 'A target that moves by the clock, for the run' }]}
            onChange={(m) => {
              if (m === 'fixed') { setDynamicDraft(false); put({ target: { targetPct: target.targetPct > 0 ? target.targetPct : 0.9 } }); return; }
              // Dynamic: a strategy's own steps, in use at once -- one that is switched on first. With none to take, the editor opens empty.
              const own = [...stepSources].sort((a, b) => Number(b.enabled) - Number(a.enabled))[0];
              if (own) put({ target: { targetPct: own.pct, targetSteps: own.steps } }); else setDynamicDraft(true);
            }} />
          {!dynamic ? (
            <ChipRow wide={wide} label="The option's own target, of the premium kept">
              {TARGETS.map((x) => <Chip key={x.value} on={target.targetPct === x.value} onClick={() => put({ target: { targetPct: x.value } })}>{x.label}</Chip>)}
              <CustomValue value={target.targetPct} presets={TARGETS.map((x) => x.value)} spec={CUSTOM.target} name="Option target, for the run" onChange={(targetPct) => put({ target: { targetPct } })} />
            </ChipRow>
          ) : (
            <TargetSteps key={`${target.targetPct}|${JSON.stringify(target.targetSteps ?? [])}`} start={target.targetPct > 0 ? target.targetPct : 0.7} steps={target.targetSteps ?? []}
              copyFrom={stepSources} onApply={(targetPct, targetSteps) => { setDynamicDraft(false); put({ target: { targetPct, targetSteps } }); }} />
          )}
        </>}
      </RunFilter>

      <RunFilter name="Option stop" on={!!stop} said={stop ? said(stop) : ''} onToggle={() => flip('stop', { stopPct: seed.stopPct })}>
        {stop && (
          <ChipRow wide={wide} label="The option's own stop, over the premium sold">
            {STOPS.map((s) => <Chip key={s.value} on={stop.stopPct === s.value} onClick={() => put({ stop: { stopPct: s.value } })}>{s.label}</Chip>)}
            <CustomValue value={stop.stopPct} presets={STOPS.map((x) => x.value)} spec={CUSTOM.stop} name="Option stop, for the run" onChange={(stopPct) => put({ stop: { stopPct } })} />
          </ChipRow>
        )}
      </RunFilter>

      {/* A trailing SL over every one worked by settings (18 Oct 2026); switched off inside, it takes their own away for the run. */}
      <RunFilter name="Trailing SL" on={!!tsl} said={tsl ? said({ tsl: tsl.tsl ?? undefined }) || 'no trailing SL' : ''} onToggle={() => flip('tsl', { tsl: seed.tsl ?? null })}>
        {tsl && <BacktestTsl name="Trailing SL, for the run" value={tsl.tsl} stopPct={stop?.stopPct ?? 3} onChange={(t) => put({ tsl: { tsl: t } })} />}
      </RunFilter>

      {/* The stop to the price sold over every one worked by settings (18 Oct 2026); switched off inside, theirs taken away. */}
      <RunFilter name="SL to entry" on={!!breakEven} said={breakEven ? breakEvenWords(breakEven.be) ?? 'no SL to entry' : ''} onToggle={() => flip('breakEven', { be: seed.breakEven ?? null })}>
        {breakEven && <BacktestBreakEven name="SL to entry, for the run" value={breakEven.be} onChange={(b) => put({ breakEven: { be: b } })} />}
      </RunFilter>

      {/* The perp's SL and TGT widened with volatility over every one worked by settings (18 Oct 2026), the two together. */}
      <RunFilter name="Perp SL & TGT by volatility" on={!!perpWiden} said={perpWiden ? perpWidenWords({ widenSlAtr: perpWiden.slAtr, widenTgtAtr: perpWiden.tgtAtr }) ?? "the signal's own" : ''}
        onToggle={() => flip('perpWiden', { slAtr: seed.widenSlAtr ?? 0, tgtAtr: seed.widenTgtAtr ?? 0 })}>
        {perpWiden && <BacktestPerpWiden name="Perp SL & TGT by volatility, for the run" sl={perpWiden.slAtr} tgt={perpWiden.tgtAtr} onChange={(v) => put({ perpWiden: { slAtr: v.widenSlAtr, tgtAtr: v.widenTgtAtr } })} />}
      </RunFilter>

      <RunFilter name="Lots a signal" on={!!lots} said={lots ? said(lots) : ''} onToggle={() => flip('lots', { lots: seed.lots })}>
        {lots && (
          <ChipRow wide={wide} label="Lots a signal">
            {LOTS.map((n) => <Chip key={n} on={lots.lots === n} onClick={() => put({ lots: { lots: n } })}>{n}</Chip>)}
            <CustomValue value={lots.lots} presets={LOTS} spec={CUSTOM.lots} name="Lots, for the run" onChange={(n) => put({ lots: { lots: n } })} />
          </ChipRow>
        )}
      </RunFilter>

      <RunFilter name="Minimum premium" on={!!minPremium} said={minPremium ? said(minPremium) : ''} onToggle={() => flip('minPremium', { minPremium: seed.minPremium ?? FLOOR })}>
        {minPremium && (
          <ChipRow wide={wide} label="Minimum premium: sell only for at least">
            {MIN_PREMIUMS.map((v) => <Chip key={v} on={minPremium.minPremium === v} onClick={() => put({ minPremium: { minPremium: v } })}>{v > 0 ? `$${v}` : 'Off'}</Chip>)}
            <CustomValue value={minPremium.minPremium} presets={MIN_PREMIUMS} spec={CUSTOM.minPremium} name="Minimum premium, for the run" onChange={(v) => put({ minPremium: { minPremium: v } })} />
          </ChipRow>
        )}
      </RunFilter>

      <RunFilter name="SL and TGT range" on={!!range} said={range ? said(range) : ''}
        onToggle={() => flip('range', { slMin: seed.slMin ?? 0, slMax: seed.slMax ?? 0, tgtMin: seed.tgtMin ?? 0, tgtMax: seed.tgtMax ?? 0 })}>
        {range && <SlTgtRange value={range} onApply={(r) => put({ range: r })} />}
      </RunFilter>
      {/* The volatility filter over every one of them, a strategy's too (17 Oct 2026): as the single backtest's "Which signals are taken". */}
      <RunFilter name="Volatility filter" on={!!vol} said={vol ? said({ vol: vol.vol, volBy: vol.volBy }) : ''} onToggle={() => flip('vol', { vol: seed.vol ?? 'off', volBy: seed.volBy ?? 'atr' })}>
        {vol && <>
          <Segmented dense label="Volatility when the signal fills, for the run" value={vol.vol} onChange={(v) => put({ vol: { ...vol, vol: v } })}
            options={[
              { key: 'off', label: 'Off', spoken: 'Volatility filter off for the run: every signal' },
              { key: 'low', label: 'Low', spoken: 'For the run, only signals in low volatility' },
              { key: 'medium', label: 'Medium', spoken: 'For the run, only signals in medium volatility' },
              { key: 'high', label: 'High', spoken: 'For the run, only signals in high volatility' },
            ]} />
          <Segmented dense label="Volatility is read by, for the run" value={vol.volBy} onChange={(volBy) => put({ vol: { ...vol, volBy } })}
            options={[
              { key: 'atr', label: 'ATR 2h', spoken: 'For the run, volatility by the candles: two hours of 15-minute ATR' },
              { key: 'iv', label: 'ATM IV', spoken: 'For the run, volatility by the at-the-money implied volatility' },
            ]} />
        </>}
      </RunFilter>
      {/* No-entry windows over every one of them, for the run (15 Oct 2026): the form's editor, held to the whole day. */}
      <RunFilter name="No-entry window" on={!!noEntry} said={noEntry ? said({ noEntry: { ...noEntry, on: true } }) : ''}
        onToggle={() => flip('noEntry', seed.noEntry?.on && seed.noEntry.windows.length ? seed.noEntry : { on: true, windows: [{ from: '00:30', to: '01:30' }] })}>
        {noEntry && (
          <NoEntryFields bare
            c={{ entryTime: '17:30', exitTime: '17:25', noEntry: { ...noEntry, on: true } } as unknown as StrategyConfig}
            set={((k: string, v: unknown) => { if (k === 'noEntry') put({ noEntry: { ...(v as NoEntry), on: true } }); }) as SetField}
            err={(f) => (f === 'noEntry' ? backtestNoEntryProblems({ window: 'all', noEntry: { ...noEntry, on: true } } as BacktestParams)[0] ?? null : null)}
          />
        )}
      </RunFilter>
    </section>
  );
}

/**
 * One account's limit on a run together, shown and typed (owner, 13 Oct 2026: "show the at-most-open field with
 * its default value, editable"): at most open across all of them, and the CE and PE shares of it. It opens on the
 * default -- what the saved backtests themselves carry, or the account's own limit -- and takes a typed one on
 * leaving a field or Enter, checked as the desk checks it; Default puts it back.
 */
function SharedCap({ value, fallback, picks = [], edited, onApply, onReset }: {
  value: PortfolioCap | null; fallback: PortfolioCap | null;
  /** Limits to take in one tap: each trading account's own as it stands, and the saved backtests' own. */
  picks?: readonly { label: string; cap: PortfolioCap }[];
  edited: boolean; onApply: (c: PortfolioCap) => void; onReset: () => void;
}) {
  const shown = value ?? fallback;
  const text = (c: PortfolioCap | null) => ({ max: c ? String(c.max) : '', ce: c ? String(c.ce) : '', pe: c ? String(c.pe) : '' });
  const [draft, setDraft] = useState(text(shown));
  const key = shown ? `${shown.max}/${shown.ce}/${shown.pe}` : '';
  // What is in force changed from outside -- another run, Default, a new default: the fields follow it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(text(shown)); }, [key]);
  const max = Number(draft.max), ce = Number(draft.ce), pe = Number(draft.pe);
  const problem = draft.max.trim() === '' ? (shown ? 'Type how many may be open together, or tap Default.' : null)
    : !Number.isInteger(max) || max < 1 || max > 500 ? 'At most open is a whole number from 1 to 500.'
      : !(ce >= 1 && ce <= 100) || !(pe >= 1 && pe <= 100) ? 'CE max and PE max are from 1% to 100%.'
        : null;
  const apply = () => { if (!problem && draft.max.trim() !== '' && `${max}/${ce}/${pe}` !== key) onApply({ max, ce, pe }); };
  const field = 'h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-2 text-[16px] tabular-nums text-foreground';
  const input = (name: 'max' | 'ce' | 'pe', label: string, unit: string) => (
    <label className="grid min-w-0 gap-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <input type="number" inputMode="numeric" aria-label={label} value={draft[name]} placeholder={name === 'max' ? 'none' : '100'}
          onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} onBlur={apply}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }} className={field} />
        {unit && <span className="text-[12.5px] text-muted-foreground">{unit}</span>}
      </span>
    </label>
  );
  const said = (c: PortfolioCap) => `${c.max} open · CE ${c.ce}% · PE ${c.pe}%`;
  const same = (a: PortfolioCap, b: PortfolioCap | null) => b !== null && a.max === b.max && a.ce === b.ce && a.pe === b.pe;
  return (
    <div role="group" aria-label="One account's limit" className="grid min-w-0 gap-1.5">
      {picks.length > 0 && (
        <div role="group" aria-label="Limits to take" className="flex flex-wrap gap-1.5">
          {picks.map((x) => (
            <Chip key={`${x.label}|${said(x.cap)}`} on={same(x.cap, shown)} onClick={() => (same(x.cap, fallback) ? onReset() : onApply(x.cap))}>{x.label} · {x.cap.max} · CE {x.cap.ce}% · PE {x.cap.pe}%</Chip>
          ))}
        </div>
      )}
      <div className="grid min-w-0 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
        {input('max', 'At most open, together', '')}
        {input('ce', 'CE max', '%')}
        {input('pe', 'PE max', '%')}
      </div>
      <p role={problem ? 'alert' : 'status'} className={cn('m-0 px-1 text-[12px] leading-snug', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
        {problem ?? (!shown ? 'No saved backtest and no account has an “at most open”: none is shared until one is typed here.'
          : edited ? `Your own: ${said(shown)}.${fallback ? ` The default is ${said(fallback)}.` : ''}`
            : `The default: ${said(shown)} -- the account's own limit as it stands on the desk (the saved backtests' own, where no account has one). Type another to try it.`)}
        {edited && !problem && <> <button type="button" onClick={onReset} className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] font-medium text-[var(--accent)] underline">Default</button></>}
      </p>
    </div>
  );
}

/**
 * The result's sections as a row of chips that jump to each (owner, 14 Oct 2026: "the backtest screen, user
 * friendly"): on a phone the result runs to a dozen screens, the live check at the bottom of them. Kept at the top of
 * the screen while the result is scrolled, and sideways-scrolling where it does not fit.
 */
const RESULT_PARTS = [
  { id: 'bt-summary', label: 'Summary' },
  { id: 'bt-exits', label: 'Exits & time frames' },
  { id: 'bt-pairs', label: 'Pairs' },
  { id: 'bt-methods', label: 'Methods' },
  { id: 'bt-perp', label: 'Perp vs options' },
  { id: 'bt-sessions', label: 'Sessions' },
  { id: 'bt-days', label: 'Days' },
  { id: 'bt-volsl', label: 'By volatility' },
  { id: 'bt-live', label: 'Live check' },
] as const;



export function SignalBacktest({ now = Date.now(), wide = false }: { now?: number; wide?: boolean }) {
  const expiry = useExpiryRange('signalBacktest', now);
  const [stored, setParams] = usePersisted<BacktestParams>('signalBacktest.params', DEFAULTS);
  const [tfs, setTfs] = usePersisted<string[]>('signalBacktest.tfs', []);
  const [methods, setMethods] = usePersisted<string[]>('signalBacktest.methods', []);
  // The methods dropdown's Win tab line, kept on this browser like the rest of the filters (default 30%).
  const [winAtLeast, setWinAtLeast] = usePersisted<number>('signalBacktest.winAtLeast', WIN_AT_LEAST_PCT);
  // How the method lists are ordered, the same in every one of them (`FilterSort`): kept in this browser.
  const [methodSort, setMethodSort] = usePersisted<FilterSort>('methods.sort', 'default');
  // The trades open one by one (`DayTradesSheet`): of an expiry day, a session, a method in one; null: none.
  const [openTrades, setOpenTrades] = useState<{ key: string; title?: string; pick: TradePick } | null>(null);
  // A saved strategy to backtest by (owner, 13 Oct 2026); null is the settings below.
  const [strategyId, setStrategyId] = usePersisted<string | null>('signalBacktest.strategy', null);
  /*
   * Strategies whose methods and timeframes are ticked for these settings (owner, 13 Oct 2026: "a strategy list
   * beside Methods; choosing one selects its methods"). A shortcut for the two filters, not a rule of its own: the
   * methods and timeframes are what is asked for, and changing either by hand ends it.
   */
  const [fromStrategies, setFromStrategies] = usePersisted<string[]>('signalBacktest.fromStrategies', []);
  const [pickingHours, setPickingHours] = useState(false);
  // Dynamic chosen and its steps not in use yet: the editor is open, the backtest still by what was last used.
  const [dynamicDraft, setDynamicDraft] = useState(false);
  // Open on a desk, folded on a phone to begin with; the choice is remembered on each.
  const [settingsOpen, setSettingsOpen] = usePersisted<boolean>(`signalBacktest.settingsOpen.${wide ? 'desk' : 'phone'}`, wide);
  // The settings' sections folded to their one line (16 Oct 2026), kept in this browser: none to begin with.
  const [shut, setShut] = usePersisted<string[]>('signalBacktest.sectionsShut', []);
  const folded = new Set(Array.isArray(shut) ? shut : []);
  const fold = (title: string) => ({ open: !folded.has(title), onToggle: () => setShut(folded.has(title) ? [...folded].filter((x) => x !== title) : [...folded, title]) });
  const pickMethods = (m: string[]) => { setMethods(m); setFromStrategies([]); };
  const pickTfs = (t: string[]) => { setTfs(t); setFromStrategies([]); };
  // Anything remembered from an older build falls back to the defaults rather than asking for what the server refuses.
  const merged: BacktestParams = { ...DEFAULTS, ...stored };
  const params: BacktestParams = merged.window === 'custom' && !(merged.hoursFrom && merged.hoursTo) ? { ...merged, window: 'desk' } : merged;
  const set = (o: Partial<BacktestParams>) => setParams({ ...params, ...o });
  const dynamic = (params.targetSteps?.length ?? 0) > 0 || dynamicDraft;
  /** The target in words: one share, or where a schedule starts and ends. */
  const targetWords = params.targetSteps?.length
    ? `${Math.round(params.targetPct * 100)}% → ${Math.round(params.targetSteps[params.targetSteps.length - 1]!.pct * 100)}% by time (${params.targetSteps.length} steps)`
    : CUSTOM.target.label(params.targetPct);
  const range = expiry.range;
  const query: BacktestQuery = { ...range, params, tfs, methods, strategy: strategyId };
  // The answer is kept with what was asked: a result for the settings before is greyed while the new one is worked out.
  // Asked once the settings stand still a moment: a run of edits is one backtest, not one each.
  const read = useAnswer(JSON.stringify(query), () => getSignalBacktest(query), 300_000, SETTLE_MS);
  const r = read.data;
  // A strategy remembered from before that is gone now (deleted): back to the settings, rather than an error every time.
  const gone = strategyId !== null && read.error !== null && /No such signal strategy/.test(read.error.message);
  useEffect(() => { if (gone) setStrategyId(null); }, [gone, setStrategyId]);
  const byStrategy = strategyId !== null;
  const strategies = r?.strategies ?? [];
  // The strategies that have a target by the clock: whose steps a dynamic target here is taken from.
  const stepSources = strategies.flatMap((x) => (x.target && x.target.steps.length ? [{ name: `${x.name}${x.account ? ` · ${x.account}` : ''}`, pct: x.target.pct, steps: x.target.steps, enabled: x.enabled }] : []));
  const values = params.rule === 'delta' ? DELTAS : PREMIUMS;

  // The settings in one line: what the result below is of. Said on the folded panel and on the result.
  const saved: SavedQuery = { params, tfs, methods, strategy: strategyId };
  const summary = settingsWords(saved, strategies);
  const floor = params.minPremium ?? FLOOR;
  // Each section's line while it is folded: what it is set to, in the settings' own words.
  const chosenStrategy = strategies.find((x) => x.id === strategyId) ?? null;
  const hoursWords = params.window === 'desk' ? '9:30 PM → 3:59 PM' : params.window === 'all' ? 'whole day' : `${time12(params.hoursFrom ?? '')} → ${time12(params.hoursTo ?? '')}`;
  const pts = (lo?: number, hi?: number) => (lo && hi ? `${lo}–${hi}` : lo ? `≥ ${lo}` : hi ? `≤ ${hi}` : null);
  const lines = {
    what: [`${dayLabel(range.from)} → ${dayLabel(range.to)}`, byStrategy ? `by ${chosenStrategy?.name ?? 'a strategy'}` : 'these settings', ...(byStrategy ? [] : [hoursWords])].join(' · '),
    strike: [
      params.rule === 'delta' ? `delta ≤ ${params.value.toFixed(2)}` : `premium ≤ $${params.value}`,
      `TGT ${targetWords}`, params.stopPct > 0 ? `SL +${Math.round(params.stopPct * 100)}%` : 'no option SL',
      ...(params.tsl ? [tslProblems(params.tsl, params.stopPct).length ? 'trailing SL not used (see its settings)' : tslWords(params.tsl)!] : []),
      ...(params.breakEven ? [breakEvenWords(params.breakEven)!] : []),
      ...(perpWidenWords(params) ? [perpWidenWords(params)!] : []),
      `${params.lots} lot${params.lots === 1 ? '' : 's'}`, floor > 0 ? `min $${floor}` : 'no premium floor',
      ...(strikeBlocksWords(params.strikeBlocks) ? [backtestBlockProblems(params).length ? 'strike blocks not used (outside the hours)' : strikeBlocksWords(params.strikeBlocks)!] : []),
    ].join(' · '),
    which: [
      ...(byStrategy ? [] : [pts(params.slMin, params.slMax) ? `SL ${pts(params.slMin, params.slMax)}` : null, pts(params.tgtMin, params.tgtMax) ? `TGT ${pts(params.tgtMin, params.tgtMax)}` : null]),
      ...(!byStrategy && params.noEntry?.on && params.noEntry.windows.length ? [`no entry ${params.noEntry.windows.map((w) => `${time12(w.from)}–${time12(w.to)}`).join(', ')}`] : []),
      (params.vol ?? 'off') === 'off' ? 'every volatility' : `${params.vol} volatility only`,
      params.volBy === 'iv' ? 'volatility by ATM IV' : null,
      params.deskMax > 0 ? `at most ${params.deskMax} open · CE ${params.cePct}% · PE ${params.pePct}%` : 'no open limit',
    ].filter(Boolean).join(' · '),
    filters: [
      tfs.length ? tfs.map((t) => (t === 'chain' ? 'TF chain' : t)).join(', ') : 'every time frame',
      methods.length ? `${methods.length} method${methods.length === 1 ? '' : 's'}` : 'every method',
      ...(fromStrategies.length ? [`as ${strategies.filter((x) => fromStrategies.includes(x.id)).map((x) => x.name).join(', ')}`] : []),
    ].join(' · '),
  };
  const sectionTitles = ['What to backtest', 'Strike and exits', 'Which signals are taken', 'Filters'];
  /*
   * One section at a time (owner, 13 Oct 2026: "a single backtest, or a portfolio run -- the portfolio section or
   * the backtest section, only one open at a time"): the settings, filters and result of one backtest; or the
   * portfolios, the saved backtests to tick, and what they come to together. Which is open, and the last run
   * together, are kept in this browser.
   */
  const [storedMode, setMode] = usePersisted<'single' | 'portfolio'>('signalBacktest.mode', 'single');
  /*
   * Every part of the result folds (owner, 17 Oct 2026: "the backtest and the portfolio run's output -- every part
   * expand and collapse"), by its title, kept in this browser: the backtest's and the run's apart, all open to begin with.
   */
  const [resultFolds, setResultFolds] = usePersisted<FoldState>('signalBacktest.resultFolds', ALL_OPEN);
  const [runFolds, setRunFolds] = usePersisted<FoldState>('signalBacktest.runFolds', ALL_OPEN);
  // A section kept by an older build that is no longer one (the live check had a tab for a morning) is the single backtest.
  const mode = storedMode === 'portfolio' ? 'portfolio' : 'single';
  const [together, setTogether] = usePersisted<TogetherRun | null>('signalBacktest.together', null);
  // One account's limit over a run together, or each saved backtest's own (`PortfolioLimit`): one account to begin with.
  const [limit, setLimit] = usePersisted<PortfolioLimit>('signalBacktest.together.limit', 'shared');
  // One account's limit: typed here and kept, or (null) the default worked out below.
  const [capTyped, setCapTyped] = usePersisted<PortfolioCap | null>('signalBacktest.together.cap', null);
  // The hours a run together is held to (owner, 13 Oct 2026: the hours choice, "wanted in the portfolio section"): each saved backtest's own to begin with.
  const [runHours, setRunHours] = usePersisted<PortfolioHours>('signalBacktest.together.hours', AS_SAVED);
  const [pickingRunHours, setPickingRunHours] = useState(false);
  // The other settings a run together can be given, each its own switch (`RunFilters`): all off to begin with.
  const [runOver, setRunOver] = usePersisted<PortfolioOver>('signalBacktest.together.over', {});
  // Open on a desk, folded on a phone to begin with, as the Settings panel is; the choice is remembered on each.
  const [runOpen, setRunOpen] = usePersisted<boolean>(`signalBacktest.runOpen.${wide ? 'desk' : 'phone'}`, wide);
  /*
   * A run started on a phone is shown: its result is under the portfolios and the saved backtests, a screen or two
   * down, and a tap on Run that changed nothing in sight read as a tap that did nothing. Every tap on Run, the one
   * already running too; a run closed, or renamed with its portfolio, moves nothing.
   */
  const resultRef = useRef<HTMLDivElement>(null);
  const startRun = (next: TogetherRun | null) => {
    const again = next !== null && (together === null || next.ids.join(',') !== together.ids.join(',') || next.title === together.title);
    setTogether(next);
    if (again && !wide) requestAnimationFrame(() => resultRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  };
  const [savedList, setSavedList] = useState<BacktestSave[]>([]);
  /** A saved backtest's settings put on the screen: the result below is then worked for them, over the days chosen. */
  const load = (q: SavedQuery) => {
    setParams({ ...DEFAULTS, ...q.params }); setTfs(q.tfs); setMethods(q.methods); setStrategyId(q.strategy);
    setFromStrategies([]); setDynamicDraft(false); setPickingHours(false);
  };

  /*
   * The settings, in four sections (owner, 13 Oct 2026: "a user-friendly backtest screen, responsive on the
   * window and on the phone"). On a phone they fold into one line -- what the result is of, and Change -- so the
   * result is on the screen without scrolling past them; on a wide desk window they are a column of their own
   * beside the result, kept in view as it scrolls. The filters, used most, stay open in both.
   */
  const setup = (
    <>
      <Section title="What to backtest" summary={lines.what} {...fold('What to backtest')}>
        {expiry.control}
      <label className="grid gap-1 px-1">
        <span className="text-[12px] text-muted-foreground">Backtest by</span>
        <select
          value={strategyId ?? ''} onChange={(e) => setStrategyId(e.target.value === '' ? null : e.target.value)}
          className="h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-3 text-[15px] text-foreground [color-scheme:dark]"
        >
          <option value="">These settings (every signal)</option>
          {strategies.map((x) => (
            <option key={x.id} value={x.id}>{x.name}{x.account ? ` · ${x.account}` : ''}{x.enabled ? '' : ' · off'}</option>
          ))}
        </select>
      </label>
        {!byStrategy && <>
      {/* Named in words: three chips of times with nothing over them did not say what they chose. */}
      <span aria-hidden className="-mb-1.5 text-[12px] text-muted-foreground">Hours of the signals (IST)</span>
      <Segmented dense label="Which signals" value={params.window} options={WINDOWS}
        // Custom opens the hours every time it is tapped: chosen already, a tap is "change the hours".
        onChange={(window) => { if (window === 'custom') setPickingHours(true); else { set({ window }); setPickingHours(false); } }} />
      {params.window === 'custom' && !pickingHours && params.hoursFrom && params.hoursTo && (
        <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 px-1 text-[13px]">
          <span className="text-muted-foreground">Signals filled <span className="text-foreground">{time12(params.hoursFrom)} → {time12(params.hoursTo)}</span> IST</span>
          <button type="button" onClick={() => setPickingHours(true)} className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">Change hours</button>
        </p>
      )}
      {pickingHours && (
        <CustomHours from={params.hoursFrom ?? '21:30'} to={params.hoursTo ?? '00:30'}
          onApply={(hoursFrom, hoursTo) => { set({ window: 'custom', hoursFrom, hoursTo }); setPickingHours(false); }}
          onClose={() => setPickingHours(false)} />
      )}
        </>}
      </Section>
      {!byStrategy && (
        <Section title="Strike and exits" summary={lines.strike} {...fold('Strike and exits')}>
      <Segmented dense label="How the strike is picked" value={params.rule} options={RULES} onChange={(rule) => set({ rule, value: rule === 'delta' ? 0.1 : 50 })} />
      <ChipRow wide={wide} label={params.rule === 'delta' ? 'Sell the nearest strike with a delta of at most' : 'Sell the dearest strike priced at most'}>
        {values.map((v) => <Chip key={v} on={params.value === v} onClick={() => set({ value: v })}>{params.rule === 'delta' ? v.toFixed(2) : `$${v}`}</Chip>)}
        <CustomValue key={params.rule} value={params.value} presets={values} spec={params.rule === 'delta' ? CUSTOM.delta : CUSTOM.premium}
          name={params.rule === 'delta' ? 'Delta limit' : 'Premium limit'} onChange={(value) => set({ value })} />
      </ChipRow>
      {/* A different strike rule by time of day (18 Oct 2026): the strategy form's own blocks, held to these hours; the rule above is block 1. */}
      <BacktestStrikeBlocks hours={backtestHours(params)} rule={{ rule: params.rule, value: params.value }} blocks={params.strikeBlocks}
        firstWords={<>The strike rule above: <b className="font-semibold">{params.rule === 'delta' ? `delta ≤ ${params.value.toFixed(2)}` : `premium ≤ $${params.value}`}</b>, from the start of the hours.</>}
        onChange={(n) => set({ strikeBlocks: n.strikeBlocks.length ? n.strikeBlocks : undefined, ...(n.rule ? { rule: n.rule.rule, value: n.rule.value } : {}) })} />
      {/* Blocks that no longer fit the hours are not sent (18 Oct 2026): said here, not left to be found in the result. */}
      {(params.strikeBlocks?.length ?? 0) > 0 && backtestBlockProblems(params).length > 0 && (
        <p role="alert" className="m-0 rounded-md border border-solid border-[var(--warn)]/50 px-3 py-2 text-[12.5px] leading-snug text-[var(--warn)]">
          The strike blocks are not in this backtest until they fit the hours: {backtestBlockProblems(params)[0]} The rule above is used all day meanwhile.
        </p>
      )}
      {/* First which kind of target, then its own settings (owner, 13 Oct 2026). */}
      <Segmented dense label="The option's own target" value={dynamic ? 'dynamic' : 'fixed'}
        options={[{ key: 'fixed', label: 'Fixed target', spoken: 'One target all day' }, { key: 'dynamic', label: 'Dynamic · by time', spoken: 'A target that moves by the clock' }]}
        onChange={(m) => {
          if (m === 'fixed') { setDynamicDraft(false); set({ targetSteps: undefined, targetPct: params.targetPct > 0 ? params.targetPct : 0.9 }); return; }
          // Dynamic: a strategy's own steps, in use at once -- one that is switched on first. With none to take, the editor opens empty.
          const own = [...stepSources].sort((a, b) => Number(b.enabled) - Number(a.enabled))[0];
          if (own) set({ targetPct: own.pct, targetSteps: own.steps }); else setDynamicDraft(true);
        }} />
      {!dynamic ? (
        <ChipRow wide={wide} label="The option's own target, of the premium kept">
          {TARGETS.map((x) => <Chip key={x.value} on={params.targetPct === x.value} onClick={() => set({ targetPct: x.value })}>{x.label}</Chip>)}
          <CustomValue value={params.targetPct} presets={TARGETS.map((x) => x.value)} spec={CUSTOM.target} name="Option target" onChange={(targetPct) => set({ targetPct })} />
        </ChipRow>
      ) : (
        <TargetSteps key={`${params.targetPct}|${JSON.stringify(params.targetSteps ?? [])}`} start={params.targetPct > 0 ? params.targetPct : 0.7} steps={params.targetSteps ?? []}
          copyFrom={stepSources} onApply={(targetPct, targetSteps) => set({ targetPct, targetSteps })} />
      )}
      <ChipRow wide={wide} label="The option's own stop, over the premium sold">
        {STOPS.map((s) => <Chip key={s.value} on={params.stopPct === s.value} onClick={() => set({ stopPct: s.value })}>{s.label}</Chip>)}
        <CustomValue value={params.stopPct} presets={STOPS.map((x) => x.value)} spec={CUSTOM.stop} name="Option stop" onChange={(stopPct) => set({ stopPct })} />
      </ChipRow>
      {/* A trailing SL on that stop (18 Oct 2026): the backtest's own -- a strategy's live stop does not trail. */}
      <BacktestTsl value={params.tsl ?? null} stopPct={params.stopPct} onChange={(tsl) => set({ tsl: tsl ?? undefined })} />
      {/* The option's stop to the price sold once the premium has fallen so far (18 Oct 2026). */}
      <BacktestBreakEven value={params.breakEven ?? null} onChange={(breakEven) => set({ breakEven: breakEven ?? undefined })} />
      {/* The perp's SL and TGT widened with volatility (18 Oct 2026): the signal's own the least -- the desk's levels do not widen. */}
      <BacktestPerpWiden sl={params.widenSlAtr ?? 0} tgt={params.widenTgtAtr ?? 0}
        onChange={(v) => set({ widenSlAtr: v.widenSlAtr > 0 ? v.widenSlAtr : undefined, widenTgtAtr: v.widenTgtAtr > 0 ? v.widenTgtAtr : undefined })} />
      <ChipRow wide={wide} label="Lots a signal">
        {LOTS.map((n) => <Chip key={n} on={params.lots === n} onClick={() => set({ lots: n })}>{n}</Chip>)}
        <CustomValue value={params.lots} presets={LOTS} spec={CUSTOM.lots} name="Lots" onChange={(lots) => set({ lots })} />
      </ChipRow>
      <ChipRow wide={wide} label="Minimum premium: sell only for at least">
        {MIN_PREMIUMS.map((v) => <Chip key={v} on={floor === v} onClick={() => set({ minPremium: v })}>{v > 0 ? `$${v}` : 'Off'}</Chip>)}
        <CustomValue value={floor} presets={MIN_PREMIUMS} spec={CUSTOM.minPremium} name="Minimum premium" onChange={(minPremium) => set({ minPremium })} />
      </ChipRow>
      <p className="m-0 -mt-1 px-1 text-[12px] leading-snug text-muted-foreground">
        {floor > 0 ? `A strike bid under $${floor} when the signal fills is not sold: the signal is counted as "no strike".` : 'Off: any strike with a bid is sold, however little it pays. Type 0 for off, a number for a floor.'}
      </p>
        </Section>
      )}
      <Section title="Which signals are taken" summary={lines.which} {...fold('Which signals are taken')}>
        {!byStrategy && <>
      <SlTgtRange value={{ slMin: params.slMin ?? 0, slMax: params.slMax ?? 0, tgtMin: params.tgtMin ?? 0, tgtMax: params.tgtMax ?? 0 }} onApply={(r) => set(r)} />
      {/*
        No-entry windows (owner, 15 Oct 2026: "the strategy form's, in the backtest's settings"): the form's own editor
        and rules, held to these hours. A signal inside one is skipped as the desk skips it; a strategy chosen above
        keeps its own windows.
      */}
      <div className="-mt-1 border-0 border-b border-solid border-[var(--line-soft)] pb-3">
        <NoEntryFields
          c={{ ...backtestHours(params), noEntry: params.noEntry ?? { on: false, windows: [] } } as unknown as StrategyConfig}
          set={((k: string, v: unknown) => { if (k === 'noEntry') set({ noEntry: v as NoEntry }); }) as SetField}
          err={(f) => (f === 'noEntry' ? backtestNoEntryProblems(params)[0] ?? null : null)}
        />
      </div>
        </>}
        {/* Off to begin with (owner, 13 Oct 2026). Shown with a strategy too: it is asked of the market, not of the strategy. */}
        <div className="grid gap-1 border-0 border-b border-solid border-[var(--line-soft)] pb-3">
          <Segmented dense label="Volatility when the signal fills" value={params.vol ?? 'off'} onChange={(vol) => set({ vol })}
            options={[
              { key: 'off', label: 'Off', spoken: 'Volatility filter off: every signal' },
              { key: 'low', label: 'Low', spoken: 'Only signals in low volatility' },
              { key: 'medium', label: 'Medium', spoken: 'Only signals in medium volatility' },
              { key: 'high', label: 'High', spoken: 'Only signals in high volatility' },
            ]} />
          {/* What the level is read from (17 Oct 2026): the candles, as ever, or the market's own price of the move. Read by the filter, the "By volatility" table and the SL study. */}
          <span aria-hidden className="mt-1 text-[12px] text-muted-foreground">Volatility by</span>
          <Segmented dense label="Volatility is read by" value={params.volBy ?? 'atr'} onChange={(volBy) => set({ volBy: volBy === 'iv' ? 'iv' : undefined })}
            options={[
              { key: 'atr', label: 'ATR 2h', spoken: 'Volatility by the candles: two hours of 15-minute ATR' },
              { key: 'iv', label: 'ATM IV', spoken: 'Volatility by the at-the-money implied volatility' },
            ]} />
          <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
            <b className="font-medium text-foreground">Volatility filter{(params.vol ?? 'off') === 'off' ? ' · off' : ''}.</b>{' '}
            {params.volBy === 'iv'
              ? <>The at-the-money implied volatility when the signal fills, against the same hour of the five expiry days before: their lowest third is low, the highest high. No IV reading in the 6 minutes before the fill: unknown, never low.</>
              : <>The last two hours of 15-minute candles when the signal fills, against the average of the five expiry days before: low is under 0.8×, high over 1.3×, medium between.</>}
          </p>
        </div>
        <section aria-label="The desk's limits" className="grid gap-2">
          <div className="text-[13px] font-semibold">The desk&apos;s limits <span className="font-normal text-muted-foreground">· as on the Signal Strategies card</span></div>
        {/* An older server sends none: nothing offered rather than a blank screen. */}
        {(r?.deskLimits?.length ?? 0) > 0 && (
          <ChipRow label="As an account has them now">
            {(r?.deskLimits ?? []).map((d) => (
              <Chip key={d.account} on={params.deskMax === d.max && params.cePct === d.ce && params.pePct === d.pe}
                onClick={() => set({ deskMax: d.max, cePct: d.ce, pePct: d.pe })}>
                {d.account} · {d.max} · CE {d.ce}% · PE {d.pe}%
              </Chip>
            ))}
          </ChipRow>
        )}
        <ChipRow label="At most open, every trade together">
          {DESK_MAX.map((n) => <Chip key={n} on={params.deskMax === n} onClick={() => set({ deskMax: n })}>{n > 0 ? n : 'No limit'}</Chip>)}
          <CustomValue value={params.deskMax} presets={DESK_MAX} spec={CUSTOM.deskMax} name="At most open" onChange={(deskMax) => set({ deskMax })} />
        </ChipRow>
        {params.deskMax > 0 && (['CE', 'PE'] as const).map((side) => {
          const key = side === 'CE' ? 'cePct' : 'pePct';
          return (
            <ChipRow key={side} label={`${side} max: at most ${sideOf(params.deskMax, params[key])} ${side} open at once`}>
              {SIDE_PCTS.map((p) => <Chip key={p} on={params[key] === p} onClick={() => set({ [key]: p })}>{p === 80 ? '80% · default' : p === 100 ? '100% · no limit' : `${p}%`}</Chip>)}
              <CustomValue value={params[key]} presets={SIDE_PCTS} spec={CUSTOM.sidePct} name={`${side} max`} onChange={(v) => set({ [key]: v })} />
            </ChipRow>
          );
        })}
        {params.deskMax > 0 && (
          <p className="m-0 text-[12px] leading-snug text-muted-foreground">
            A signal is skipped while that many are open, as the desk does. With a limit, the time frame and method filters below choose which signals compete for the places.
          </p>
        )}
        </section>
      </Section>
    </>
  );
  const filterBlock = (
    <Section title="Filters" summary={lines.filters} {...fold('Filters')}>
      {r && r.choices.timeframes.length > 0 && (
        <ChipRow wide={wide} label="Time frame">
          <Chip on={tfs.length === 0} onClick={() => pickTfs([])}>All time frames</Chip>
          {r.choices.timeframes.map((t) => (
            <Chip key={t.key} on={tfs.includes(t.key)} onClick={() => pickTfs(tfs.includes(t.key) ? tfs.filter((x) => x !== t.key) : [...tfs, t.key])}>
              {t.key === 'chain' ? 'TF chain' : t.name}
            </Chip>
          ))}
        </ChipRow>
      )}
      {r && (r.choices.methods.length > 1 || methods.length > 0) && (
        // The bar bleeds 16px to a phone's edges; inside a section the same 16px is given back.
        <div className="px-4">
          <FilterBar onClear={methods.length || tfs.length || fromStrategies.length ? () => { setMethods([]); setTfs([]); setFromStrategies([]); } : null}>
            {strategies.length > 0 && (
              <FilterPicker noun={STRATEGIES} picked={fromStrategies.filter((id) => strategies.some((x) => x.id === id))}
                // Ticks the strategies' own methods and timeframes, together; none ticked is every method again.
                onChange={(ids) => {
                  const chosen = strategies.filter((x) => ids.includes(x.id));
                  setFromStrategies(chosen.map((x) => x.id));
                  setMethods([...new Set(chosen.flatMap((x) => x.methods))]);
                  setTfs([...new Set(chosen.flatMap((x) => x.tfs))]);
                }}
                options={strategies.map((x) => ({
                  key: x.id, name: x.name, also: x.account ?? undefined,
                  note: `${x.account ? `${x.account} · ` : ''}${x.methods.length} method${x.methods.length === 1 ? '' : 's'} on ${x.tfs.map((t) => (t === 'chain' ? 'TF chain' : t)).join(', ')}${x.enabled ? '' : ' · off'}`,
                }))} />
            )}
            <FilterPicker noun={METHODS} picked={methods} onChange={pickMethods} split
              winAtLeast={typeof winAtLeast === 'number' ? winAtLeast : WIN_AT_LEAST_PCT} onWinAtLeast={setWinAtLeast}
              sort={methodSort} onSort={setMethodSort}
              // Each method with what it made as options (owner, 13 Oct 2026: "show the methods' profit and loss"),
              // and how often it won, for the Win tab (14 Oct 2026).
              options={r.choices.methods.map((m) => ({
                key: m.key, name: m.name, tone: m.net > 0 ? 'up' as const : m.net < 0 ? 'down' as const : undefined, value: m.net,
                winRate: m.n > 0 ? m.wins / m.n : undefined, trades: m.n,
                note: m.n > 0 ? `${count(m.n)} trades · ${pct(m.wins / m.n, 0)} won · ${moneyText(m.net)}` : 'no trade',
              }))} />
          </FilterBar>
          {fromStrategies.length > 0 && (
            <p className="m-0 mt-1 px-1 text-[12.5px] text-muted-foreground">
              The methods and time frames of {strategies.filter((x) => fromStrategies.includes(x.id)).map((x) => x.name).join(', ')}: {methods.length} method{methods.length === 1 ? '' : 's'} on {tfs.map((t) => (t === 'chain' ? 'TF chain' : t)).join(', ') || 'every time frame'}, by the settings above.
              {' '}To use a strategy&apos;s own strike, lots, exits and limits too, choose it under Backtest by.
            </p>
          )}
        </div>
      )}
    </Section>
  );
  const settingsPanel = (
    <Panel
      title="Settings"
      right={(
        <span className="flex items-center gap-3">
          {settingsOpen && (
            <button type="button" onClick={() => setShut(folded.size >= sectionTitles.length - 1 ? [] : sectionTitles)}
              className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[12.5px] text-muted-foreground hover:text-foreground">
              {folded.size >= sectionTitles.length - 1 ? 'Open all' : 'Fold all'}
            </button>
          )}
          <button type="button" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}
            className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] font-medium text-[var(--accent)]">
            {settingsOpen ? 'Hide' : 'Change'}
          </button>
        </span>
      )}
    >
      <p className={cn('m-0 text-[13px] leading-snug', settingsOpen && 'hidden')}>{summary}</p>
      <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', !settingsOpen && 'hidden')}>{setup}</div>
    </Panel>
  );
  /*
   * The default is the ACCOUNT's own limit as it stands on the desk -- the trading account with the most room --
   * and only without one the largest "at most open" typed into the saved backtests run. It was the other way
   * round for an evening, and "one account" was held to the 120 in the saved backtests while the account itself
   * was set to 200: a margin of an account that was not the owner's ("the margin amount is shown wrongly").
   * Both are offered as one tap beside the fields.
   */
  const ran = together ? savedList.filter((x) => together.ids.includes(x.id)) : savedList;
  const carried = ran.map((x) => x.query.params).filter((p) => (p.deskMax ?? 0) > 0).sort((a, b) => b.deskMax - a.deskMax)[0];
  const accounts = [...(r?.deskLimits ?? [])].sort((a, b) => b.max - a.max);
  const capOfSaved: PortfolioCap | null = carried ? { max: carried.deskMax, ce: carried.cePct ?? 100, pe: carried.pePct ?? 100 } : null;
  const capDefault: PortfolioCap | null = accounts[0] ? { max: accounts[0].max, ce: accounts[0].ce, pe: accounts[0].pe } : capOfSaved;
  const capPicks: { label: string; cap: PortfolioCap }[] = [
    ...accounts.map((a) => ({ label: a.account, cap: { max: a.max, ce: a.ce, pe: a.pe } })),
    ...(capOfSaved ? [{ label: 'Saved backtests', cap: capOfSaved }] : []),
  ];
  const cap = capTyped ?? capDefault;
  // Custom without both its times (kept from a visit cut short) is each one's own hours, not a refusal.
  const hoursAsked: PortfolioHours = runHours.window === 'custom' && !(runHours.hoursFrom && runHours.hoursTo) ? AS_SAVED : runHours;
  // The folded panel's one line: the days, the hours, whose limit, and any setting switched on over the run.
  const overSaid = overWords(Object.assign({}, ...Object.values(runOver)) as Partial<BacktestParams>);
  const runSummary = [
    `${dayLabel(range.from)} → ${dayLabel(range.to)}`,
    hoursAsked.window === 'saved' ? 'hours as saved' : hoursAsked.window === 'desk' ? '9:30 PM → 3:59 PM' : hoursAsked.window === 'all' ? 'whole day' : `${time12(hoursAsked.hoursFrom ?? '')} → ${time12(hoursAsked.hoursTo ?? '')}`,
    limit === 'own' ? 'each its own limit' : cap ? `one account: ${cap.max} open · CE ${cap.ce}% · PE ${cap.pe}%` : 'one account',
    overSaid.length ? overSaid.join(' · ') : 'settings as saved',
  ].join(' · ');
  const title = wide && (
    <h2 className="m-0 mt-2 px-1 text-[15px] font-semibold">Backtest <span className="text-[12.5px] font-normal text-muted-foreground">· the signal history sold as options, on the prices the contracts really had</span></h2>
  );
  const modeSwitch = (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 sm:max-w-[420px]">
      <Segmented label="What to run" value={mode} onChange={setMode}
        options={[
          { key: 'single', label: 'Single backtest', spoken: 'One backtest: its settings, filters and result' },
          { key: 'portfolio', label: 'Portfolio', spoken: 'Saved backtests run together, and their total' },
        ]} />
    </div>
  );
  /**
   * The page: which section is open, then -- on a wide desk window -- that section's controls in a column of their
   * own with its result beside them; else one above the other.
   */
  const page = (result: React.ReactNode) => (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      {title}
      {modeSwitch}
      <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'xl:grid-cols-[400px_minmax(0,1fr)] xl:items-start')}>
        {mode === 'single' ? (
          <>
            <aside aria-label="Backtest settings" className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'xl:sticky xl:top-2 xl:max-h-[calc(100vh-1rem)] xl:overflow-y-auto xl:pr-1')}>
              {/* The saved backtests first (16 Oct 2026): a backtest is most often started from one, then changed below. */}
              <SavedBacktests key="single" mode="single" wide={wide} current={saved} wordsOf={(q) => settingsWords(q, strategies, true)} onLoad={load} run={together} onRun={setTogether} />
              {settingsPanel}
              {filterBlock}
            </aside>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
              {r && <FoldAll what="the backtest result" state={resultFolds} onChange={setResultFolds} />}
              <PanelFolds state={resultFolds} onChange={setResultFolds}>{result}</PanelFolds>
            </div>
          </>
        ) : (
          <>
            <aside aria-label="Portfolio" className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'xl:sticky xl:top-2 xl:max-h-[calc(100vh-1rem)] xl:overflow-y-auto xl:pr-1')}>
              {/*
                The portfolios first (16 Oct 2026): a run is most often started from one; what it is held to follows.
                Its own instance, by key. The two sections each hold a SavedBacktests, and when both came to sit at the
                same place in their columns React kept one for both: the list was not read again on the way in, so the
                saved backtests were never handed up here (14 Oct 2026 -- the "Saved backtests" limit went missing).
              */}
              <SavedBacktests key="portfolio" mode="portfolio" wide={wide} current={saved} wordsOf={(q) => settingsWords(q, strategies, true)} onLoad={load} run={together} onRun={startRun} onSaves={setSavedList} />
              {/*
                What the run is held to, in one panel that folds (14 Oct 2026): the days, the hours, the limit and the
                six settings had grown to a screen and a half on a phone, above the portfolios and their Run buttons.
                Folded it is one line of what is in force and Change; on a wide desk it is a column, always open.
              */}
              <Panel
                title="For this run"
                right={(
                  <button type="button" onClick={() => setRunOpen((v) => !v)} aria-expanded={runOpen}
                    className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] font-medium text-[var(--accent)]">
                    {runOpen ? 'Hide' : 'Change'}
                  </button>
                )}
              >
                <p aria-label="What the run is held to" className={cn('m-0 text-[13px] leading-snug', runOpen && 'hidden')}>{runSummary}</p>
                <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', !runOpen && 'hidden')}>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5">
                  {expiry.control}
                  <span aria-hidden className="-mb-1.5 px-1 text-[12px] text-muted-foreground">Hours of the signals (IST), for the run</span>
                  <Segmented dense label="Which signals, for the run" value={runHours.window} options={RUN_WINDOWS}
                    // Custom opens the hours every time it is tapped: chosen already, a tap is "change the hours".
                    onChange={(window) => { if (window === 'custom') setPickingRunHours(true); else { setRunHours({ window }); setPickingRunHours(false); } }} />
                  {runHours.window === 'custom' && !pickingRunHours && runHours.hoursFrom && runHours.hoursTo && (
                    <p className="m-0 px-1 text-[13px] text-muted-foreground">Signals filled <span className="text-foreground">{time12(runHours.hoursFrom)} → {time12(runHours.hoursTo)}</span> IST</p>
                  )}
                  {pickingRunHours && (
                    <CustomHours from={runHours.hoursFrom ?? '21:30'} to={runHours.hoursTo ?? '00:30'}
                      onApply={(hoursFrom, hoursTo) => { setRunHours({ window: 'custom', hoursFrom, hoursTo }); setPickingRunHours(false); }}
                      onClose={() => setPickingRunHours(false)} />
                  )}
                  <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
                    {runHours.window === 'saved'
                      ? 'Each saved backtest keeps the hours saved in it.'
                      : 'These hours are put over every saved backtest in the run, for the run only -- nothing saved is changed. One worked by a strategy keeps the strategy’s own hours.'}
                  </p>
                  <Segmented dense label="The limit on open trades" value={limit} onChange={setLimit}
                    options={[
                      { key: 'shared', label: 'One account', spoken: 'One account: one limit on open trades across all of them' },
                      { key: 'own', label: 'Each its own limit', spoken: 'Each saved backtest keeps its own limit' },
                    ]} />
                  {limit === 'shared' && <SharedCap value={capTyped} fallback={capDefault} picks={capPicks} edited={capTyped !== null} onApply={setCapTyped} onReset={() => setCapTyped(null)} />}
                  <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
                    {limit === 'shared'
                      ? 'One account: the desk’s “at most open” and its CE and PE shares are the account’s, so they are traded together for the same places. The margin is then what one account would really have held.'
                      : 'Each keeps the limit set in it and they are added up: more may be open together than one account would hold.'}
                  </p>
                </div>
                <RunFilters over={runOver} onChange={setRunOver} seed={params} stepSources={stepSources} wide={wide} />
                </div>
              </Panel>
            </aside>
            <div ref={resultRef} className="grid min-w-0 scroll-mt-2 grid-cols-[minmax(0,1fr)] gap-3">
              {together && <FoldAll what="the run together" state={runFolds} onChange={setRunFolds} />}
              {together
                ? <PanelFolds state={runFolds} onChange={setRunFolds}><PortfolioRun run={together} range={range} limit={limit} cap={cap} hours={hoursAsked} over={runOver} wide={wide} onClose={() => setTogether(null)} /></PanelFolds>
                : <Panel title="Run together"><Empty>Run a portfolio, or tick two or more saved backtests and run them together: each is worked as it is alone, and they are added up -- the total, each one, each expiry day, and the margin held across all of them.</Empty></Panel>}
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (!r) return page(<Panel><Loading error={read.error} what="the backtest (a first read of a range takes a few seconds)" /></Panel>);

  const t = r.total;
  // Every reason a signal was not traded, the limits on open trades among them (13 Oct 2026: they were left out, and the line said 4,690 traded of 2,846).
  const notTraded = Object.values(r.skipped).reduce((n, x) => n + (x ?? 0), 0);
  const rule = params.rule === 'delta' ? `delta ≤ ${params.value.toFixed(2)}` : `premium ≤ $${params.value}`;

  return page(
    <>

      <ResultNav parts={RESULT_PARTS} has={(id) => id === 'bt-summary' || id === 'bt-live' || id === 'bt-volsl' || (t.n > 0 && (id !== 'bt-perp' || t.perpNetPts !== undefined))} />
      <Updating busy={read.stale} what="the backtest">
      <div id="bt-summary" className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]">
      <Panel title="Backtest result">
        {r.strategy && (
          <div className="mb-2 grid gap-1">
            <p className="m-0 text-[14px]">By <b>{r.strategy.name}</b>&apos;s own rules: its methods and time frames, its hours and no-entry window, its SL / TGT distances, its strike rule at each hour, its lots, its TGT and its &ldquo;at most open&rdquo;.</p>
            {r.strategy.caveats.map((c) => <p key={c} className="m-0 text-[12.5px] text-[var(--warn)]">{c}</p>)}
          </div>
        )}
        <p className="m-0 text-[13px] text-muted-foreground">
          {dayLabel(r.from)} → {dayLabel(r.to)} · {rule}{!byStrategy && r.params.strikeBlocks?.length ? ` · ${strikeBlocksWords(r.params.strikeBlocks)} by time of day` : ''} · {params.lots} lot{params.lots === 1 ? '' : 's'} a signal · option target {targetWords}, stop {CUSTOM.stop.label(params.stopPct)}{params.deskMax > 0 ? ` · at most ${params.deskMax} open, CE ${params.cePct}% · PE ${params.pePct}%` : ''}{(() => {
            const b = (min = 0, max = 0) => [min > 0 ? `≥ ${min}` : null, max > 0 ? `≤ ${max}` : null].filter(Boolean).join(' ');
            const sl = b(params.slMin, params.slMax), tg = b(params.tgtMin, params.tgtMax);
            return !byStrategy && (sl || tg) ? ` · ${[sl ? `SL ${sl}` : null, tg ? `TGT ${tg}` : null].filter(Boolean).join(', ')} pts` : '';
          })()}{!byStrategy && noEntryQuery(params) ? ` · no entry ${params.noEntry!.windows.map((w) => `${time12(w.from)} – ${time12(w.to)}`).join(', ')}` : ''}
        </p>
        {t.n === 0 ? <div className="mt-2"><Empty>No signal could be traded with these settings in this range.</Empty></div> : (
          <>
            <div className={cn('mt-1 text-[26px] font-semibold tabular-nums', netClass(t.net))}>
              {moneyText(t.net)} <span className="text-[14px] font-medium text-muted-foreground">{each(t)} a trade</span>
            </div>
            {/* Before charges, the charges, after them: the net above is the last of the three. */}
            <div className="mt-2">
              <Ledger>
                <Entry label="Before charges" tone={t.net + t.charges > 0 ? 'up' : t.net + t.charges < 0 ? 'down' : undefined}>{moneyText(t.net + t.charges)}</Entry>
                <Entry label="Charges" tone="down">{moneyText(-t.charges)}</Entry>
                <Entry label="After charges" tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{moneyText(t.net)}</Entry>
              </Ledger>
            </div>
            <ChargesNote t={t} />
            {/* Margin (owner, 13 Oct 2026): what the trades would have tied up, and what the result is on it. An older server sends none. */}
            {r.margin && r.margin.peakUsd > 0 && (
              <>
                <div className="mt-2">
                  <Ledger>
                    <Entry label="Margin at most">{moneyText(r.margin.peakUsd).replace('+', '')}</Entry>
                    <Entry label="On that margin" tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{`${t.net >= 0 ? '+' : '−'}${Math.abs((100 * t.net) / r.margin.peakUsd).toFixed(1)}%`}</Entry>
                    <Entry label="A day's most, average">{moneyText(r.margin.avgDailyPeakUsd).replace('+', '')}</Entry>
                  </Ledger>
                </div>
                <p className="m-0 mt-1 px-1 text-[12px] leading-snug text-muted-foreground">
                  Estimated by the desk&apos;s 200x model, as on the Signal Strategies card: the most at once was {r.margin.peakOpen} trade{r.margin.peakOpen === 1 ? '' : 's'} open
                  {r.margin.peakAt !== null ? ` at ${timeIst(r.margin.peakAt)}` : ''}{r.margin.peakDay ? ` on the ${dayLabel(r.margin.peakDay)} expiry` : ''}; a trade held {moneyText(r.margin.avgTradeUsd).replace('+', '')} on average.
                  Delta&apos;s own figure moves with the premium and is often a little higher.
                  {marginWorking(r.margin) && <> <b className="font-medium text-foreground">The working:</b> {marginWorking(r.margin)}</>}
                </p>
              </>
            )}
            <div className="mt-2">
              <Stats cols={3}>
                <Stat label="Trades">{count(t.n)}</Stat>
                <Stat label="Won">{pct(rate(t), 0)}</Stat>
                <Stat label="Profit factor">{t.lost > 0 ? (t.won / t.lost).toFixed(2) : '—'}</Stat>
              </Stats>
            </div>
            <DayAverages days={r.days} net={t.net} />
            <BacktestCurve days={r.days} />
            <WinnersLosers t={t} />
          </>
        )}
        <p className="m-0 mt-2 text-[12.5px] leading-snug text-muted-foreground">
          {count(r.signals)} signals went in the trade; {count(r.signals - notTraded)} were traded here.
          {notTraded > 0 && <> Not traded: {skippedParts(r.skipped, { byStrategy, params, floor }).join(', ')}.</>}
          {/* The counts are of the time frames and methods chosen, as the tiles above are (13 Oct 2026: they were of every signal). */}
        </p>
        {pricedWords(r.priced) && <p className="m-0 mt-1.5 text-[12.5px] leading-snug text-muted-foreground">{pricedWords(r.priced)}</p>}
      </Panel>
      </div>

      {r.strategy && (
        <Panel title="Backtest against its real orders">
          <dl className="m-0 grid gap-1 text-[13.5px]">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Backtest</dt>
              <dd className="m-0 text-right tabular-nums">{count(t.n)} trades · {pct(rate(t), 0)} won · <b className={netClass(t.net)}>{moneyText(t.net)}</b></dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Real orders</dt>
              <dd className="m-0 text-right tabular-nums">
                {r.strategy.real.n === 0 && r.strategy.real.open === 0 ? 'none in this range' : (
                  <>{count(r.strategy.real.n)} closed · {pct(r.strategy.real.n ? r.strategy.real.wins / r.strategy.real.n : null, 0)} won{r.strategy.real.open ? ` · ${r.strategy.real.open} open` : ''} · <b className={netClass(r.strategy.real.net)}>{moneyText(r.strategy.real.net)}</b></>
                )}
              </dd>
            </div>
          </dl>
          <p className="m-0 mt-2 text-[12px] leading-snug text-muted-foreground">
            They differ where the desk did: real orders wait in the line, meet the desk-wide limit and margin, fill a little worse or better, and exit on time steps the backtest does not replay.
          </p>
        </Panel>
      )}

      {t.n > 0 && (
        <BacktestBreakdowns total={t} b={r} wide={wide} idPrefix="bt"
          sessions={(r.bySession?.length ?? 0) > 0 ? (
            <Panel title="By session of the day">
              <SessionTable rows={r.bySession!} onOpen={(pick, title) => setOpenTrades({ key: `session:${pick.slotFrom}-${pick.slotTo}:${pick.method ?? ''}`, title, pick })} />
            </Panel>
          ) : null}
          expiryDays={(
            <Panel title="By expiry day">
              <Table caption="Backtest by expiry day" first="Expiry day" onCount={(day) => setOpenTrades({ key: day, pick: { day } })} rows={[...r.days].reverse().map((d) => ({ ...d, key: d.day, name: `${dayLabel(d.day)}${d.live ? ' · so far' : ''}${d.grain ? ` · ${GRAIN[d.grain]}` : ''}` }))} />
              <p className="m-0 mt-1 text-[12px] text-muted-foreground">Tap a day&apos;s trade count for its trades, one by one.</p>
            </Panel>
          )} />
      )}

      <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
        How it is worked out: at each signal&apos;s fill on the perp, the put (a BUY) or the call (a SELL) of that expiry day&apos;s contract is sold at its bid, at the
        strike the rule picks; it is bought back at the offer when the perp reaches the signal&apos;s stop or TGT1, or sooner if the option reaches its own
        target or stop, or at the end of the window; charges are taken on both fills. The perp is read a minute at a time, and so are the options
        wherever there are one-minute prices: the desk&apos;s own record from 13 Oct 2026 on, and before it Delta&apos;s one-minute mark with the bid
        and the offer as far from it as the desk&apos;s last five-minute reading had them (an estimate: about $2 of premium from the real quote
        on average where both exist). A day still on five-minute prices has an exit priced up to five minutes late.
        {r.strategy || params.deskMax > 0 ? ' The limits on open trades are counted as set above; margin and the order queue are not' : ' No limit on open trades unless one is set above, no margin and no queue'}
        {' '}— so the total is not what an account would have made: read what a trade of each kind made.
      </p>
      </Updating>
      {/* The SL, delta and lots by volatility against the settings as set, on these settings' signals (17 Oct 2026): asked for with a tap. */}
      <div id="bt-volsl" className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]"><VolStudy askKey={JSON.stringify(query)} read={(a) => getVolStudy(query, a)} readTrades={(a, pick) => getVolStudyTrades(query, a, pick)} wide={wide} /></div>
      {/* The same backtest beside the live desk (14 Oct 2026): asked with the question on the screen, so it is the check of this result. */}
      <div id="bt-live" className="grid min-w-0 scroll-mt-14 grid-cols-[minmax(0,1fr)]"><LiveCheck askKey={JSON.stringify(query)} read={() => getLiveCheck(query)} /></div>
      <DayTradesSheet day={openTrades?.key ?? null} title={openTrades?.title} read={() => getBacktestTrades(query, openTrades!.pick)} onClose={() => setOpenTrades(null)} />
    </>
  );
}
