import { Chip, Segmented } from '@/components/mobile/parts';
import { NumberField } from '@/components/ui/number-field';
import { FIRST_DAY, dayLabel } from '@/lib/market-report';

/**
 * Methods by win %, for a run together (owner, 19 Oct 2026: "in the portfolio, pick the saved backtests' methods by
 * win % with a tap"): every saved backtest worked by settings given its own methods that won X% or more of N+ trades.
 * Picked on the days before the run by default -- then tested on days that took no part in picking them -- or on the
 * run's own days, as the Backtest screen's Win tab picks, said for what it is.
 *
 * Or on the run's own first days, then run on the days after them (owner, 19 Oct 2026: "portfolio not working" -- a
 * run from 1 Oct has no finished days before it, the record starting then, and every run was refused while the last
 * result stayed on the screen). Where the days before cannot be had, it says so here, before the run, with that a tap away.
 *
 * Or on custom days (owner, 19 Oct 2026: "first day custom, last day"): a first and a last day of the record to pick on,
 * and the run then on its days after the last -- never on a day of the pick. The days before and the first days take
 * any count typed, 1 to 30, beside the chips.
 */
export type WinPick = {
  pct: number; minTrades: number; on: 'before' | 'first' | 'same' | 'custom'; days: number;
  /** `custom`: the first and the last day picked on, YYYY-MM-DD. */
  pickFrom?: string; pickTo?: string;
};
export const WIN_PICK_DEFAULT: WinPick = { pct: 75, minTrades: 3, on: 'before', days: 7 };
const WINS = [50, 60, 70, 75, 80] as const;
const TRADES = [1, 3, 5, 10] as const;
const DAYS = [3, 7, 14] as const;

