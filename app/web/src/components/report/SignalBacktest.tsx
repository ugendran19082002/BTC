import { useEffect, useState } from 'react';
import { getSignalBacktest } from '@/api/signal-backtest';
import { usePersisted } from '@/hooks/usePersisted';
import { pct } from '@/lib/format';
import { dayLabel, moneyText, ptsText, timeIst } from '@/lib/market-report';
import type { PairStat } from '@/lib/method-pairs';
import { cn } from '@/lib/utils';
import { time12 } from '@/lib/time';
import type { BacktestParams, BacktestQuery, BtExit, BtRow, BtTot } from '@/types/signal-backtest';
import { Chip, Empty, Loading, Panel, Segmented, Stat, Stats } from '@/components/mobile/parts';
import { PairList } from '@/components/mobile/PairList';
import { FilterBar, FilterPicker, METHODS, STRATEGIES } from '@/components/mobile/FilterPicker';
import { useExpiryRange } from '@/components/report/ExpiryRange';
import { Updating, useAnswer } from '@/components/report/Updating';

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
  { key: 'desk', label: '9:30 PM → 3:59 PM', spoken: 'Only signals from 9:30 PM to 3:59 PM, as the strategies trade' },
  { key: 'all', label: 'Whole expiry day', spoken: 'Signals of the whole expiry day' },
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
          className="h-11 rounded-lg border-0 bg-[var(--up)] font-[inherit] text-[14px] font-semibold text-[var(--bg)] disabled:opacity-40">Use these hours</button>
      </div>
    </div>
  );
}
const DELTAS = [0.05, 0.1, 0.15, 0.2];
const PREMIUMS = [25, 50, 75, 100];
const STOPS: { value: number; label: string }[] = [{ value: 1, label: '+100%' }, { value: 1.5, label: '+150%' }, { value: 3, label: '+300%' }, { value: 0, label: 'No stop' }];
const LOTS = [1, 10, 16];
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
    <section aria-label="SL and TGT range" className="grid gap-2 rounded-md border border-[var(--line-soft)] p-3">
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
            className="h-10 rounded-md border-0 bg-[var(--up)] px-3 font-[inherit] text-[13.5px] font-semibold text-[var(--bg)] disabled:opacity-40">Use</button>
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
const DEFAULTS: BacktestParams = { rule: 'delta', value: 0.1, lots: 10, targetPct: 0.9, stopPct: 3, window: 'desk', deskMax: 0, cePct: 100, pePct: 100 };
const DESK_MAX = [0, 20, 35, 58];
const SIDE_PCTS = [50, 60, 70, 80, 90, 100];
/** Each side's most open, as the desk rounds it (strategy/types.ts `sideCaps`): at least one, never more than the whole. */
const sideOf = (max: number, pctOf: number) => Math.min(max, Math.max(1, Math.round((max * pctOf) / 100)));

