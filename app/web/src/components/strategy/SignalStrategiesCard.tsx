import { accountScope, canMakeForAccount } from '@/lib/account-scope';
import { useEffect, useRef, useState } from 'react';
import { FoldButton, useFold } from '@/components/ui/fold';
import { AlertTriangle, Bot, CheckCircle2, Copy, CopyPlus, FolderInput, FolderPlus, Loader2, Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import { cloneStrategy, createGroup, deleteStrategies, deleteStrategy, getStrategies, moveToGroup, orderGroups, saveStrategy, setScheduler, setSideMax, setSignalMaxOpen, setStrikeFull, setStrikeMax, setStrategyEnabled, takeIntoGroup } from '@/api/strategy';
import { MAX_GLOBAL_OPEN, MAX_SIGNAL_OPEN, ruleTfWords, type Strategy, type StrategyGroup, type StrategyStatus, type VolLevelNow } from '@/types/strategy';
import { usePoll } from '@/hooks/usePoll';
import { Button } from '@/components/ui/button';
import { SignalStrategyForm } from '@/components/strategy/SignalStrategyForm';
import { copySources } from '@/components/strategy/SignalRuleEditor';
import { SignalTradeHistory } from '@/components/strategy/SignalTradeHistory';
import { StrategyGroupSection } from '@/components/strategy/StrategyGroupSection';
import { CopyStrategiesSheet } from '@/components/strategy/CopyStrategiesSheet';
import { SideMax } from '@/components/strategy/SideMax';
import { StrikeMax } from '@/components/strategy/StrikeMax';
import { refreshGroupIndex } from '@/hooks/useGroupOf';
import { defaultGroupFor, groupNameProblem, groupSections, moved, moveTargets } from '@/lib/strategy-groups';
import { describeStrike, signalTargetLabel } from '@/lib/strategy-preview';
import { time12 } from '@/lib/time';
import { noEntryWords } from '@/lib/strategy-no-entry';
import { slFilters, tgtFilters } from '@/types/strategy';
import { blockNow, hoursLabel, istMinuteOf, pickWords } from '@/lib/strategy-blocks';
import { globalMaxOpenProblem, marginPerLotUsd, roomLeft, signalTotals, usageNow, usageOf, type Usage } from '@/lib/strategy-totals';
import { inr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The signal strategies, on the Live screen beside the methods that make the
 * signals: each one's switch, its live-orders switch, what it is set to, and
 * what the last signals did. New and Edit open the same form as the Strategy
 * tab, already on signals -- one strategy, two places to reach it.
 */


/**
 * The strike rule in force this minute (4 Oct 2026). A strategy split by time
 * of day sells under a different rule in each block, and the line above names
 * only the first; this says which block the clock is in, until when, the rule a
 * signal arriving now is sold under, and what follows it. The card is read
 * again every few seconds, so it moves with the clock.
 */
/**
 * What a strategy sets by volatility (17 Oct 2026): its delta and its SL by level, as tags. Said whatever the clock --
 * a setting is the strategy's in its window and out of it (17 Oct: outside its window the tags were not shown).
 */
function ByVolTags({ s }: { s: Strategy }) {
  const dv = s.config.signal?.deltaByVol, sv = s.config.signal?.slByVol;
  const tag = 'rounded border border-solid border-[var(--accent)]/50 px-1.5 py-px text-[10.5px] text-foreground';
  const by = (b: 'atr' | 'iv') => (b === 'iv' ? 'ATM IV' : 'ATR 2h');
  return (
    <>
      {/* The delta above is the one it keeps when the level cannot be read. */}
      {dv?.on && s.config.strikeRule === 'delta' && (
        <span aria-label={`delta by volatility of ${s.name}`} className={tag}>
          Δ by {by(dv.by)}: low {dv.low.toFixed(2)} · normal {dv.medium.toFixed(2)} · high {dv.high.toFixed(2)}
        </span>
      )}
      {/* And its own SL is the one kept when the level cannot be read. */}
      {sv?.on && (s.config.stopMode ?? 'pct') === 'pct' && (
        <span aria-label={`SL by volatility of ${s.name}`} className={tag}>
          SL by {by(sv.by)}: low +{Math.round(sv.low * 100)}% · normal +{Math.round(sv.medium * 100)}% · high +{Math.round(sv.high * 100)}%
        </span>
      )}
    </>
  );
}

/** The option's own exits in a few words: "TGT 70% → 97% by time (9 steps) · SL +160%". */
export function exitsShort(s: Strategy): string {
  const c = s.config;
  const tgt = (c.targetMode ?? 'pct') === 'pct'
    ? (c.takeProfitPct > 0 ? `TGT ${Math.round(c.takeProfitPct * 100)}%` : 'no option TGT')
    : c.targetMode === 'points' ? `TGT ${c.takeProfitPoints} pts` : `TGT at ${c.takeProfitAt}`;
  const steps = c.targetSteps ?? [];
  const tgtSteps = steps.length ? ` → ${Math.round(steps[steps.length - 1]!.value * 100)}% by time (${steps.length} step${steps.length === 1 ? '' : 's'})` : '';
  const sv = c.signal?.slByVol;
  const sl = (c.stopMode ?? 'pct') === 'pct'
    ? (sv?.on ? 'SL by volatility' : c.stopLossPct > 0 ? `SL +${Math.round(c.stopLossPct * 100)}%` : 'no option SL')
    : c.stopMode === 'points' ? `SL ${c.stopLossPoints} pts` : `SL at ${c.stopLossAt}`;
  const slSteps = (c.stopSteps ?? []).length ? ` (${c.stopSteps!.length} time step${c.stopSteps!.length === 1 ? '' : 's'})` : '';
  // The perp's levels it skips: said, since its option's own then close it (18 Oct 2026).
  const skip = [c.signal?.skipPerpSl ? 'perp SL skipped' : null, c.signal?.skipPerpTgt ? 'perp TGT skipped' : null].filter(Boolean).join(' · ');
  return `${tgt}${tgtSteps} · ${sl}${slSteps}${skip ? ` · ${skip}` : ''}`;
}

const LEVEL_WORD: Record<'low' | 'medium' | 'high', string> = { low: 'Low', medium: 'Normal', high: 'High' };
/** "Fri 9:00 PM" (IST), in the desk's own way of writing a time. */
const dayOrClock = (ms: number) => {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  const hhmm = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${time12(hhmm)}`;
};
/** "5 Oct – 18 Oct": a day range, short. */
const daysShort = (from: string, to: string) => {
  const d = (x: string) => new Date(`${x}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return from === to ? d(from) : `${d(from)} – ${d(to)}`;
};
/** When the daily update runs next, epoch ms: today at its time if that is still to come and it has not run since, else tomorrow. */
export function nextAutoRun(at: string, lastAt: number | null | undefined, now = Date.now()): number {
  const day = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
  const today = Date.parse(`${day}T${at}:00+05:30`);
  return now < today && !((lastAt ?? 0) >= today) ? today : today + 86_400_000;
}
/** What the last daily update did: how many came in and went, or that the list was kept. */
export function lastUpdateWords(last: { picked: string[]; before: string[]; note?: string | null }): string {
  if (last.note) return 'no method passed: the list was kept';
  const came = last.picked.filter((m) => !last.before.includes(m)).length, went = last.before.filter((m) => !last.picked.includes(m)).length;
  return came || went ? `${came} in · ${went} out` : 'no change';
}

/** How a signal strategy enters, and the filters a signal must pass, in a line (19 Oct 2026, the card). */
export function entryWords(s: Strategy): string {
  const c = s.config, r = c.signal;
  if (!r) return '';
  const when = (r.enterOn ?? 'zone') === 'zone' ? 'in the trade (the perp at the zone)' : 'at the signal';
  const price = c.entryPrice === 'now' ? 'at the market' : c.entryPrice === 'set' ? 'at a set price' : `at the offer${c.crossAfterSec > 0 ? `, to the bid over ${c.crossAfterSec}s` : ''}`;
  const pts = (fs: ReturnType<typeof slFilters>, name: string) => fs.map((f) => `${name} ${f.pts > 0 && f.max > 0 ? `${f.pts}–${f.max}` : f.pts > 0 ? `≥ ${f.pts}` : `≤ ${f.max}`}${fs.length > 1 ? ` (${f.tf})` : ''}`);
  const filters = [
    ...pts(slFilters(r), 'SL'), ...pts(tgtFilters(r), 'TGT'),
    ...(c.noEntry?.on && c.noEntry.windows.length ? [`no entry ${c.noEntry.windows.map(noEntryWords).join(', ')}`] : []),
    ...((c.minPremiumUsd ?? 0) > 0 ? [`premium ≥ $${c.minPremiumUsd}`] : []),
  ];
  return `${when} · ${price}${filters.length ? ` · ${filters.join(' · ')}` : ''}`;
}
const STATUS_WORD: Record<string, string> = { placed: 'placed', 'would-place': 'written down', skipped: 'skipped', refused: 'refused', failed: 'failed' };

/**
 * What a trader reads a strategy by, at a glance (owner, 17 Oct 2026: "the card -- missing useful, user-friendly
 * details"): its option exits, how its methods are kept, how volatile it is now and what the next signal would use,
 * and its day so far. Each a line with its own label, so a phone reads them as a list.
 */
function StrategyFacts({ s, volNow }: { s: Strategy; volNow?: { iv: VolLevelNow; atr: VolLevelNow } }) {
  const c = s.config, r = c.signal;
  const auto = r?.autoMethods;
  const dv = r?.deltaByVol?.on && c.strikeRule === 'delta' ? r.deltaByVol : null;
  const sv = r?.slByVol?.on && (c.stopMode ?? 'pct') === 'pct' ? r.slByVol : null;
  const by = dv?.by ?? sv?.by ?? null;
  const level = by && volNow ? volNow[by] : null;
  const next = by ? [
    dv ? `Δ ≤ ${(level ? dv[level] : c.delta?.max ?? 0).toFixed(2)}` : null,
    sv ? `SL +${Math.round((level ? sv[level] : c.stopLossPct) * 100)}%` : null,
  ].filter(Boolean).join(', ') : null;
  const d = s.today;
  const row = 'grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 max-sm:grid-cols-[5.25rem_minmax(0,1fr)]';
  const label = 'text-[var(--dim)]';
  return (
    <dl aria-label={`details of ${s.name}`} className="m-0 mt-1.5 grid gap-0.5 text-[11.5px] leading-snug text-muted-foreground">
      <div className={row}><dt className={label}>Option exits</dt><dd className="m-0 text-foreground">{exitsShort(s)}</dd></div>
      <div className={row}>
        <dt className={label}>Methods</dt>
        <dd className="m-0">
          {auto?.on
            ? <>{r?.methods.length ?? 0} in use{auto.last
              ? <> · last update {dayOrClock(auto.last.at)} on {daysShort(auto.last.from, auto.last.to)}: <span className="text-foreground">{lastUpdateWords(auto.last)}</span></>
              : ' · not updated yet'}</>
            : <>{r?.methods.length ?? 0} chosen by hand</>}
        </dd>
      </div>
      {/* The daily update's rule, when it runs next, and a rule that lets luck in said so (19 Oct 2026: every strategy on 1+ trades). */}
      {auto?.on && (
        <div className={row}>
          <dt className={label}>Auto-update</dt>
          <dd className="m-0" aria-label={`auto-update of ${s.name}`}>
            win ≥ {auto.winPct}% of {auto.minTrades}+ trade{auto.minTrades === 1 ? '' : 's'} in {auto.days} days
            {auto.exclude?.on && auto.exclude.methods.length ? ` · ${auto.exclude.methods.length} excluded` : ''}
            {' '}· next {dayOrClock(nextAutoRun(auto.at, auto.last?.at))}
            {auto.minTrades < 3 && <span className="text-[var(--warn)]"> · {auto.minTrades} trade{auto.minTrades === 1 ? '' : 's'} can be luck: 5 is safer</span>}
          </dd>
        </div>
      )}
      {by && (
        <div className={row}>
          <dt className={label}>Volatility now</dt>
          <dd className="m-0">
            {volNow === undefined ? 'not read on this server'
              : level ? <><b className={cn('font-semibold', level === 'high' ? 'text-[var(--down)]' : level === 'low' ? 'text-[var(--up)]' : 'text-foreground')}>{LEVEL_WORD[level]}</b> by {by === 'iv' ? 'ATM IV' : 'ATR 2h'} → a signal now: <span className="text-foreground">{next}</span></>
                : <>not readable by {by === 'iv' ? 'ATM IV' : 'ATR 2h'} → its own: <span className="text-foreground">{next}</span></>}
          </dd>
        </div>
      )}
      {r && <div className={row}><dt className={label}>Entry</dt><dd className="m-0">{entryWords(s)}</dd></div>}
      <div className={row}>
        <dt className={label}>Today</dt>
        <dd className="m-0">
          {!d ? 'no signal yet since 5:30 PM'
            : <>
              {[d.placed ? `${d.placed} placed` : null, d.wouldPlace ? `${d.wouldPlace} written down` : null, d.skipped ? `${d.skipped} skipped` : null,
                d.refused ? `${d.refused} refused` : null, d.failed ? `${d.failed} failed` : null].filter(Boolean).join(' · ') || 'no decision yet'}
              {d.lastAt > 0 && <span className={label}> · last {dayOrClock(d.lastAt)}{d.lastStatus ? `, ${STATUS_WORD[d.lastStatus] ?? d.lastStatus}` : ''}</span>}
            </>}
        </dd>
      </div>
      {/* Why the last not taken was not (19 Oct 2026): a skip is a rule doing its job; a refusal or failure is worth a look. */}
      {s.whyNot && (s.whyNot.skipped || s.whyNot.refused || s.whyNot.failed) && (
        <div className={row}>
          <dt className={label}>Not taken</dt>
          <dd className="m-0 grid gap-0.5" aria-label={`not taken by ${s.name}`}>
            {(['refused', 'failed', 'skipped'] as const).map((k) => {
              const x = s.whyNot![k];
              return x ? (
                <span key={k} className={cn('[overflow-wrap:anywhere]', k === 'skipped' ? '' : 'text-[var(--warn)]')}>
                  last {k} {dayOrClock(x.at)}: {x.why}
                </span>
              ) : null;
            })}
          </dd>
        </div>
      )}
    </dl>
  );
}

function RuleNow({ s }: { s: Strategy }) {
  const b = blockNow(s.config, istMinuteOf(Date.now()));
  if (!b) {
    return (
      <p aria-label={`strike rule now of ${s.name}`} className="m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--dim)]">
        <span>Outside its window now — the next signal is taken from {time12(s.config.entryTime)}.</span>
        <ByVolTags s={s} />
      </p>
    );
  }
  return (
    <p aria-label={`strike rule now of ${s.name}`} className="m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
      <span className="rounded bg-[var(--accent-fill)]/15 px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-foreground">Now</span>
      {b.of > 1
        ? <span><b className="text-foreground">Block {b.n} of {b.of}</b> · {time12(b.from)} → {time12(b.until)} · {hoursLabel(b.minutesLeft)} left</span>
        : <span><b className="text-foreground">Same rule all the time</b></span>}
      <span>sells <b className="text-foreground">{pickWords(b.pick)}</b></span>
      <ByVolTags s={s} />
      {b.next && <span className="text-[var(--dim)]">· then block {b.next.n} at {time12(b.next.at)}: {pickWords(b.next.pick)}</span>}
    </p>
  );
}

type Tone = 'accent' | 'good' | 'warning' | 'danger';
type Status = { tone: Exclude<Tone, 'accent'>; word: string };
/** Each tone's fill, and its track: a faint step of the same colour, so the state reads across the whole bar. */
const TONE: Record<Tone, { fill: string; track: string }> = {
  accent: { fill: 'var(--accent)', track: 'color-mix(in srgb, var(--accent) 18%, transparent)' },
  good: { fill: 'var(--up)', track: 'color-mix(in srgb, var(--up) 18%, transparent)' },
  warning: { fill: 'var(--warn)', track: 'color-mix(in srgb, var(--warn) 20%, transparent)' },
  danger: { fill: 'var(--down)', track: 'color-mix(in srgb, var(--down) 20%, transparent)' },
};
const STATUS_ICON = { good: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

/**
 * One figure of the summary: what it is, the number, and what stands behind it
 * -- with a bar where the number is a share of something, and a word and an
 * icon where it has a state. The number is in the text's own colour; the bar
 * and the icon carry the state, so nothing is said by colour alone.
 */
function Tile({ label, name, value, status, meter, children }: {
  label: string;
  /** The tile's accessible name. */
  name: string;
  value: React.ReactNode;
  status?: Status | null;
  meter?: { label: string; now: number; max: number; tone: Tone };
  children?: React.ReactNode;
}) {
  const Icon = status ? STATUS_ICON[status.tone] : null;
  const share = meter && meter.max > 0 ? Math.min(1, Math.max(0, meter.now / meter.max)) : 0;
  return (
    <div aria-label={name} className="min-w-0 rounded-lg border border-solid border-border bg-muted px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">{label}</span>
        {status && Icon && (
          <span className="inline-flex flex-none items-center gap-1 text-[11px] font-medium text-foreground">
            <Icon className="h-3.5 w-3.5" style={{ color: TONE[status.tone].fill }} aria-hidden />
            {status.word}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[15px] font-semibold leading-snug tabular-nums text-foreground">{value}</div>
      {meter && (
        <div role="progressbar" aria-label={meter.label} aria-valuemin={0} aria-valuemax={meter.max} aria-valuenow={meter.now}
             className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: TONE[meter.tone].track }}>
          <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: TONE[meter.tone].fill }} />
        </div>
      )}
      {children && <div className="mt-1.5 flex flex-col gap-0.5 text-[11.5px] leading-snug text-muted-foreground">{children}</div>}
    </div>
  );
}

/**
 * One strategy's own limit and how much of it is in use now (4 Oct 2026): its
 * entries, its lots and the margin behind them, each "in use of limit", with a
 * bar for the entries. The limit is what the strategy may take; in use is what
 * the desk holds for it this moment -- positions and working orders.
 */
function UsageLine({ name, u }: { name: string; u: Usage }) {
  const share = u.maxEntries > 0 ? Math.min(1, u.entries / u.maxEntries) : 0;
  const full = u.maxEntries > 0 && u.entries >= u.maxEntries;
  return (
    <div aria-label={`usage of ${name}`} className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[var(--dim)]">Open now</span>
        <b className={cn('tabular-nums', full ? 'text-[var(--warn)]' : 'text-foreground')}>{u.entries} of {u.maxEntries}</b>
        <span role="progressbar" aria-label={`${name} entries in use`} aria-valuemin={0} aria-valuemax={u.maxEntries} aria-valuenow={u.entries}
              className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <span className={cn('block h-full rounded-full', full ? 'bg-[var(--warn)]' : 'bg-[var(--up)]')} style={{ width: `${share * 100}%` }} />
        </span>
      </span>
      <span><span className="text-[var(--dim)]">Lots in use</span> <b className="tabular-nums text-foreground">{u.lots} of {u.maxLots}</b></span>
      <span><span className="text-[var(--dim)]">Margin in use</span> <b className="tabular-nums text-foreground">{inr(usdToInr(u.marginUsd))} of {inr(usdToInr(u.maxMarginUsd))}</b></span>
      {full && <span className="text-[var(--warn)]">at its limit: the next signal is skipped</span>}
    </div>
  );
}

/**
 * The desk-wide "at most open at once" (4 Oct 2026).
 *
 * Each strategy has its own limit, and five strategies each allowed ten is
 * fifty positions on an account whose margin carries a handful: the order that
 * does not fit is refused by Delta, and that is a penalty. So one number over
 * all of them, counted against every open position and working order the desk
 * holds; a signal past it is skipped and the history says so. 0 is no limit.
 *
 * Typed, and saved when the field is left or Enter is pressed -- it sits in a
 * header, where a Save button of its own would be one more thing to miss.
 */
function GlobalMaxOpen({ value, allowed, openNow, busy, onSave, onInvalid }: {
  value: number;
  /** What the strategies switched on allow between them: the sum of their own limits. */
  allowed: number;
  openNow: number; busy: boolean; onSave: (n: number) => Promise<boolean>; onInvalid: (message: string) => void;
}) {
  /*
   * With no limit set, the field shows what the strategies allow between them:
   * that is the limit in force, and the number a lower one is typed against.
   * Typing that sum back is "no extra limit" again (saved as 0), so it goes on
   * following the strategies as they change.
   */
  const shown = value > 0 ? value : allowed;
  const full = value > 0 && openNow >= value;
  return (
    <label
      className="desk-badge-pill inline-flex items-center gap-1.5"
      title="One limit over every strategy: a signal is not taken while the desk already holds this many open trades -- positions and working orders, whichever strategy opened them. Each strategy's own limit still applies. It starts at what the strategies allow between them, and cannot be set above that."
      style={full
        ? { background: 'color-mix(in_srgb,_var(--accent)_10%,_transparent)', color: 'var(--accent)', border: '1px solid color-mix(in_srgb,_var(--accent)_30%,_transparent)' }
        : { background: 'color-mix(in_srgb,_var(--text)_5%,_transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
    >
      <span>At most open</span>
      <NumberCommit
        label="At most open at once, all strategies"
        value={shown}
        busy={busy}
        problem={(n) => globalMaxOpenProblem(n, allowed, MAX_GLOBAL_OPEN)}
        onInvalid={onInvalid}
        onSave={(n) => { const next = allowed > 0 && n === allowed ? 0 : n; return next !== value ? onSave(next) : Promise.resolve(true); }}
        className="h-6 w-11"
      />
      <span aria-label="open now, of the limit">
        {value > 0 ? `${openNow} of ${value} open` : allowed > 0 ? `all the strategies allow · ${openNow} open` : `no limit · ${openNow} open`}
      </span>
    </label>
  );
}

/**
 * A whole number typed in place and saved when the field is left or Enter is
 * pressed -- for the numbers that sit on a card, where opening a form to change
 * one is a detour and a Save button of its own would be one more thing to miss.
 *
 * Digits only. A number the rule refuses is said (`onInvalid`, in the rule's own
 * words) and put back, never sent; an unchanged one is not sent either; one the
 * server refuses goes back to what is saved, so the field never shows a number
 * the desk is not using. It follows the server's number, but not while it is
 * being typed into.
 */
function NumberCommit({ label, value, busy, problem, onSave, onInvalid, className }: {
  /** Read by screen readers, and what a test finds it by. */
  label: string;
  value: number;
  busy?: boolean;
  /** Why this number cannot be saved, or null. */
  problem: (n: number) => string | null;
  /** Saves it; answers whether it was taken. */
  onSave: (n: number) => Promise<boolean>;
  onInvalid: (message: string) => void;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  const typing = useRef(false);
  useEffect(() => { if (!typing.current) setText(String(value)); }, [value]);
  const commit = () => {
    typing.current = false;
    const n = text.trim() === '' ? NaN : Number(text);
    const bad = problem(n);
    if (bad) { onInvalid(bad); setText(String(value)); return; }
    if (n !== value) void onSave(n).then((taken) => { if (!taken) setText(String(value)); });
  };
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={text}
      disabled={busy}
      onFocus={() => { typing.current = true; }}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cn('m-0 rounded border border-solid border-border bg-[var(--bg)] px-1 text-center font-[inherit] text-[12px] tabular-nums text-foreground disabled:opacity-50', className)}
    />
  );
}

/** One line: the methods and way, the leg rule, the strike, lots, exits. */
export function signalLine(s: Strategy): string {
  const c = s.config;
  const r = c.signal;
  if (!r) return '';
  return [
    `${r.methods.length} method${r.methods.length === 1 ? '' : 's'} ${ruleTfWords(r)}`,
    // Sold, always: a BUY signal sells the put, a SELL the call.
    'BUY → PE · SELL → CE',
    describeStrike(c).split(' — ')[0]!,
    `${c.lots} lot${c.lots === 1 ? '' : 's'}`,
    `perp SL / ${signalTargetLabel(r.target)}`,
    `max ${r.maxOpen} open`,
    `${time12(c.entryTime)} → ${time12(c.exitTime)}`,
  ].join(' · ');
}

export function SignalStrategiesCard() {
  const { data, refresh } = usePoll<StrategyStatus>(getStrategies, 5_000);
  const [open, setOpen] = useFold('signal-strategies');
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Real orders need a second tap: a switch that sends money to the exchange should not flip on a brush.
  const [confirmLive, setConfirmLive] = useState<string | null>(null);
  // Deleting needs a second tap too: it cannot be undone.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // The group a new strategy is made in; null: none.
  const [formGroup, setFormGroup] = useState<StrategyGroup | null>(null);
  // The name of a group being made, while its field is open.
  const [newGroup, setNewGroup] = useState<string | null>(null);
  // The copy sheet: into a group (or chosen there), with these strategies ticked; null: closed.
  const [copying, setCopying] = useState<{ into: StrategyGroup | null; pick: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Removing every strategy that is in no group needs a second tap: it cannot be undone.
  const [confirmLoose, setConfirmLoose] = useState(false);

  /** Do it, read the list again, and say whether it was taken: a field that was refused goes back to what is saved. */
  const act = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setFailed(null);
    try {
      await fn();
      refresh();
      // Groups made, renamed, moved between: the tags beside strategy names elsewhere follow at once.
      refreshGroupIndex();
      return true;
    } catch (e) {
      setFailed((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const setLive = (s: Strategy, on: boolean) => {
    if (on && confirmLive !== s.id) {
      setConfirmLive(s.id);
      setTimeout(() => setConfirmLive((cur) => (cur === s.id ? null : cur)), 4_000);
      return;
    }
    setConfirmLive(null);
    void act(`live-${s.id}`, () => saveStrategy({ id: s.id, name: s.name, config: { ...s.config, liveOrders: on } }));
  };

  const mine = data?.strategies.filter((s) => s.config.trigger === 'signal') ?? [];
  /*
   * Listed by group (owner, 10 Oct 2026): each group with its strategies under it, then those in none. A server
   * from before groups sends none, and the list is the one list it always was.
   */
  const groups = data?.groups ?? [];
  const sections = groupSections(mine, groups);
  /** Up (-1) or down (+1) among its account's groups, in the order shown, saved at once. */
  const moveGroup = (g: StrategyGroup, by: -1 | 1) => {
    const ids = sections.filter((x) => x.group && (x.group.accountId ?? null) === (g.accountId ?? null)).map((x) => x.group!.id);
    const i = ids.indexOf(g.id);
    if (i < 0 || i + by < 0 || i + by >= ids.length) return undefined;
    return () => void act(`group-move-${g.id}`, () => orderGroups(g.accountId ?? null, moved(ids, i, by)));
  };
  const makeGroup = () => {
    if (newGroup === null) return;
    const bad = groupNameProblem(newGroup);
    if (bad) { setFailed(bad); return; }
    void act('new-group', () => createGroup(newGroup.trim(), accountScope())).then((ok) => { if (ok) setNewGroup(null); });
  };
  // The switched-on strategies added up, and the worst case under the desk-wide limit.
  const totals = signalTotals(mine, data?.balanceUsd ?? null, data?.spot ?? null);
  // "At most open" is over every strategy of the account: what they allow between them is the sum of all.
  const allowedAll = signalTotals(mine, null, null).entries;
  const cap = data?.signalMaxOpen ?? 0;
  const inUse = usageNow(mine, data?.spot ?? null);
  // What can still open from here, at worst, and whether the free margin carries it.
  /*
   * Held to everything that can stop an entry: each strategy's own limit, the
   * desk-wide limit on open trades, and the desk's limit on lots short -- the
   * order gate's, which refused an entry on 4 Oct 2026 that this line had
   * called room. And priced at the dearer of the 200x model and what Delta is
   * charging per lot now.
   */
  const shortCap = data?.shortCap ?? null;
  const shortNow = data?.shortNow ?? 0;
  const lotsLeft = shortCap === null ? null : Math.max(0, shortCap - shortNow);
  const perLotUsd = marginPerLotUsd(data?.spot ?? null, data?.marginUsedUsd, shortNow);
  const room = roomLeft(mine, cap, data?.openNow ?? 0, data?.spot ?? null, { lotsLeft, perLotUsd });
  const deltaMarginUsd = data?.marginUsedUsd ?? null;
  /*
   * "In use" is measured against what can actually be open: the desk-wide limit
   * where it is the tighter one, the strategies' own sum where it is not. Under a
   * limit of 28, "6 of 55" reads as nearly empty on a desk that is 6 of 28 full
   * -- so the entries are the desk's open trades of the limit, as the pill above
   * says them, and the lots and margin are what is held of what is held plus
   * what can still open.
   */
  const limited = cap > 0 && cap < allowedAll;
  const usedEntries = limited ? (data?.openNow ?? 0) : inUse.entries;
  const mostEntries = limited ? cap : totals.entries;
  const freeUsd = data?.balanceUsd ?? null;
  const short = freeUsd !== null && room.marginUsd > freeUsd;
  // How what is still to open sits against what is free: said in a word and an icon, never by colour alone.
  const fit: Status = short ? { tone: 'danger', word: 'More than is free' }
    : freeUsd !== null && freeUsd > 0 && room.marginUsd > freeUsd * 0.8 ? { tone: 'warning', word: 'Tight' }
      : { tone: 'good', word: 'Fits in the free margin' };

  /** One strategy's card, as it always was; listed under its group. */
  const card = (s: Strategy) => {
    const live = Boolean(s.config.liveOrders);
    return (
      <div key={s.id} className={cn('rounded-lg border border-solid px-2.5 py-2', s.enabled ? 'border-[var(--up)]' : 'border-[var(--line)]')}>
        {/*
          On a phone: the name with Edit, Copy and Delete as icons on one row, and the two switches that matter
          -- on/off and live orders -- side by side under it, each half the width. One row on a wider screen.
        */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 sm:flex sm:flex-wrap sm:justify-between">
          <div className="order-1 flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold text-foreground">{s.name}</span>
            <span className={cn('text-[11px]', s.enabled ? 'text-[var(--up)]' : 'text-[var(--dim)]')}>{s.enabled ? 'on' : 'off'}</span>
          </div>
          <div className="order-3 col-span-2 grid grid-cols-2 gap-1.5 sm:order-2 sm:ml-auto sm:flex">
            <Button size="sm" className="h-9 sm:h-8" variant={s.enabled ? 'outline' : 'default'} disabled={busy === s.id}
                    onClick={() => void act(s.id, () => setStrategyEnabled(s.id, !s.enabled))}>
              {busy === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
              {s.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={cn('h-9 sm:h-8', (live || confirmLive === s.id) && 'border-[var(--down)] text-[var(--down)]')}
              role="switch"
              aria-checked={live}
              aria-label={`Live orders for ${s.name}`}
              disabled={busy === `live-${s.id}`}
              onClick={() => setLive(s, !live)}
            >
              {busy === `live-${s.id}` && <Loader2 className="h-3 w-3 animate-spin" />}
              {confirmLive === s.id ? 'Tap again: real orders' : live ? 'Live orders ON' : 'Live orders off'}
            </Button>
          </div>
          <div className="order-2 flex flex-none items-center gap-0.5 sm:order-3 sm:gap-1.5">
            <Button size="sm" variant="ghost" className="h-8 px-2 sm:px-2.5" onClick={() => { setEditing(s); setFormOpen(true); }}>
              <Pencil className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> <span className="sr-only sm:not-sr-only">Edit</span>
            </Button>
            {/*
              Copy, then the copy opens to be renamed and changed: how a second strategy is actually made.
              The server saves it switched off with live orders off -- a draft, not a second set of orders.
            */}
            <Button
              size="sm" variant="ghost" className="h-8 px-2 sm:px-2.5"
              aria-label={`Copy ${s.name}`}
              title="A copy, switched off with live orders off, opened to rename and change"
              disabled={busy === `copy-${s.id}`}
              onClick={() => void act(`copy-${s.id}`, async () => {
                const { strategy } = await cloneStrategy(s.id);
                setEditing(strategy);
                setFormOpen(true);
              })}
            >
              {busy === `copy-${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3.5 w-3.5 sm:h-3 sm:w-3" />}
              <span className="sr-only sm:not-sr-only">Copy</span>
            </Button>
            {/* A copy into another group -- of this account or another -- picked on the copy sheet. */}
            {groups.length > 0 && (
              <Button size="sm" variant="ghost" className="h-8 px-2 sm:px-2.5" aria-label={`Copy ${s.name} to a group`}
                      title="Copy to another group or account, switched off" onClick={() => setCopying({ into: null, pick: [s.id] })}>
                <FolderInput className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> <span className="sr-only sm:not-sr-only">To group</span>
              </Button>
            )}
            {/* Delete, on a second tap within four seconds. Its trades and their history stay. */}
            <Button
              size="sm" variant="ghost" className="h-8 px-2 text-[var(--down)] sm:px-2.5"
              aria-label={`Delete ${s.name}`}
              title="Delete this strategy. Trades it has open keep their exits, and its history stays."
              disabled={busy === `del-${s.id}`}
              onClick={() => {
                if (confirmDelete !== s.id) {
                  setConfirmDelete(s.id);
                  setTimeout(() => setConfirmDelete((cur) => (cur === s.id ? null : cur)), 4_000);
                  return;
                }
                setConfirmDelete(null);
                void act(`del-${s.id}`, () => deleteStrategy(s.id));
              }}
            >
              {busy === `del-${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 sm:h-3 sm:w-3" />}
              {confirmDelete === s.id && 'Tap again to delete'}
            </Button>
          </div>
        </div>
        <p className="m-0 mt-1 text-[11.5px] leading-snug text-muted-foreground">{signalLine(s)}</p>
        <RuleNow s={s} />
        <StrategyFacts s={s} volNow={data?.volNow} />
        {/*
          The two numbers changed most often, on the card itself: the same settings as in the form (Edit),
          saved the same way, so neither needs the form opened. They apply to the next signal; what is
          already open keeps its size.
        */}
        <div role="group" aria-label={`quick settings of ${s.name}`} className="mt-1.5 grid grid-cols-2 items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground sm:flex sm:flex-wrap sm:gap-x-4 sm:gap-y-1.5">
          <label className="inline-flex items-center justify-between gap-1.5 sm:justify-start">
            <span className="whitespace-nowrap">Lots per signal</span>
            <NumberCommit
              label={`Lots per signal for ${s.name}`}
              value={s.config.lots}
              busy={busy === `quick-${s.id}`}
              problem={(n) => (Number.isInteger(n) && n >= 1 ? null : 'Lots must be a whole number, at least 1.')}
              onInvalid={setFailed}
              onSave={(n) => act(`quick-${s.id}`, () => saveStrategy({ id: s.id, name: s.name, config: { ...s.config, lots: n } }))}
              className="h-7 w-12 sm:w-14"
            />
          </label>
          <label className="inline-flex items-center justify-between gap-1.5 sm:justify-start">
            <span className="whitespace-nowrap">At most open</span>
            <NumberCommit
              label={`At most open for ${s.name}`}
              value={s.config.signal?.maxOpen ?? 1}
              busy={busy === `quick-${s.id}`}
              problem={(n) => (Number.isInteger(n) && n >= 1 && n <= MAX_SIGNAL_OPEN ? null : `At most 1 to ${MAX_SIGNAL_OPEN} of its trades open at once.`)}
              onInvalid={setFailed}
              onSave={(n) => act(`quick-${s.id}`, () => saveStrategy({ id: s.id, name: s.name, config: { ...s.config, signal: { ...s.config.signal!, maxOpen: n } } }))}
              className="h-7 w-12 sm:w-14"
            />
          </label>
          <span className="col-span-2 text-[11px] text-[var(--dim)]">saved as you leave the field · from the next signal</span>
        </div>
        {s.open && <UsageLine name={s.name} u={usageOf(s, data?.spot ?? null)} />}
      {/*
        Which group it is listed in: one of its own account's (a group is one account's), or none. Listing only --
        what it trades and when are its own settings, untouched.
      */}
      {groups.length > 0 && (s.groupId || moveTargets(s, groups).length > 0) && (
        <label className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="text-[var(--dim)]">Group</span>
          <select
            aria-label={`Group of ${s.name}`}
            value={s.groupId ?? ''}
            disabled={busy === `move-${s.id}`}
            onChange={(e) => void act(`move-${s.id}`, () => moveToGroup(s.id, e.target.value === '' ? null : e.target.value))}
            className="m-0 h-7 max-w-[14rem] rounded border border-solid border-border bg-[var(--bg)] px-1 font-[inherit] text-[12px] text-foreground disabled:opacity-50"
          >
            {groups.filter((g) => g.id === s.groupId).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            {moveTargets(s, groups).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            <option value="">No group</option>
          </select>
        </label>
      )}
        <p className="m-0 mt-0.5 text-[11.5px] text-[var(--dim)]">
          {s.status}
          {!live && ' · writes down what it would sell, sends nothing'}
        </p>
      </div>
    );
  };

  return (
    <section className="live-signal-strategies fold-host mt-3 rounded-xl border border-solid border-border bg-[var(--panel)] p-3" data-folded={!open} aria-label="Signal strategies">
      <div className="desk-section-header fold-head !mt-0">
        <div className="desk-section-title-wrap">
          <FoldButton open={open} onToggle={() => setOpen(!open)} label="signal strategies" />
          <div className="desk-section-icon" style={{ background: 'color-mix(in_srgb,_var(--accent)_12%,_transparent)', color: 'var(--accent)' }}>
            <Bot size={18} />
          </div>
          <div>
            <h2 className="desk-section-title">Signal Strategies</h2>
            <span className="desk-section-subtitle">The methods&apos; signals sold as options · BUY sells PE, SELL sells CE · SL / TGT on the BTC perp</span>
          </div>
        </div>
        <div className="desk-section-badges">
          {/* The desk's one number over all of them, left of the switch it works beside. */}
          {data && data.signalMaxOpen !== undefined && (
            <GlobalMaxOpen
              value={data.signalMaxOpen}
              allowed={allowedAll}
              openNow={data.openNow ?? 0}
              busy={busy === 'max-open'}
              onSave={(n) => act('max-open', () => setSignalMaxOpen(n))}
              onInvalid={setFailed}
            />
          )}
          {/* Each side's own limit, beside the limit it is a per cent of. Absent on a server from before them. */}
          {data && data.signalMaxOpen !== undefined && data.openBySide && data.signalSideMaxPct && (
            <SideMax
              pct={data.signalSideMaxPct}
              cap={data.signalMaxOpen}
              open={data.openBySide}
              busy={busy === 'side-max'}
              onSave={(side, pct) => act('side-max', () => setSideMax(side, pct))}
              onInvalid={setFailed}
            />
          )}
          {/* The most on one strike (22 Oct 2026), and the strike holding the most now. Absent on a server from before it. */}
          {data && data.signalStrikeMaxPct !== undefined && data.signalMaxOpen !== undefined && (
            <StrikeMax
              pct={data.signalStrikeMaxPct}
              cap={data.signalMaxOpen}
              busiest={data.busiestStrike ?? null}
              full={data.signalStrikeFull}
              busy={busy === 'strike-max'}
              onSave={(n) => act('strike-max', () => setStrikeMax(n))}
              onSaveFull={(mode) => act('strike-max', () => setStrikeFull(mode))}
              onInvalid={setFailed}
            />
          )}
          {data && (
            <span className="desk-badge-pill"
                  style={data.schedulerOn
                    ? { background: 'color-mix(in_srgb,_var(--up)_12%,_transparent)', color: 'var(--up)', border: '1px solid color-mix(in_srgb,_var(--up)_30%,_transparent)' }
                    : { background: 'color-mix(in_srgb,_var(--text)_5%,_transparent)', color: 'var(--muted)', border: '1px solid var(--line)' }}>
              Auto-trading {data.schedulerOn ? 'on' : 'off'}
            </span>
          )}
          {/* The master switch itself, beside what it says: it sat on the time-of-day strategies' panel until that went. */}
          {data && (
            <Button
              size="sm" variant={data.schedulerOn ? 'outline' : 'default'} className="h-8"
              aria-label={data.schedulerOn ? 'Turn auto-trading off' : 'Turn auto-trading on'}
              title={data.schedulerOn ? 'No signal is taken while this is off. Open trades keep their exits.' : 'Signals are taken again, by every strategy switched on.'}
              disabled={busy === 'sched'}
              onClick={() => void act('sched', () => setScheduler(!data.schedulerOn))}
            >
              {busy === 'sched' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {data.schedulerOn ? 'Turn off' : 'Turn on'}
            </Button>
          )}
          {data && (
            <span className="desk-badge-pill"
                  style={data.mode === 'live'
                    ? { background: 'color-mix(in_srgb,_var(--down)_12%,_transparent)', color: 'var(--down)', border: '1px solid color-mix(in_srgb,_var(--down)_30%,_transparent)' }
                    : { background: 'color-mix(in_srgb,_var(--accent)_10%,_transparent)', color: 'var(--accent)', border: '1px solid color-mix(in_srgb,_var(--accent)_30%,_transparent)' }}>
              {data.mode === 'live' ? 'LIVE' : 'PAPER'}
            </span>
          )}
          {/* A strategy belongs to one broker account, so it is made on that account's tab, never on "All accounts". */}
          <Button size="sm" disabled={!canMakeForAccount()}
                  title={canMakeForAccount() ? undefined : 'Choose an account tab first: a strategy belongs to one account'}
                  onClick={() => { setEditing(null); setFormGroup(defaultGroupFor(accountScope(), groups)); setFormOpen(true); }}>
            <Plus className="h-3.5 w-3.5" /> New signal strategy
          </Button>
          {/* A group is one account's too: made on its tab. */}
          {data?.groups && (
            <Button size="sm" variant="outline" disabled={!canMakeForAccount()}
                    title={canMakeForAccount() ? 'A group of this account\'s strategies, to list and switch together' : 'Choose an account tab first: a group belongs to one account'}
                    onClick={() => setNewGroup(newGroup === null ? '' : null)}>
              <FolderPlus className="h-3.5 w-3.5" /> New group
            </Button>
          )}
          {/* From any account and group, into a group that exists or a new one: copying needs no account tab. */}
          {data?.groups && (
            <Button size="sm" variant="outline" title="Copy strategies from any account or group into a group" onClick={() => setCopying({ into: null, pick: [] })}>
              <CopyPlus className="h-3.5 w-3.5" /> Copy strategies
            </Button>
          )}
        </div>
      </div>

      {!canMakeForAccount() && (
        <p role="note" className="m-0 mb-2 text-[12px] text-muted-foreground">
          Showing every account's strategies. To make a new one, choose an account's tab above: a strategy belongs to one account and trades only on it.
        </p>
      )}
      {data && !data.schedulerOn && mine.some((s) => s.enabled) && (
        <p role="note" className="m-0 mb-2 text-[12px] text-[var(--warn)]">
          Auto-trading is off, so no signal is taken. Turn it on above.
        </p>
      )}
      {failed && <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">{failed}</p>}
      {notice && <p role="status" className="m-0 mb-2 text-[12px] text-[var(--up)]">{notice}</p>}

      {/*
        The strategies added up: what they allow between them, and what that takes.
        Each card's own limit reads as modest; this is what the account has to carry.
      */}
      {data && totals.strategies > 0 && (
        <div aria-label="strategies added up" className="mb-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Tile label="Strategies allow" name="the strategies' limits, added up"
                  value={<>{totals.entries} entr{totals.entries === 1 ? 'y' : 'ies'}</>}>
              <span>{totals.strategies} strateg{totals.strategies === 1 ? 'y' : 'ies'} on</span>
              <span>{totals.lots} lots</span>
              <span className="tabular-nums">{inr(usdToInr(totals.marginUsd))} margin with all of it open</span>
            </Tile>

            {mine.some((s) => s.open) && (
              <Tile label={limited ? `In use now · of the limit of ${cap}` : 'In use now'} name="in use now, all strategies"
                    value={<>{usedEntries} of {mostEntries} entr{mostEntries === 1 ? 'y' : 'ies'}</>}
                    meter={{ label: 'entries in use, all strategies', now: usedEntries, max: mostEntries, tone: 'accent' }}>
                <span>{inUse.lots} of {inUse.lots + room.lots} lots</span>
                {/* Delta's own margin in use where it gives it; the desk's estimate only where it does not (paper). */}
                {deltaMarginUsd !== null
                  ? <span className="tabular-nums" aria-label="margin in use, Delta's figure">{inr(usdToInr(deltaMarginUsd))} margin in use — Delta&apos;s own figure</span>
                  : <span className="tabular-nums">{inr(usdToInr(inUse.marginUsd))} of {inr(usdToInr(inUse.marginUsd + room.marginUsd))} margin — the desk&apos;s estimate</span>}
                {shortCap !== null && <span aria-label="lots short, of the desk's limit">{shortNow} of {shortCap} lots short — the desk&apos;s limit</span>}
              </Tile>
            )}

            {/*
              What is still to open, against what is free. Not the whole requirement: the free balance is already net
              of the margin the open positions use, and holding all of it against that counted them twice.
            */}
            <Tile label={cap > 0 ? `Still to open · under the limit of ${cap}` : 'Still to open'} name="still to open, against the free margin"
                  value={room.entries === 0
                    ? <>Nothing — {cap > 0 && (data.openNow ?? 0) >= cap ? 'the limit is reached'
                      : room.heldByShortLimit ? `the desk's limit of ${shortCap} lots short leaves no room (${shortNow} now)`
                        : 'every strategy is at its own limit'}</>
                    : <>{room.entries} entr{room.entries === 1 ? 'y' : 'ies'} · {room.lots} lots</>}
                  status={room.entries === 0 || freeUsd === null ? null : fit}
                  meter={room.entries === 0 || freeUsd === null || !(freeUsd > 0) ? undefined
                    : { label: 'margin still needed, of what is free', now: Math.round(usdToInr(room.marginUsd) ?? 0), max: Math.round(usdToInr(freeUsd) ?? 0), tone: fit.tone }}>
              {room.entries > 0 && (
                <span className="tabular-nums">
                  needs {inr(usdToInr(room.marginUsd))} more margin
                  {freeUsd !== null && <> — {inr(usdToInr(freeUsd))} is free{freeUsd > 0 ? ` (${Math.round((room.marginUsd / freeUsd) * 100)}%)` : ''}</>}
                </span>
              )}
              {room.entries > 0 && room.heldByShortLimit && (
                <span aria-label="held by the limit on lots short">
                  held to {lotsLeft} more lots by the desk&apos;s limit of {shortCap} short ({shortNow} now): an entry past it is refused
                </span>
              )}
              {room.entries > 0 && <span>the worst case: the largest lots first</span>}
            </Tile>
          </div>
          {short && (
            <p role="note" className="m-0 mt-1.5 flex items-start gap-1.5 rounded-md border border-solid border-[var(--down)]/40 bg-[var(--down)]/10 px-2.5 py-1.5 text-[12px] leading-snug text-foreground">
              <XCircle className="mt-px h-3.5 w-3.5 flex-none text-[var(--down)]" aria-hidden />
              <span>That is more than is free: an order that does not fit is refused at Delta. Lower the limit, the lots, or a strategy&apos;s own &ldquo;at most open&rdquo;.</span>
            </p>
          )}
          <p className="m-0 mt-1 text-[11px] text-[var(--dim)]">
            Margin still needed is estimated at {inr(usdToInr(perLotUsd))} a lot
            {deltaMarginUsd !== null && shortNow > 0
              ? ' — the dearer of the desk’s 200x model and what Delta is charging per lot now.'
              : ' — the desk’s 200x model on BTC now; Delta’s own figure moves with the premium.'}
          </p>
        </div>
      )}

      {data && mine.length === 0 && (
        <p className="m-0 rounded-lg border border-dashed border-[var(--line)] px-3 py-3 text-[12.5px] text-muted-foreground">
          No signal strategy yet. <b className="text-foreground">New signal strategy</b> picks the methods, the strike and the lots;
          each signal is then sold as one option, with its SL and TGT on the BTC perp. Live orders start off.
        </p>
      )}

      {newGroup !== null && (
        <div role="group" aria-label="new group" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--line)] px-2.5 py-2">
          <input
            aria-label="Name of the new group" autoFocus maxLength={40} value={newGroup} placeholder="Group name, e.g. Scalps 5m"
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') makeGroup(); if (e.key === 'Escape') setNewGroup(null); }}
            className="m-0 h-8 w-56 max-w-full rounded border border-solid border-border bg-[var(--bg)] px-2 font-[inherit] text-[13px] text-foreground"
          />
          <Button size="sm" className="h-8" disabled={busy === 'new-group'} onClick={makeGroup}>
            {busy === 'new-group' && <Loader2 className="h-3 w-3 animate-spin" />} Make group
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setNewGroup(null)}>Cancel</Button>
          <span className="basis-full text-[11px] text-[var(--dim)]">Made empty, on this account. Make strategies in it, or move them in from their cards.</span>
        </div>
      )}

      {groups.length === 0
        ? <div className="grid gap-2">{mine.map((s) => card(s))}</div>
        : (
          <div className="grid gap-3">
            {sections.map((sec) => sec.group
              ? (
                <StrategyGroupSection
                  key={sec.group.id}
                  group={sec.group}
                  strategies={sec.strategies}
                  showAccount={accountScope() === null}
                  busy={busy}
                  act={act}
                  canMake={canMakeForAccount()}
                  onNew={() => { setEditing(null); setFormGroup(sec.group); setFormOpen(true); }}
                  onCopyIn={() => setCopying({ into: sec.group, pick: [] })}
                  onMoveGroup={{ up: moveGroup(sec.group, -1), down: moveGroup(sec.group, 1) }}
                >
                  {sec.strategies.map((s) => card(s))}
                </StrategyGroupSection>
              )
              : (
                <section key="no-group" aria-label="not in a group" className="rounded-xl border border-dashed border-[var(--line)] p-2">
                  {/*
                    Those in no group, dealt with together (owner, 11 Oct 2026: twelve left behind by a removed
                    group): all into one of their account's groups, or all removed -- a second tap, and only with
                    every one switched off. Offered when they are one account's, as on an account's tab.
                  */}
                  {(() => {
                    const loose = sec.strategies;
                    const accounts = new Set(loose.map((s) => s.accountId ?? null));
                    const targets = accounts.size === 1 ? groups.filter((g) => (g.accountId ?? null) === [...accounts][0]) : [];
                    const onNow = loose.filter((s) => s.enabled).length;
                    const ids = loose.map((s) => s.id);
                    return (
                      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <h3 className="m-0 text-[13px] font-semibold text-muted-foreground">
                          Not in a group <span className="font-normal tabular-nums text-[var(--dim)]">· {loose.length}</span>
                        </h3>
                        {accounts.size === 1 && (
                          <div className="ml-auto flex flex-wrap items-center gap-1.5">
                            {targets.length > 0 && (
                              <select
                                aria-label="Move all that are in no group to"
                                value=""
                                disabled={busy === 'loose-move'}
                                onChange={(e) => {
                                  const to = targets.find((g) => g.id === e.target.value);
                                  if (to) void act('loose-move', () => takeIntoGroup(to.id, ids)).then((ok) => { if (ok) setNotice(`Moved ${ids.length} into "${to.name}".`); });
                                }}
                                className="m-0 h-8 max-w-[12rem] rounded border border-solid border-border bg-[var(--bg)] px-1.5 font-[inherit] text-[12px] text-foreground disabled:opacity-50"
                              >
                                <option value="">Move all {loose.length} to…</option>
                                {targets.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                              </select>
                            )}
                            <Button size="sm" variant="outline" className="h-8 border-[var(--down)] text-[var(--down)]"
                                    aria-label={`Delete all ${loose.length} that are in no group`}
                                    title={onNow > 0 ? `${onNow} ${onNow === 1 ? 'is' : 'are'} switched on: turn ${onNow === 1 ? 'it' : 'them'} off first` : 'Delete every strategy that is in no group. Their trades and history stay.'}
                                    disabled={onNow > 0 || busy === 'loose-delete'}
                                    onClick={() => {
                                      if (!confirmLoose) { setConfirmLoose(true); setTimeout(() => setConfirmLoose(false), 4_000); return; }
                                      setConfirmLoose(false);
                                      void act('loose-delete', () => deleteStrategies(ids)).then((ok) => { if (ok) setNotice(`Deleted ${ids.length} strateg${ids.length === 1 ? 'y' : 'ies'} that ${ids.length === 1 ? 'was' : 'were'} in no group.`); });
                                    }}>
                              {busy === 'loose-delete' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              {confirmLoose ? `Tap again: delete ${loose.length} for good` : `Delete all ${loose.length}`}
                            </Button>
                          </div>
                        )}
                        {accounts.size === 1 && onNow > 0 && (
                          <span className="basis-full text-[11.5px] text-muted-foreground">{onNow} switched on: turn {onNow === 1 ? 'it' : 'them'} off to delete all together.</span>
                        )}
                      </div>
                    );
                  })()}
                  <div className="grid gap-2">{sec.strategies.map((s) => card(s))}</div>
                </section>
              ))}
          </div>
        )}

      {/* Every trade they took, or would have: SL, TGT, exit, result and money. */}
      {data && mine.length > 0 && <SignalTradeHistory strategies={data.strategies} />}


      {/* Which build the server is: so "is the change live" is read here, not guessed. */}
      {data?.build && (
        <p aria-label="server build" className="m-0 mt-2 text-[11px] text-[var(--dim)]">
          Server build <span className="font-mono text-muted-foreground">{data.build.tag ?? 'not tagged (run by hand)'}</span>
          {' · '}running since {new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(data.build.startedAt)} IST
        </p>
      )}
      <CopyStrategiesSheet
        open={copying !== null}
        onOpenChange={(v) => { if (!v) setCopying(null); }}
        into={copying?.into ?? null}
        pick={copying?.pick ?? []}
        shownAccount={accountScope()}
        onDone={(said) => { setNotice(said); setFailed(null); refresh(); refreshGroupIndex(); }}
      />
      {data && (
        <SignalStrategyForm
          key={editing?.id ?? `new-signal-${formGroup?.id ?? ''}`}
          editing={editing}
          group={editing ? null : formGroup}
          groupName={editing ? groups.find((g) => g.id === editing.groupId)?.name ?? null : null}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={refresh}
          balanceUsd={data.balanceUsd}
          spot={data.spot}
          // The same broker account's: a strategy trades on its own account, and on "All accounts" the list holds every one's.
          copyFrom={copySources(mine.filter((s) => !editing || (s.accountId ?? null) === (editing.accountId ?? null)), editing?.id ?? null)}
        />
      )}
    </section>
  );
}