/** "won ≥75% of 3+ · the 7 days before": the pick in a few words. */
const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const span = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const daysWords = (from: string, to: string) => (from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`);
const isDay = (d: string | undefined): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
/** The most days methods are picked on, custom: as the server holds it. */
export const PICK_DAYS_MAX = 31;
/** Fewer days than this, picked on or tested on, is said: a handful of trades, or a day that swings it. */
const FEW_DAYS = 5;

export const winPickWords = (w: WinPick) => `methods won ≥${w.pct}% of ${w.minTrades}+ · ${
  w.on === 'before' ? `the ${plural(w.days)} before`
    : w.on === 'first' ? `the run's first ${plural(w.days)}, run on the rest`
      : w.on === 'custom' ? (isDay(w.pickFrom) && isDay(w.pickTo) ? `picked on ${daysWords(w.pickFrom, w.pickTo)}, run after` : 'custom days')
        : "the run's own days (in-sample)"}`;

/** Custom days to start from: the run's first week, leaving at least a day to run on; or the week before it. */
export function customPickFor(run: { from: string; to: string }, first = FIRST_DAY): { pickFrom: string; pickTo: string } {
  if (shift(run.from, -7) >= first) return { pickFrom: shift(run.from, -7), pickTo: shift(run.from, -1) };
  const n = Math.max(1, Math.min(7, span(run.from, run.to) - 1));
  return { pickFrom: run.from, pickTo: shift(run.from, n - 1) };
}

/**
 * What stands in the way of the pick on the run's days, as the server checks it -- in words, with the change that
 * makes it work -- or null. `note`: a pick that works on fewer days than asked.
 */
export function winPickProblem(w: WinPick, run: { from: string; to: string }, first = FIRST_DAY): { problem: string | null; fix: Partial<WinPick> | null; note: string | null } {
  if (w.on === 'before') {
    if (shift(run.from, -1) < first) {
      return {
        problem: `There are no finished days before ${dayLabel(run.from)} to pick from: the record starts ${dayLabel(first)}.`,
        fix: span(run.from, run.to) > w.days ? { on: 'first' } : span(run.from, run.to) > 1 ? { on: 'first', days: span(run.from, run.to) - 1 } : { on: 'same' },
        note: null,
      };
    }
    if (shift(run.from, -w.days) >= first) return { problem: null, fix: null, note: null };
    // Fewer days before than asked: picked on those -- and under half of them is a handful of trades, not a record
    // (19 Oct 2026: a run from 2 Oct, 14 days asked, 1 Oct alone -- six of seven saved backtests found nothing).
    const had = span(first, shift(run.from, -1));
    const few = had * 2 < w.days;
    return {
      problem: null,
      fix: few ? (span(run.from, run.to) > w.days ? { on: 'first' } : { on: 'first', days: Math.max(1, Math.floor(span(run.from, run.to) / 2)) }) : null,
      note: `Only ${plural(had)} of the ${w.days} before the run ${had === 1 ? 'is' : 'are'} in the record (from ${dayLabel(first)})${
        few ? ': too few to pick on -- a day or two is a handful of trades, not a record.' : ': picked on those.'}`,
    };
  }
  if (w.on === 'custom') {
    const { pickFrom: a, pickTo: b } = w;
    if (!isDay(a) || !isDay(b)) return { problem: 'Pick a first and a last day to pick on.', fix: customPickFor(run, first), note: null };
    if (a > b) return { problem: `The first day to pick on (${dayLabel(a)}) is after the last (${dayLabel(b)}).`, fix: { pickFrom: b, pickTo: a }, note: null };
    if (a < first) return { problem: `The record starts ${dayLabel(first)}: pick on days from then.`, fix: { pickFrom: first }, note: null };
    if (span(a, b) > PICK_DAYS_MAX) return { problem: `At most ${PICK_DAYS_MAX} days to pick on; these are ${span(a, b)}.`, fix: { pickFrom: shift(b, -(PICK_DAYS_MAX - 1)) }, note: null };
    if (b >= run.to) {
      const end = a < run.to ? shift(a, Math.max(0, Math.floor((span(a, run.to) - 2) / 2))) : null;
      return { problem: `Picking up to ${dayLabel(b)} leaves none of the run (to ${dayLabel(run.to)}) to run on.`, fix: end ? { pickTo: end } : null, note: null };
    }
    const tested = span(b >= run.from ? shift(b, 1) : run.from, run.to), picked = span(a, b);
    const notes = [
      picked < FEW_DAYS ? `Picked on only ${plural(picked)}: a handful of trades, not much of a record.` : null,
      tested < FEW_DAYS ? `Run on only ${plural(tested)}: one good or bad day can swing it.` : null,
    ].filter(Boolean);
    return { problem: null, fix: null, note: notes.length ? notes.join(' ') : null };
  }
  if (w.on === 'first' && span(run.from, run.to) <= w.days) {
    const n = span(run.from, run.to);
    return {
      problem: `The run is ${plural(n)}: picking on its first ${plural(w.days)} leaves none to run on.`,
      fix: n > 1 ? { days: Math.max(1, Math.floor(n / 2)) } : { on: 'same' },
      note: null,
    };
  }
  return { problem: null, fix: null, note: null };
}

/** Where a switch starts: the default, or -- where the run's days cannot have it -- the change that makes it work. */
export function winPickFor(run?: { from: string; to: string }, first = FIRST_DAY): WinPick {
  const fix = run ? winPickProblem(WIN_PICK_DEFAULT, run, first).fix : null;
  return fix ? { ...WIN_PICK_DEFAULT, ...fix } : WIN_PICK_DEFAULT;
}

/** The fix to a pick, as its button says it. */
export const winPickFixWords = (f: Partial<WinPick>, w: WinPick) => (
  f.on === 'same' ? "Pick on the run's own days"
    : f.pickFrom && f.pickTo ? `Pick on ${daysWords(f.pickFrom, f.pickTo)}`
      : f.pickTo ? `End the pick on ${dayLabel(f.pickTo)}`
        : f.pickFrom ? `Start the pick on ${dayLabel(f.pickFrom)}`
          : `Pick on the run's first ${plural(f.days ?? w.days)} instead`);

export function RunWinPick({ value, onChange, run, daysOnly = false, whose = "Each saved backtest's" }: {
  value: WinPick; onChange: (w: WinPick) => void;
  /** The run's days: what the pick is checked against before the run is asked for. */
  run?: { from: string; to: string };
  /** The days picked on alone, the win % and the least trades set elsewhere (20 Oct 2026: the win % sweep sets several). */
  daysOnly?: boolean;
  /** Whose methods are picked, as the words under it start: the saved backtests', or the settings'. */
  whose?: string;
}) {
  const put = (o: Partial<WinPick>) => onChange({ ...value, ...o });
  const check = run ? winPickProblem(value, run) : { problem: null, fix: null, note: null };
  const fixWords = (f: Partial<WinPick>) => winPickFixWords(f, value);
  const badPct = !daysOnly && !(value.pct >= 1 && value.pct <= 100), badTrades = !daysOnly && !(Number.isInteger(value.minTrades) && value.minTrades >= 1 && value.minTrades <= 100);
  const badDays = value.on !== 'custom' && value.on !== 'same' && !(Number.isInteger(value.days) && value.days >= 1 && value.days <= 30);
  // Custom chosen: the days it starts from, where none are kept yet.
  const choose = (on: WinPick['on']) => put(on === 'custom' && !(isDay(value.pickFrom) && isDay(value.pickTo)) && run ? { on, ...customPickFor(run) } : { on });
  const field = 'h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] px-2 text-[15px] text-foreground [color-scheme:dark]';
  const tested = run && value.on === 'custom' && isDay(value.pickTo) && !check.problem
    ? { from: value.pickTo >= run.from ? shift(value.pickTo, 1) : run.from, to: run.to } : null;
  return (
    <div className="grid min-w-0 gap-2">
      {!daysOnly && <>
      <div className="grid min-w-0 gap-1">
        <span className="text-[12px] text-muted-foreground">Won at least</span>
        <div role="group" aria-label="Methods by win %, won at least" className="flex flex-wrap items-center gap-1.5">
          {WINS.map((p) => <Chip key={p} on={value.pct === p} onClick={() => put({ pct: p })}>{p}%</Chip>)}
          <NumberField label="Methods by win %, percent" value={value.pct} unit="%" decimals={0} className="w-20" invalid={badPct} onChange={(pct) => put({ pct })} />
        </div>
      </div>
      <div className="grid min-w-0 gap-1">
        <span className="text-[12px] text-muted-foreground">Of at least this many trades</span>
        <div role="group" aria-label="Methods by win %, least trades" className="flex flex-wrap items-center gap-1.5">
          {TRADES.map((n) => <Chip key={n} on={value.minTrades === n} onClick={() => put({ minTrades: n })}>{n}</Chip>)}
        </div>
        {value.minTrades < 3 && <span className="text-[11.5px] text-[var(--warn)]">One or two trades is luck, not a record: 1 of 1 is 100%.</span>}
      </div>
      </>}
      <Segmented dense label="Methods by win %, picked on" value={value.on} onChange={choose}
        options={[
          { key: 'before', label: 'Days before', spoken: 'Picked on the days before the run, then tested on the run' },
          { key: 'first', label: 'First days', spoken: "Picked on the run's first days, then tested on the days after them" },
          { key: 'same', label: 'Same days', spoken: "Picked on the run's own days, as the Backtest screen's Win tab" },
          { key: 'custom', label: 'Custom', spoken: 'Picked on days you choose, then tested on the run days after them' },
        ]} />
      {value.on === 'before' || value.on === 'first' ? (
        <div role="group" aria-label={value.on === 'before' ? 'Methods by win %, days before' : 'Methods by win %, first days'} className="flex flex-wrap items-center gap-1.5">
          {DAYS.map((d) => <Chip key={d} on={value.days === d} onClick={() => put({ days: d })}>{d} days</Chip>)}
          <NumberField label="Methods by win %, days" value={value.days} unit="days" decimals={0} className="w-24" invalid={badDays} onChange={(days) => put({ days })} />
        </div>
      ) : null}
      {value.on === 'custom' ? (
        <div role="group" aria-label="Methods by win %, custom days" className="grid min-w-0 grid-cols-2 gap-2">
          <label className="grid min-w-0 gap-1 text-[12px] text-muted-foreground">Pick from
            <input type="date" aria-label="Pick from" className={field} value={value.pickFrom ?? ''} min={FIRST_DAY} max={run ? shift(run.to, -1) : undefined}
              onChange={(e) => put({ pickFrom: e.target.value })} />
          </label>
          <label className="grid min-w-0 gap-1 text-[12px] text-muted-foreground">Pick to
            <input type="date" aria-label="Pick to" className={field} value={value.pickTo ?? ''} min={value.pickFrom || FIRST_DAY} max={run ? shift(run.to, -1) : undefined}
              onChange={(e) => put({ pickTo: e.target.value })} />
          </label>
        </div>
      ) : null}
      {check.problem && (
        <div role="alert" className="grid gap-1.5 rounded-md border border-[var(--warn)] px-3 py-2 text-[12.5px] leading-snug">
          <span><b className="font-semibold">Cannot run like this.</b> {check.problem}</span>
          {check.fix && (
            <button type="button" onClick={() => put(check.fix!)}
              className="min-h-[40px] justify-self-start rounded-md border border-[var(--accent)] bg-transparent px-3 font-[inherit] text-[13px] font-semibold text-[var(--accent)]">
              {fixWords(check.fix)}
            </button>
          )}
        </div>
      )}
      {check.note && (
        <div className="grid gap-1.5">
          <p className="m-0 text-[12px] leading-snug text-[var(--warn)]">{check.note}</p>
          {check.fix && !check.problem && (
            <button type="button" onClick={() => put(check.fix!)}
              className="min-h-[40px] justify-self-start rounded-md border border-[var(--accent)] bg-transparent px-3 font-[inherit] text-[13px] font-semibold text-[var(--accent)]">
              {fixWords(check.fix)}
            </button>
          )}
        </div>
      )}
      <p className={value.on === 'same' ? 'm-0 text-[12px] leading-snug text-[var(--warn)]' : 'm-0 text-[12px] leading-snug text-muted-foreground'}>
        {value.on === 'before'
          ? `${whose} methods picked on the ${value.days} finished days before the run, then run on days that took no part in picking them -- an honest test of the pick.`
          : value.on === 'first'
            ? `${whose} methods picked on the run's first ${plural(value.days)}${run && !check.problem ? ` (${daysWords(run.from, shift(run.from, value.days - 1))})` : ''}, then run on the days after them${run && !check.problem ? ` (${daysWords(shift(run.from, value.days), run.to)})` : ''} -- days that took no part in the pick, so still an honest test.`
            : value.on === 'custom'
              ? (tested && isDay(value.pickFrom) && isDay(value.pickTo)
                ? `${whose} methods picked on ${daysWords(value.pickFrom, value.pickTo)} (${plural(span(value.pickFrom, value.pickTo))}), then run on ${daysWords(tested.from, tested.to)} (${plural(span(tested.from, tested.to))}) -- never on a day of the pick, so an honest test.`
                : `${whose} methods picked on the days you choose, then run on the run's days after the last of them -- never on a day of the pick.`)
              : "Picked on the same days it is run on: the methods are chosen knowing how they did, so the result looks better than it can be. Use it to see the list; judge it on the days before."}
        {!daysOnly && <>{' '}A saved backtest by a strategy keeps the strategy&apos;s methods. Nothing saved is changed -- each one&apos;s pick can be kept on it from the result.</>}
      </p>
      {(badPct || badTrades || badDays) && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">The win rate is from 1% to 100%, the least trades a whole number from 1 to 100, and the days 1 to 30.</p>}
    </div>
  );
}
