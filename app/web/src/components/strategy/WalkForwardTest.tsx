import { useState } from 'react';
import { Chip } from '@/components/mobile/parts';
import { dayLabel, moneyText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { WalkForward, WalkLine } from '@/types/strategy';

/**
 * "Test this rule": the daily update's rule walked forward, with an untouched holdout (18 Oct 2026, the R&D audit:
 * "pick on the days before, test on the next, and validate on the last days without them having had a say"). Each
 * finished day traded with what the rule picked from the days before it alone; the last days held out, so a rule
 * chosen while looking at the rest is judged on days that took no part in choosing it. Beside it, every method and
 * the list as it stands, on the same days -- what the rule has to beat. Read-only: nothing is saved.
 */
const HOLDOUTS = [0, 3, 5, 7] as const;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const winPct = (l: WalkLine) => (l.trades ? `${Math.round((100 * l.wins) / l.trades)}%` : '—');
const tone = (n: number) => (n > 0 ? 'text-[var(--up)]' : n < 0 ? 'text-[var(--down)]' : 'text-muted-foreground');

function Lines({ title, lines, aria }: { title: string; lines: WalkForward['walk']; aria: string }) {
  const rows: [string, WalkLine][] = [['This rule', lines.rule], ['Every method', lines.all], ['The list now', lines.current]];
  const best = Math.max(...rows.map(([, l]) => l.net));
  return (
    <div aria-label={aria} className="min-w-0">
      <div className="text-[12px] font-medium text-foreground">{title} <span className="font-normal text-muted-foreground">· {plural(lines.rule.days, 'day')}</span></div>
      <table className="mt-0.5 w-full border-collapse text-[11.5px] tabular-nums">
        <thead>
          <tr className="text-left text-[10.5px] text-[var(--dim)]">
            <th className="py-0.5 pr-2 font-normal" />
            <th className="py-0.5 pr-2 font-normal">Net</th>
            <th className="py-0.5 pr-2 font-normal">Trades · won</th>
            <th className="py-0.5 pr-2 font-normal max-sm:hidden">Days up / down</th>
            <th className="py-0.5 font-normal max-sm:hidden">Worst day</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, l]) => (
            <tr key={name} className="border-0 border-t border-solid border-[var(--line-soft)]">
              <td className={cn('py-1 pr-2', name === 'This rule' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{name}{l.net === best && l.trades > 0 ? ' ★' : ''}</td>
              <td className={cn('py-1 pr-2', tone(l.net))}>{moneyText(l.net)}</td>
              <td className="py-1 pr-2 text-muted-foreground">{l.trades} · {winPct(l)}</td>
              <td className="py-1 pr-2 text-muted-foreground max-sm:hidden">{l.upDays} / {l.downDays}</td>
              <td className="py-1 text-muted-foreground max-sm:hidden">{l.worstDay ? <>{dayLabel(l.worstDay.day)} <span className={tone(l.worstDay.net)}>{moneyText(l.worstDay.net)}</span></> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WalkForwardTest({ run, disabled, nameOf }: {
  run: (o: { holdout: number }) => Promise<WalkForward>;
  /** The rule as set is wrong: nothing to test until it is put right. */
  disabled?: boolean;
  nameOf: (id: string) => string;
}) {
  const [holdout, setHoldout] = useState<number>(3);
  const [state, setState] = useState<{ busy: boolean; result: WalkForward | null; error: string | null }>({ busy: false, result: null, error: null });
  const [open, setOpen] = useState(false);
  const go = async () => {
    setState({ busy: true, result: null, error: null });
    try { setState({ busy: false, result: await run({ holdout }), error: null }); } catch (e) { setState({ busy: false, result: null, error: e instanceof Error ? e.message : String(e) }); }
  };
  const r = state.result;
  return (
    <section aria-label="Test this rule" className="mt-2 grid min-w-0 gap-1.5 rounded-md border border-dashed border-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={go} disabled={state.busy || disabled}
          className="m-0 h-9 appearance-none rounded-md border border-solid border-border bg-background px-3 font-[inherit] text-[12.5px] text-foreground disabled:opacity-50">
          {state.busy ? 'Testing…' : 'Test this rule'}
        </button>
        <span className="text-[11.5px] text-muted-foreground">Hold out the last</span>
        <div role="group" aria-label="Days held out" className="flex flex-wrap gap-1">
          {HOLDOUTS.map((n) => <Chip key={n} on={holdout === n} onClick={() => setHoldout(n)}>{n === 0 ? 'none' : `${n}d`}</Chip>)}
        </div>
      </div>
      <p className="m-0 text-[11px] leading-snug text-[var(--dim)]">
        Each finished day traded with what this rule picked from the days before it -- never the day itself. The held-out days are scored apart: judge the rule on them. Each method on all its signals; &quot;at most open&quot; is not counted.
      </p>
      {state.error && <p role="alert" className="m-0 text-[11.5px] text-[var(--down)]">{state.error}</p>}
      {r && (
        <div role="status" aria-label="Walk-forward result" className="grid min-w-0 gap-2 rounded-md bg-muted p-2">
          <p className="m-0 text-[11.5px] text-muted-foreground">
            {dayLabel(r.from)} – {dayLabel(r.to)} · win ≥{r.rule.winPct}% on {r.rule.minTrades}+ over {plural(r.rule.days, 'day')}{r.rule.excluded ? ` · ${r.rule.excluded} excluded` : ''}
          </p>
          <Lines title="Walk-forward" lines={r.walk} aria="Walk-forward days" />
          {r.holdout
            ? <Lines title={`Held out, from ${dayLabel(r.holdoutFrom!)}`} lines={r.holdout} aria="Held-out days" />
            : <p className="m-0 text-[11.5px] text-[var(--warn)]">Nothing held out: every day here could have shaped the rule.</p>}
          {r.holdout && (
            <p className="m-0 text-[11.5px] leading-snug text-foreground">
              {r.holdout.rule.net > r.holdout.all.net && r.holdout.rule.net > r.holdout.current.net
                ? 'On the held-out days this rule beat both every method and the list now.'
                : r.holdout.rule.net > r.holdout.all.net ? 'On the held-out days it beat every method, not the list now.'
                  : 'On the held-out days it did not beat every method: the walk-forward gain did not hold.'}
              {r.holdout.rule.days < 5 ? ` ${plural(r.holdout.rule.days, 'day')} is a small sample.` : ''}
            </p>
          )}
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
            className="m-0 justify-self-start appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">
            {open ? 'Hide the days' : `Each day (${r.days.length})`}
          </button>
          {open && (
            <ul aria-label="Each day of the walk" className="m-0 grid list-none gap-0.5 p-0 text-[11.5px] tabular-nums">
              {r.days.map((d) => (
                <li key={d.day} className="min-w-0 leading-snug">
                  <span className={cn('font-medium', d.holdout ? 'text-[var(--warn)]' : 'text-foreground')}>{dayLabel(d.day)}{d.holdout ? ' · held out' : ''}</span>
                  {' '}<span className={tone(d.rule.net)}>{moneyText(d.rule.net)}</span>
                  <span className="text-[var(--dim)]"> · {plural(d.picked.length, 'method')}{d.kept ? ' (kept: none passed)' : ''} · every method {moneyText(d.all.net)}</span>
                  {d.picked.length > 0 && d.picked.length <= 6 && <span className="block truncate text-[10.5px] text-[var(--dim)]">{d.picked.map(nameOf).join(', ')}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
