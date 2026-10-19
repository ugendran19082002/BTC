import { Chip, Segmented } from '@/components/mobile/parts';
import { NumberField } from '@/components/ui/number-field';

/**
 * Methods by win %, for a run together (owner, 19 Oct 2026: "in the portfolio, pick the saved backtests' methods by
 * win % with a tap"): every saved backtest worked by settings given its own methods that won X% or more of N+ trades.
 * Picked on the days before the run by default -- then tested on days that took no part in picking them -- or on the
 * run's own days, as the Backtest screen's Win tab picks, said for what it is.
 */
export type WinPick = { pct: number; minTrades: number; on: 'before' | 'same'; days: number };
export const WIN_PICK_DEFAULT: WinPick = { pct: 75, minTrades: 3, on: 'before', days: 7 };
const WINS = [50, 60, 70, 75, 80] as const;
const TRADES = [1, 3, 5, 10] as const;
const DAYS = [3, 7, 14] as const;

/** "won ≥75% of 3+ · the 7 days before": the pick in a few words. */
export const winPickWords = (w: WinPick) => `methods won ≥${w.pct}% of ${w.minTrades}+ · ${w.on === 'before' ? `the ${w.days} day${w.days === 1 ? '' : 's'} before` : "the run's own days (in-sample)"}`;

export function RunWinPick({ value, onChange }: { value: WinPick; onChange: (w: WinPick) => void }) {
  const put = (o: Partial<WinPick>) => onChange({ ...value, ...o });
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
          { key: 'before', label: 'The days before', spoken: 'Picked on the days before the run, then tested on the run' },
          { key: 'same', label: "The run's own days", spoken: "Picked on the run's own days, as the Backtest screen's Win tab" },
        ]} />
      {value.on === 'before' ? (
        <div role="group" aria-label="Methods by win %, days before" className="flex flex-wrap items-center gap-1.5">
          {DAYS.map((d) => <Chip key={d} on={value.days === d} onClick={() => put({ days: d })}>{d} days</Chip>)}
        </div>
      ) : null}
      <p className={value.on === 'same' ? 'm-0 text-[12px] leading-snug text-[var(--warn)]' : 'm-0 text-[12px] leading-snug text-muted-foreground'}>
        {value.on === 'before'
          ? `Each saved backtest's methods picked on the ${value.days} finished days before the run, then run on days that took no part in picking them -- an honest test of the pick.`
          : "Picked on the same days it is run on: the methods are chosen knowing how they did, so the result looks better than it can be. Use it to see the list; judge it on the days before."}
        {' '}A saved backtest by a strategy keeps the strategy&apos;s methods. Nothing saved is changed -- each one&apos;s pick can be kept on it from the result.
      </p>
      {(badPct || badTrades) && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">The win rate is from 1% to 100%, and the least trades a whole number from 1 to 100.</p>}
    </div>
  );
}
