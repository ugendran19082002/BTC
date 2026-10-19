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
 */
export type WinPick = { pct: number; minTrades: number; on: 'before' | 'first' | 'same'; days: number };
export const WIN_PICK_DEFAULT: WinPick = { pct: 75, minTrades: 3, on: 'before', days: 7 };
const WINS = [50, 60, 70, 75, 80] as const;
const TRADES = [1, 3, 5, 10] as const;
const DAYS = [3, 7, 14] as const;

/** "won ≥75% of 3+ · the 7 days before": the pick in a few words. */
const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
export const winPickWords = (w: WinPick) => `methods won ≥${w.pct}% of ${w.minTrades}+ · ${
  w.on === 'before' ? `the ${plural(w.days)} before` : w.on === 'first' ? `the run's first ${plural(w.days)}, run on the rest` : "the run's own days (in-sample)"}`;

const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const span = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const daysWords = (from: string, to: string) => (from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`);

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
    const from = shift(run.from, -w.days);
    return { problem: null, fix: null, note: from < first ? `Only ${plural(span(first, shift(run.from, -1)))} before the run are in the record (from ${dayLabel(first)}): picked on those.` : null };
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

export function RunWinPick({ value, onChange, run }: {
  value: WinPick; onChange: (w: WinPick) => void;
  /** The run's days: what the pick is checked against before the run is asked for. */
  run?: { from: string; to: string };
}) {
  const put = (o: Partial<WinPick>) => onChange({ ...value, ...o });
  const check = run ? winPickProblem(value, run) : { problem: null, fix: null, note: null };
  const fixWords = (f: Partial<WinPick>) => (f.on === 'same' ? "Pick on the run's own days" : `Pick on the run's first ${plural(f.days ?? value.days)} instead`);
  const badPct = !(value.pct >= 1 && value.pct <= 100), badTrades = !(Number.isInteger(value.minTrades) && value.minTrades >= 1 && value.minTrades <= 100);
  return (
    <div className="grid min-w-0 gap-2">
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
      <Segmented dense label="Methods by win %, picked on" value={value.on} onChange={(on) => put({ on })}
        options={[
          { key: 'before', label: 'Days before', spoken: 'Picked on the days before the run, then tested on the run' },
          { key: 'first', label: 'First days', spoken: "Picked on the run's first days, then tested on the days after them" },
          { key: 'same', label: 'Same days', spoken: "Picked on the run's own days, as the Backtest screen's Win tab" },
        ]} />
      {value.on !== 'same' ? (
        <div role="group" aria-label={value.on === 'before' ? 'Methods by win %, days before' : 'Methods by win %, first days'} className="flex flex-wrap items-center gap-1.5">
          {DAYS.map((d) => <Chip key={d} on={value.days === d} onClick={() => put({ days: d })}>{d} days</Chip>)}
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
      {check.note && <p className="m-0 text-[12px] leading-snug text-[var(--warn)]">{check.note}</p>}
      <p className={value.on === 'same' ? 'm-0 text-[12px] leading-snug text-[var(--warn)]' : 'm-0 text-[12px] leading-snug text-muted-foreground'}>
        {value.on === 'before'
          ? `Each saved backtest's methods picked on the ${value.days} finished days before the run, then run on days that took no part in picking them -- an honest test of the pick.`
          : value.on === 'first'
            ? `Each saved backtest's methods picked on the run's first ${plural(value.days)}${run && !check.problem ? ` (${daysWords(run.from, shift(run.from, value.days - 1))})` : ''}, then run on the days after them${run && !check.problem ? ` (${daysWords(shift(run.from, value.days), run.to)})` : ''} -- days that took no part in the pick, so still an honest test.`
            : "Picked on the same days it is run on: the methods are chosen knowing how they did, so the result looks better than it can be. Use it to see the list; judge it on the days before."}
        {' '}A saved backtest by a strategy keeps the strategy&apos;s methods. Nothing saved is changed -- each one&apos;s pick can be kept on it from the result.
      </p>
      {(badPct || badTrades) && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">The win rate is from 1% to 100%, and the least trades a whole number from 1 to 100.</p>}
    </div>
  );
}
