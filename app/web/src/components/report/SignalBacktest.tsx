import { useEffect, useState } from 'react';
import { getSignalBacktest } from '@/api/signal-backtest';
import { usePersisted } from '@/hooks/usePersisted';
import { pct } from '@/lib/format';
import { dayLabel, moneyText, ptsText, timeIst } from '@/lib/market-report';
import type { PairStat } from '@/lib/method-pairs';
import { cn } from '@/lib/utils';
import { time12 } from '@/lib/time';
import type { BacktestParams, BacktestQuery, BacktestSave, BoardGrain, BtExit, BtRow, SavedQuery } from '@/types/signal-backtest';
import { Chip, Empty, Loading, Panel, Segmented, Stat, Stats } from '@/components/mobile/parts';
import { PairList } from '@/components/mobile/PairList';
import { FilterBar, FilterPicker, METHODS, STRATEGIES } from '@/components/mobile/FilterPicker';
import { useExpiryRange } from '@/components/report/ExpiryRange';
import { Updating, useAnswer } from '@/components/report/Updating';
import { Entry, FOLD, Ledger, Table, count, each, netClass, rate } from '@/components/report/backtest-parts';
import { PortfolioRun, SavedBacktests, type TogetherRun } from '@/components/report/SavedBacktests';
import type { PortfolioCap, PortfolioLimit } from '@/api/backtest-saves';
import { BACKTEST_DEFAULTS as DEFAULTS, PREMIUM_FLOOR as FLOOR, settingsWords } from '@/components/report/backtest-words';

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
  { key: 'desk', label: '9:30 PM–3:59 PM', spoken: 'Only signals from 9:30 PM to 3:59 PM, as the strategies trade' },
  { key: 'all', label: 'Whole day', spoken: 'Signals of the whole expiry day' },
  { key: 'custom', label: 'Custom', spoken: 'Signals in hours of your own' },
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

/** One group of settings under its own heading. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    // One column that may be narrower than what is in it: a bare `grid` column is as wide as its widest child, and pushed the phone's page sideways.
    <section aria-label={title} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 rounded-md border border-[var(--line-soft)] p-3 max-sm:rounded-none max-sm:border-0 max-sm:border-t max-sm:px-0 max-sm:pb-1 max-sm:pt-3 max-sm:first:border-t-0 max-sm:first:pt-0">
      <h3 className="m-0 text-[12px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">{title}</h3>
      {children}
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
const EXITS: { key: BtExit; label: string }[] = [
  { key: 'perp-tgt', label: 'Perp TGT' }, { key: 'perp-sl', label: 'Perp SL' }, { key: 'option-tgt', label: 'Option TGT' },
  { key: 'option-sl', label: 'Option SL' }, { key: 'window-end', label: 'Window end' },
];
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
 * One account's limit on a run together, shown and typed (owner, 13 Oct 2026: "show the at-most-open field with
 * its default value, editable"): at most open across all of them, and the CE and PE shares of it. It opens on the
 * default -- what the saved backtests themselves carry, or the account's own limit -- and takes a typed one on
 * leaving a field or Enter, checked as the desk checks it; Default puts it back.
 */