const netClass = (n: number) => (n > 0 ? 'text-[var(--up)]' : n < 0 ? 'text-[var(--down)]' : '');
const rate = (t: Pick<BtTot, 'n' | 'wins'>) => (t.n > 0 ? t.wins / t.n : null);
const each = (t: Pick<BtTot, 'n' | 'net'>) => (t.n > 0 ? moneyText(t.net / t.n) : '—');
const count = (n: number) => n.toLocaleString('en-US');

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
function Table({ caption, first, rows, perp = false, days = false }: { caption: string; first: string; rows: readonly BtRow[]; perp?: boolean; days?: boolean }) {
  const shown = rows.filter((r) => r.n > 0);
  if (shown.length === 0) return <Empty>No trade here.</Empty>;
  return (
    <table className="w-full border-collapse text-[13px] tabular-nums">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-[11.5px] text-muted-foreground">
          <th scope="col" className="py-1 pr-2 font-medium">{first}</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Won</th>
          <th scope="col" className="py-1 text-right font-medium">Net</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.key} className="border-t border-[var(--line-soft)] align-top">
            <th scope="row" className="py-1.5 pr-2 text-left font-medium [overflow-wrap:anywhere]">
              <span className="normal-case tracking-normal">{r.name}</span>
              {days && r.days ? <span className="block text-[11.5px] font-normal text-muted-foreground">{r.days} day{r.days === 1 ? '' : 's'}</span> : null}
              {perp && <span className={cn('block text-[11.5px] font-normal', netClass(r.perpPts))}>perp {ptsText(r.perpPts)}</span>}
            </th>
            <td className="py-1.5 pr-2 text-right">{count(r.n)}</td>
            <td className="py-1.5 pr-2 text-right">{pct(rate(r), 0)}</td>
            <td className="py-1.5 text-right">
              <span className={cn('block whitespace-nowrap font-semibold', netClass(r.net))}>{moneyText(r.net)}</span>
              <span className={cn('block whitespace-nowrap text-[11.5px]', netClass(r.net))}>{each(r)}</span>
              {/* What the fees took, under what was left: the net is after them. */}
              <span className="block whitespace-nowrap text-[11px] text-muted-foreground">charges {moneyText(-r.charges)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
  const pickMethods = (m: string[]) => { setMethods(m); setFromStrategies([]); };
  const pickTfs = (t: string[]) => { setTfs(t); setFromStrategies([]); };
  // Anything remembered from an older build falls back to the defaults rather than asking for what the server refuses.
  const merged: BacktestParams = { ...DEFAULTS, ...stored };
  const params: BacktestParams = merged.window === 'custom' && !(merged.hoursFrom && merged.hoursTo) ? { ...merged, window: 'desk' } : merged;
  const set = (o: Partial<BacktestParams>) => setParams({ ...params, ...o });
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
  const values = params.rule === 'delta' ? DELTAS : PREMIUMS;

  const settings = (
    <>
      {wide && <h2 className="m-0 mt-2 px-1 text-[15px] font-semibold">Backtest <span className="text-[12.5px] font-normal text-muted-foreground">· the signal history sold as options, on the prices the contracts really had</span></h2>}
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
      <Segmented label="Which signals" value={params.window} options={WINDOWS}
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
      <Segmented label="How the strike is picked" value={params.rule} options={RULES} onChange={(rule) => set({ rule, value: rule === 'delta' ? 0.1 : 50 })} />
      <ChipRow wide={wide} label={params.rule === 'delta' ? 'Sell the nearest strike with a delta of at most' : 'Sell the dearest strike priced at most'}>
        {values.map((v) => <Chip key={v} on={params.value === v} onClick={() => set({ value: v })}>{params.rule === 'delta' ? v.toFixed(2) : `$${v}`}</Chip>)}
        <CustomValue key={params.rule} value={params.value} presets={values} spec={params.rule === 'delta' ? CUSTOM.delta : CUSTOM.premium}
          name={params.rule === 'delta' ? 'Delta limit' : 'Premium limit'} onChange={(value) => set({ value })} />
      </ChipRow>
      <ChipRow wide={wide} label="The option's own target, of the premium kept">
        {TARGETS.map((x) => <Chip key={x.value} on={params.targetPct === x.value} onClick={() => set({ targetPct: x.value })}>{x.label}</Chip>)}
        <CustomValue value={params.targetPct} presets={TARGETS.map((x) => x.value)} spec={CUSTOM.target} name="Option target" onChange={(targetPct) => set({ targetPct })} />
      </ChipRow>
      <ChipRow wide={wide} label="The option's own stop, over the premium sold">
        {STOPS.map((s) => <Chip key={s.value} on={params.stopPct === s.value} onClick={() => set({ stopPct: s.value })}>{s.label}</Chip>)}
        <CustomValue value={params.stopPct} presets={STOPS.map((x) => x.value)} spec={CUSTOM.stop} name="Option stop" onChange={(stopPct) => set({ stopPct })} />
      </ChipRow>
      <ChipRow wide={wide} label="Lots a signal">
        {LOTS.map((n) => <Chip key={n} on={params.lots === n} onClick={() => set({ lots: n })}>{n}</Chip>)}
        <CustomValue value={params.lots} presets={LOTS} spec={CUSTOM.lots} name="Lots" onChange={(lots) => set({ lots })} />
      </ChipRow>
      <SlTgtRange value={{ slMin: params.slMin ?? 0, slMax: params.slMax ?? 0, tgtMin: params.tgtMin ?? 0, tgtMax: params.tgtMax ?? 0 }} onApply={(r) => set(r)} />
      </>}
      <section aria-label="The desk's limits" className="grid gap-2 rounded-md border border-[var(--line-soft)] p-3">
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
        <div className={wide ? 'px-4' : undefined}>
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
    </>
  );

  if (!r) return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">{settings}<Panel><Loading error={read.error} what="the backtest (a first read of a range takes a few seconds)" /></Panel></div>;

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

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      {settings}

      <Updating busy={read.stale} what="the backtest">
      <Panel title="Backtest result">
        {r.strategy && (
          <div className="mb-2 grid gap-1">
            <p className="m-0 text-[14px]">By <b>{r.strategy.name}</b>&apos;s own rules: its methods and time frames, its hours and no-entry window, its SL / TGT distances, its strike rule at each hour, its lots, its TGT and its &ldquo;at most open&rdquo;.</p>
            {r.strategy.caveats.map((c) => <p key={c} className="m-0 text-[12.5px] text-[var(--warn)]">{c}</p>)}
          </div>
        )}
        <p className="m-0 text-[13px] text-muted-foreground">
          {dayLabel(r.from)} → {dayLabel(r.to)} · {rule} · {params.lots} lot{params.lots === 1 ? '' : 's'} a signal · option target {CUSTOM.target.label(params.targetPct)}, stop {CUSTOM.stop.label(params.stopPct)}{params.deskMax > 0 ? ` · at most ${params.deskMax} open, CE ${params.cePct}% · PE ${params.pePct}%` : ''}{(() => {
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
              <Stats cols={3}>
                <Stat label="Before charges" tone={t.net + t.charges > 0 ? 'up' : t.net + t.charges < 0 ? 'down' : undefined}>{moneyText(t.net + t.charges)}</Stat>
                <Stat label="Charges" tone="down">{moneyText(-t.charges)}</Stat>
                <Stat label="After charges" tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{moneyText(t.net)}</Stat>
              </Stats>
            </div>
            <p className="m-0 mt-1 px-1 text-[12px] text-muted-foreground">
              Charges: Delta&apos;s fee on each fill (the lower of 0.01% of the BTC value and 3.5% of the premium) and 18% GST on it, on the sale and on the buy-back -- {t.n > 0 ? moneyText(-t.charges / t.n) : '—'} a trade, {t.net + t.charges !== 0 ? `${Math.round((100 * t.charges) / Math.abs(t.net + t.charges))}% of the result before them` : ''}.
            </p>
            {/* Margin (owner, 13 Oct 2026): what the trades would have tied up, and what the result is on it. An older server sends none. */}
            {r.margin && r.margin.peakUsd > 0 && (
              <>
                <div className="mt-2">
                  <Stats cols={3}>
                    <Stat label="Margin at most">{moneyText(r.margin.peakUsd).replace('+', '')}</Stat>
                    <Stat label="On that margin" tone={t.net > 0 ? 'up' : t.net < 0 ? 'down' : undefined}>{`${t.net >= 0 ? '+' : '−'}${Math.abs((100 * t.net) / r.margin.peakUsd).toFixed(1)}%`}</Stat>
                    <Stat label="A day's most, average">{moneyText(r.margin.avgDailyPeakUsd).replace('+', '')}</Stat>
                  </Stats>
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
            r.skipped['at-limit'] ? `${count(r.skipped['at-limit'])} while it already had its most open` : null,
            r.skipped['desk-limit'] ? `${count(r.skipped['desk-limit'])} while ${params.deskMax} were open (at most open)` : null,
            r.skipped['side-limit'] ? `${count(r.skipped['side-limit'])} while that side was at its CE / PE max` : null,
            r.skipped['no-strike'] ? `${count(r.skipped['no-strike'])} with no strike inside the rule worth $10` : null,
            r.skipped['no-board'] ? `${count(r.skipped['no-board'])} with no option prices recorded then` : null,
            r.skipped['no-exit-price'] ? `${count(r.skipped['no-exit-price'])} with no price to exit at` : null,
          ].filter(Boolean).join(', ')}.</>}
          {/* With a limit on open trades the filters choose the signals before the day is played, so the counts are already theirs. */}
          {(tfs.length > 0 || methods.length > 0) && params.deskMax === 0 && ' The counts in this line are before the time frame and method filters.'}
        </p>
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
              <table className="w-full border-collapse text-[13px] tabular-nums">
                <caption className="sr-only">Backtest: which exit closed the trades</caption>
                <thead>
                  <tr className="text-left text-[11.5px] text-muted-foreground">
                    <th scope="col" className="py-1 pr-2 font-medium">Closed by</th>
                    <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
                    <th scope="col" className="py-1 pr-2 text-right font-medium">In profit</th>
                    <th scope="col" className="py-1 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {EXITS.flatMap((e) => {
                    const x = t.exits[e.key];
                    return x && x.n > 0 ? [(
                      <tr key={e.key} className="border-t border-[var(--line-soft)] align-top">
                        <th scope="row" className="py-1.5 pr-2 text-left font-medium">{e.label}</th>
                        <td className="py-1.5 pr-2 text-right">{count(x.n)}</td>
                        <td className="py-1.5 pr-2 text-right">{pct(x.wins / x.n, 0)}</td>
                        <td className="py-1.5 text-right">
                          <span className={cn('block whitespace-nowrap font-semibold', netClass(x.net))}>{moneyText(x.net)}</span>
                          <span className={cn('block whitespace-nowrap text-[11.5px]', netClass(x.net))}>{moneyText(x.net / x.n)}</span>
                        </td>
                      </tr>
                    )] : [];
                  })}
                </tbody>
              </table>
            </Panel>
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
              <Table caption="Backtest by expiry day" first="Expiry day" rows={[...r.days].reverse().map((d) => ({ ...d, key: d.day, name: `${dayLabel(d.day)}${d.live ? ' · so far' : ''}` }))} />
            </Panel>
          </div>
        </>
      )}

      <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
        How it is worked out: at each signal&apos;s fill on the perp, the put (a BUY) or the call (a SELL) of that expiry day&apos;s contract is sold at its bid, at the
        strike the rule picks; it is bought back at the offer when the perp reaches the signal&apos;s stop or TGT1, or sooner if the option reaches its own
        target or stop, or at the end of the window; charges are taken on both fills. The perp is read a minute at a time; the options every five
        minutes, which is how often the desk records the whole board, so an exit is priced up to five minutes late.
        {r.strategy || params.deskMax > 0 ? ' The limits on open trades are counted as set above; margin and the order queue are not' : ' No limit on open trades unless one is set above, no margin and no queue'}
        {' '}— so the total is not what an account would have made: read what a trade of each kind made.
      </p>
      </Updating>
    </div>
  );
}