function SharedCap({ value, fallback, edited, onApply, onReset }: { value: PortfolioCap | null; fallback: PortfolioCap | null; edited: boolean; onApply: (c: PortfolioCap) => void; onReset: () => void }) {
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
  return (
    <div role="group" aria-label="One account's limit" className="grid min-w-0 gap-1.5">
      <div className="grid min-w-0 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
        {input('max', 'At most open, together', '')}
        {input('ce', 'CE max', '%')}
        {input('pe', 'PE max', '%')}
      </div>
      <p role={problem ? 'alert' : 'status'} className={cn('m-0 px-1 text-[12px] leading-snug', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
        {problem ?? (!shown ? 'No saved backtest and no account has an “at most open”: none is shared until one is typed here.'
          : edited ? `Your own: ${said(shown)}.${fallback ? ` The default is ${said(fallback)}.` : ''}`
            : `The default: ${said(shown)} -- the largest “at most open” among the saved backtests run, or the account's own. Type another to try it.`)}
        {edited && !problem && <> <button type="button" onClick={onReset} className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] font-medium text-[var(--accent)] underline">Default</button></>}
      </p>
    </div>
  );
}

/** A day's pricing in a word, beside its name. */
const GRAIN: Record<BoardGrain, string> = { 'own-1m': '1m prices', 'mark-1m': '1m est.', '5m': '5m prices' };

/** What the options were priced on, in a sentence: said only when the server says it. */
function pricedWords(p: Record<BoardGrain, number> | undefined): string | null {
  if (!p) return null;
  const own = p['own-1m'] ?? 0, mark = p['mark-1m'] ?? 0, five = p['5m'] ?? 0, all = own + mark + five;
  if (all === 0) return null;
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const fine = [own ? `${days(own)} on the desk's own 1-minute record` : null, mark ? `${days(mark)} on Delta's 1-minute mark with the desk's recorded spread (an estimate)` : null].filter(Boolean).join(', ');
  if (five === 0) return `Option prices a minute at a time: ${fine}.`;
  const rest = `${days(five)} on 5-minute prices -- a day still running, or one whose 1-minute prices are still being fetched from Delta`;
  return fine ? `Option prices a minute at a time on ${own + mark} of ${days(all)}: ${fine}. The other ${rest}.` : `Option prices: ${rest}.`;
}

/** Every method as options, across its timeframes: those in profit and those in loss, ten of each to begin with. */
function MethodsAsOptions({ rows, wide }: { rows: readonly BtRow[]; wide: boolean }) {
  const [all, setAll] = useState(false);
  const traded = rows.filter((m) => m.n > 0);
  const best = traded.filter((m) => m.net > 0).sort((a, b) => b.net - a.net);
  const worst = traded.filter((m) => m.net < 0).sort((a, b) => a.net - b.net);
  const FIRST = 10;
  return (
    <Panel title="By method" right={<span className="text-[11.5px] text-muted-foreground">{traded.length} traded</span>}>
      <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4', wide && 'lg:grid-cols-2')}>
        <section aria-label="Methods in profit as options">
          <h3 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">In profit · {best.length}</h3>
          <Table caption="Backtest: methods in profit" first="Method" rows={all ? best : best.slice(0, FIRST)} perp />
        </section>
        <section aria-label="Methods in loss as options">
          <h3 className="m-0 mb-1 text-[12.5px] font-semibold text-muted-foreground">In loss · {worst.length}</h3>
          <Table caption="Backtest: methods in loss" first="Method" rows={all ? worst : worst.slice(0, FIRST)} perp />
        </section>
      </div>
      {(best.length > FIRST || worst.length > FIRST) && (
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all}
          className="mt-2 min-h-[40px] w-full rounded-md border-0 bg-muted font-[inherit] text-[13px] font-medium text-foreground">
          {all ? `Show the first ${FIRST} of each` : `Show all ${traded.length} methods`}
        </button>
      )}
    </Panel>
  );
}

const pairOf = (r: BtRow): PairStat => ({
  key: r.key, name: r.name, tf: r.tf ?? '', trades: r.n, wins: r.wins, losses: r.losses,
  winRate: rate(r), profitFactor: r.lost > 0 ? r.won / r.lost : null, net: r.net,
});

export function SignalBacktest({ now = Date.now(), wide = false }: { now?: number; wide?: boolean }) {
  const expiry = useExpiryRange('signalBacktest', now);
  const [stored, setParams] = usePersisted<BacktestParams>('signalBacktest.params', DEFAULTS);
  const [tfs, setTfs] = usePersisted<string[]>('signalBacktest.tfs', []);
  const [methods, setMethods] = usePersisted<string[]>('signalBacktest.methods', []);
  const [grouping, setGrouping] = usePersisted<'kind' | 'family'>('signalBacktest.grouping', 'family');
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
  const read = useAnswer(JSON.stringify(query), () => getSignalBacktest(query), 300_000);
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
  /*
   * One section at a time (owner, 13 Oct 2026: "a single backtest, or a portfolio run -- the portfolio section or
   * the backtest section, only one open at a time"): the settings, filters and result of one backtest; or the
   * portfolios, the saved backtests to tick, and what they come to together. Which is open, and the last run
   * together, are kept in this browser.
   */
  const [mode, setMode] = usePersisted<'single' | 'portfolio'>('signalBacktest.mode', 'single');
  const [together, setTogether] = usePersisted<TogetherRun | null>('signalBacktest.together', null);
  // One account's limit over a run together, or each saved backtest's own (`PortfolioLimit`): one account to begin with.
  const [limit, setLimit] = usePersisted<PortfolioLimit>('signalBacktest.together.limit', 'shared');
  // One account's limit: typed here and kept, or (null) the default worked out below.
  const [capTyped, setCapTyped] = usePersisted<PortfolioCap | null>('signalBacktest.together.cap', null);
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
      <Section title="What to backtest">
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
        <Section title="Strike and exits">
      <Segmented dense label="How the strike is picked" value={params.rule} options={RULES} onChange={(rule) => set({ rule, value: rule === 'delta' ? 0.1 : 50 })} />
      <ChipRow wide={wide} label={params.rule === 'delta' ? 'Sell the nearest strike with a delta of at most' : 'Sell the dearest strike priced at most'}>
        {values.map((v) => <Chip key={v} on={params.value === v} onClick={() => set({ value: v })}>{params.rule === 'delta' ? v.toFixed(2) : `$${v}`}</Chip>)}
        <CustomValue key={params.rule} value={params.value} presets={values} spec={params.rule === 'delta' ? CUSTOM.delta : CUSTOM.premium}
          name={params.rule === 'delta' ? 'Delta limit' : 'Premium limit'} onChange={(value) => set({ value })} />
      </ChipRow>
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
        <TargetSteps key={JSON.stringify(params.targetSteps ?? [])} start={params.targetPct > 0 ? params.targetPct : 0.7} steps={params.targetSteps ?? []}
          copyFrom={stepSources} onApply={(targetPct, targetSteps) => set({ targetPct, targetSteps })} />
      )}
      <ChipRow wide={wide} label="The option's own stop, over the premium sold">
        {STOPS.map((s) => <Chip key={s.value} on={params.stopPct === s.value} onClick={() => set({ stopPct: s.value })}>{s.label}</Chip>)}
        <CustomValue value={params.stopPct} presets={STOPS.map((x) => x.value)} spec={CUSTOM.stop} name="Option stop" onChange={(stopPct) => set({ stopPct })} />
      </ChipRow>
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
      <Section title="Which signals are taken">
        {!byStrategy && <>
      <SlTgtRange value={{ slMin: params.slMin ?? 0, slMax: params.slMax ?? 0, tgtMin: params.tgtMin ?? 0, tgtMax: params.tgtMax ?? 0 }} onApply={(r) => set(r)} />
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
          <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
            <b className="font-medium text-foreground">Volatility filter{(params.vol ?? 'off') === 'off' ? ' · off' : ''}.</b> The last two hours of 15-minute candles when the signal fills, against the average of the five expiry days before:
            low is under 0.8×, high over 1.3×, medium between.
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
    <Section title="Filters">
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
              // Each method with what it made as options (owner, 13 Oct 2026: "show the methods' profit and loss").
              options={r.choices.methods.map((m) => ({
                key: m.key, name: m.name, tone: m.net > 0 ? 'up' as const : m.net < 0 ? 'down' as const : undefined, value: m.net,
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
        <button type="button" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}
          className={cn('min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] font-medium text-[var(--accent)]', wide && 'xl:hidden')}>
          {settingsOpen ? 'Hide' : 'Change'}
        </button>
      )}
    >
      <p className={cn('m-0 text-[13px] leading-snug', settingsOpen && 'hidden', wide && 'xl:hidden')}>{summary}</p>
      <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', !settingsOpen && 'hidden', wide && 'xl:grid')}>{setup}</div>
    </Panel>
  );
  // The default: the largest "at most open" among the saved backtests run (all of them, before any is), with its shares; else the account's own.
  const ran = together ? savedList.filter((x) => together.ids.includes(x.id)) : savedList;
  const carried = ran.map((x) => x.query.params).filter((p) => (p.deskMax ?? 0) > 0).sort((a, b) => b.deskMax - a.deskMax)[0];
  const ofAccount = [...(r?.deskLimits ?? [])].sort((a, b) => b.max - a.max)[0];
  const capDefault: PortfolioCap | null = carried ? { max: carried.deskMax, ce: carried.cePct ?? 100, pe: carried.pePct ?? 100 } : ofAccount ? { max: ofAccount.max, ce: ofAccount.ce, pe: ofAccount.pe } : null;
  const cap = capTyped ?? capDefault;
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
              {settingsPanel}
              {filterBlock}
              <SavedBacktests mode="single" current={saved} wordsOf={(q) => settingsWords(q, strategies, true)} onLoad={load} run={together} onRun={setTogether} />
            </aside>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">{result}</div>
          </>
        ) : (
          <>
            <aside aria-label="Portfolio" className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'xl:sticky xl:top-2 xl:max-h-[calc(100vh-1rem)] xl:overflow-y-auto xl:pr-1')}>
              <Panel title="Run over">
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5">
                  {expiry.control}
                  <Segmented dense label="The limit on open trades" value={limit} onChange={setLimit}
                    options={[
                      { key: 'shared', label: 'One account', spoken: 'One account: one limit on open trades across all of them' },
                      { key: 'own', label: 'Each its own limit', spoken: 'Each saved backtest keeps its own limit' },
                    ]} />
                  {limit === 'shared' && <SharedCap value={capTyped} fallback={capDefault} edited={capTyped !== null} onApply={setCapTyped} onReset={() => setCapTyped(null)} />}
                  <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
                    {limit === 'shared'
                      ? 'One account: the desk’s “at most open” and its CE and PE shares are the account’s, so they are traded together for the same places. The margin is then what one account would really have held.'
                      : 'Each keeps the limit set in it and they are added up: more may be open together than one account would hold.'}
                  </p>
                </div>
              </Panel>
              <SavedBacktests mode="portfolio" current={saved} wordsOf={(q) => settingsWords(q, strategies, true)} onLoad={load} run={together} onRun={setTogether} onSaves={setSavedList} />
            </aside>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
              {together
                ? <PortfolioRun run={together} range={range} limit={limit} cap={cap} wide={wide} onClose={() => setTogether(null)} />
                : <Panel title="Run together"><Empty>Run a portfolio, or tick two or more saved backtests and run them together: each is worked as it is alone, and they are added up -- the total, each one, each expiry day, and the margin held across all of them.</Empty></Panel>}
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (!r) return page(<Panel><Loading error={read.error} what="the backtest (a first read of a range takes a few seconds)" /></Panel>);

  const t = r.total;
  const sl = t.exits['perp-sl'], tg = t.exits['perp-tgt'];
  // Every reason a signal was not traded, the limits on open trades among them (13 Oct 2026: they were left out, and the line said 4,690 traded of 2,846).
  const notTraded = Object.values(r.skipped).reduce((n, x) => n + (x ?? 0), 0);
  const best = r.pairs.filter((p) => p.n > 0 && p.net > 0).map(pairOf);
  const worst = r.pairs.filter((p) => p.n > 0 && p.net < 0).map(pairOf).sort((a, b) => a.net - b.net || b.trades - a.trades);
  const perpOf = new Map(r.pairs.map((p) => [p.key, p.perpPts]));
  const note = (p: PairStat) => `perp ${ptsText(perpOf.get(p.key) ?? 0)}`;
  const amount = (p: { net: number }) => moneyText(p.net);
  const rule = params.rule === 'delta' ? `delta ≤ ${params.value.toFixed(2)}` : `premium ≤ $${params.value}`;

  return page(
    <>

      <Updating busy={read.stale} what="the backtest">
      <Panel title="Backtest result">
        {r.strategy && (
          <div className="mb-2 grid gap-1">
            <p className="m-0 text-[14px]">By <b>{r.strategy.name}</b>&apos;s own rules: its methods and time frames, its hours and no-entry window, its SL / TGT distances, its strike rule at each hour, its lots, its TGT and its &ldquo;at most open&rdquo;.</p>
            {r.strategy.caveats.map((c) => <p key={c} className="m-0 text-[12.5px] text-[var(--warn)]">{c}</p>)}
          </div>
        )}
        <p className="m-0 text-[13px] text-muted-foreground">
          {dayLabel(r.from)} → {dayLabel(r.to)} · {rule} · {params.lots} lot{params.lots === 1 ? '' : 's'} a signal · option target {targetWords}, stop {CUSTOM.stop.label(params.stopPct)}{params.deskMax > 0 ? ` · at most ${params.deskMax} open, CE ${params.cePct}% · PE ${params.pePct}%` : ''}{(() => {
            const b = (min = 0, max = 0) => [min > 0 ? `≥ ${min}` : null, max > 0 ? `≤ ${max}` : null].filter(Boolean).join(' ');
            const sl = b(params.slMin, params.slMax), tg = b(params.tgtMin, params.tgtMax);
            return !byStrategy && (sl || tg) ? ` · ${[sl ? `SL ${sl}` : null, tg ? `TGT ${tg}` : null].filter(Boolean).join(', ')} pts` : '';
          })()}
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
            <p className="m-0 mt-1 px-1 text-[12px] text-muted-foreground">
              Charges: Delta&apos;s fee on each fill (the lower of 0.01% of the BTC value and 3.5% of the premium) and 18% GST on it, on the sale and on the buy-back -- {t.n > 0 ? moneyText(-t.charges / t.n) : '—'} a trade, {t.net + t.charges !== 0 ? `${Math.round((100 * t.charges) / Math.abs(t.net + t.charges))}% of the result before them` : ''}.
            </p>
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
            {/*
              A day, on average (owner, 13 Oct 2026: "the average profit and loss per day"): over the expiry days
              that traded, and the days in profit and the days in loss each on their own.
            */}
            {(() => {
              const traded = r.days.filter((d) => d.n > 0);
              if (traded.length === 0) return null;
              const up = traded.filter((d) => d.net > 0), down = traded.filter((d) => d.net < 0);
              const mean = (xs: typeof traded) => xs.reduce((a, d) => a + d.net, 0) / xs.length;
              const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
              return (
                <div className="mt-2">
                  <Ledger>
                    <Entry label={`A day, on average · ${days(traded.length)}`} tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{moneyText(t.net / traded.length)}</Entry>
                    <Entry label={`A day in profit · ${days(up.length)}`} tone="up">{up.length ? moneyText(mean(up)) : '—'}</Entry>
                    <Entry label={`A day in loss · ${days(down.length)}`} tone="down">{down.length ? moneyText(mean(down)) : '—'}</Entry>
                  </Ledger>
                </div>
              );
            })()}
            {/* Two to a row: six-figure rupees do not fit a third of a phone. */}
            <div className="mt-2">
              <Stats cols={2}>
                <Stat label="Winners made" tone="up">{moneyText(t.won)}</Stat>
                <Stat label="Losers lost" tone="down">{moneyText(-t.lost)}</Stat>
              </Stats>
            </div>
            <p className="m-0 mt-2 text-[13px]">
              <span className="text-muted-foreground">The same trades on the perp: </span>
              <b className={cn('font-semibold tabular-nums', netClass(t.perpPts))}>{ptsText(t.perpPts)}</b>
            </p>
          </>
        )}
        <p className="m-0 mt-2 text-[12.5px] leading-snug text-muted-foreground">
          {count(r.signals)} signals went in the trade; {count(r.signals - notTraded)} were traded here.
          {notTraded > 0 && <> Not traded: {[
            r.skipped['outside-window'] ? `${count(r.skipped['outside-window'])} outside ${byStrategy ? 'its days and hours' : 'the hours chosen'}` : null,
            r.skipped['no-entry-window'] ? `${count(r.skipped['no-entry-window'])} inside its no-entry window` : null,
            r.skipped.distance ? `${count(r.skipped.distance)} with the SL or TGT outside ${byStrategy ? 'its distances' : 'the range set'}` : null,
            r.skipped.volatility ? `${count(r.skipped.volatility)} not in ${params.vol ?? 'that'} volatility` : null,
            r.skipped['at-limit'] ? `${count(r.skipped['at-limit'])} while it already had its most open` : null,
            r.skipped['desk-limit'] ? `${count(r.skipped['desk-limit'])} while ${params.deskMax} were open (at most open)` : null,
            r.skipped['side-limit'] ? `${count(r.skipped['side-limit'])} while that side was at its CE / PE max` : null,
            r.skipped['no-strike'] ? `${count(r.skipped['no-strike'])} with no strike inside the rule${byStrategy ? ' worth its floor' : floor > 0 ? ` worth $${floor}` : ''}` : null,
            r.skipped['no-board'] ? `${count(r.skipped['no-board'])} with no option prices recorded then` : null,
            r.skipped['no-exit-price'] ? `${count(r.skipped['no-exit-price'])} with no price to exit at` : null,
          ].filter(Boolean).join(', ')}.</>}
          {/* The counts are of the time frames and methods chosen, as the tiles above are (13 Oct 2026: they were of every signal). */}
        </p>
        {pricedWords(r.priced) && <p className="m-0 mt-1.5 text-[12.5px] leading-snug text-muted-foreground">{pricedWords(r.priced)}</p>}
      </Panel>

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

      {sl && sl.n > 0 && (
        <Panel title="When the perp's SL was hit">
          <p className="m-0 text-[14px] leading-snug">
            The perp reached the signal&apos;s stop on <b>{count(sl.n)}</b> trades. The option was <b className="text-[var(--up)]">still a profit on {count(sl.wins)}</b> of them
            ({pct(sl.wins / sl.n, 0)}) and a loss on {count(sl.n - sl.wins)}. Together: <b className={netClass(sl.net)}>{moneyText(sl.net)}</b>, {moneyText(sl.net / sl.n)} a trade.
          </p>
          {tg && tg.n > 0 && (
            <p className="m-0 mt-2 text-[13px] leading-snug text-muted-foreground">
              For comparison, the perp reached the target on {count(tg.n)} trades: the option was a profit on {pct(tg.wins / tg.n, 0)} of them,{' '}
              <span className={netClass(tg.net)}>{moneyText(tg.net)}</span> together, {moneyText(tg.net / tg.n)} a trade.
            </p>
          )}
        </Panel>
      )}

      {t.n > 0 && (
        <>
          <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'lg:grid-cols-2')}>
            <Panel title="Closed by which exit">
              <table className={FOLD.table}>
                <caption className="sr-only">Backtest: which exit closed the trades</caption>
                <thead className={FOLD.head}>
                  <tr className="text-left text-[11.5px] text-muted-foreground">
                    <th scope="col" className="py-1 pr-2 font-medium">Closed by</th>
                    <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
                    <th scope="col" className="py-1 pr-2 text-right font-medium">In profit</th>
                    <th scope="col" className="py-1 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody className={FOLD.body}>
                  {EXITS.flatMap((e) => {
                    const x = t.exits[e.key];
                    return x && x.n > 0 ? [(
                      <tr key={e.key} className={FOLD.row}>
                        <th scope="row" className={FOLD.name}>{e.label}</th>
                        <td className={FOLD.trades}>{count(x.n)}</td>
                        <td className={FOLD.inProfit}>{pct(x.wins / x.n, 0)}</td>
                        <td className={FOLD.net}>
                          <span className={cn('block whitespace-nowrap font-semibold', netClass(x.net))}>{moneyText(x.net)}</span>
                          <span className={cn('block whitespace-nowrap text-[11.5px]', netClass(x.net))}>{moneyText(x.net / x.n)}</span>
                        </td>
                      </tr>
                    )] : [];
                  })}
                </tbody>
              </table>
            </Panel>
            {(r.byVol?.length ?? 0) > 0 && (
              <Panel title="By volatility when the signal filled">
                <Table caption="Backtest by volatility" first="Volatility" rows={r.byVol!} />
              </Panel>
            )}
            <Panel title="By time frame">
              <Table caption="Backtest by time frame" first="Time frame" rows={r.byTf.map((x) => (x.key === 'chain' ? { ...x, name: 'TF chain' } : x))} perp />
            </Panel>
          </div>

          <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'lg:grid-cols-2')}>
            <PairList title="Best pairs as options" tone="up" pairs={best} amount={amount} note={note} empty="No method and time frame in profit as an option here." />
            <PairList title="Worst pairs as options" tone="down" pairs={worst} amount={amount} note={note} empty="No method and time frame in loss as an option here." />
          </div>

          <MethodsAsOptions rows={r.byMethod} wide={wide} />

          <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3', wide && 'lg:grid-cols-2')}>
            <Panel title="By kind of day">
              <Segmented label="Group the days by" value={grouping} onChange={setGrouping}
                options={[{ key: 'family', label: 'Trend family', spoken: 'By family: up trend, down trend, range, turn' }, { key: 'kind', label: 'Market type', spoken: 'By each market type' }]} />
              <div className="mt-2"><Table caption="Backtest by kind of day" first={grouping === 'family' ? 'Family' : 'Market type'} rows={grouping === 'family' ? r.byFamily : r.byPattern} days /></div>
            </Panel>
            <Panel title="By expiry day">
              <Table caption="Backtest by expiry day" first="Expiry day" rows={[...r.days].reverse().map((d) => ({ ...d, key: d.day, name: `${dayLabel(d.day)}${d.live ? ' · so far' : ''}${d.grain ? ` · ${GRAIN[d.grain]}` : ''}` }))} />
            </Panel>
          </div>
        </>
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
    </>
  );
}
