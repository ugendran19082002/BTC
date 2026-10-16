import { useState } from 'react';
import { NumberField } from '@/components/ui/number-field';
import { dayLabel, moneyText } from '@/lib/market-report';
import { time12 } from '@/lib/time';
import { cn } from '@/lib/utils';
import { DEFAULT_AUTO_METHODS, MAX_AUTO_DAYS, type AutoMethods, type AutoMethodsRun } from '@/types/strategy';

/**
 * The methods' daily update in the signal strategy form (owner, 16 Oct 2026: "daily, a time chosen, the methods
 * picked by a win %, auto update on and off in the signal strategy form -- best practice, user friendly").
 *
 * On, the desk picks the list again every day at the time set: each method's record as options under this
 * strategy's rules over the last days, the ones that won the share asked for on enough trades. "Pick now" shows
 * what it would pick on the form as it stands, to take or leave; saving keeps it.
 */
const WIN_PRESETS = [60, 70, 75, 80] as const;
const DAY_PRESETS = [3, 7, 14, 30] as const;
const TRADE_PRESETS = [1, 3, 5, 10] as const;
/** What did best when measured (8-15 Oct 2026, each day picked from the days before it). */
const BEST_WIN = 75;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** The rule in one sentence, as the desk will follow it. */
export function autoWords(a: AutoMethods): string {
  return `Every day at ${time12(a.at)} IST, keep the methods that won ${a.winPct}% or more of at least ${plural(a.minTrades, 'trade')} over the last ${plural(a.days, 'day')}. If none do, the list stays as it is.`;
}

export function AutoMethodsFields({
  value, onChange, onTake, pickNow, nameOf, blocked, error,
}: {
  value: AutoMethods | null | undefined;
  onChange: (a: AutoMethods) => void;
  /** "Use this list": the pick taken into the form -- its methods and its run. */
  onTake: (run: AutoMethodsRun) => void;
  /** The form's draft picked now (`pickMethodsNow`). Absent: no button. */
  pickNow?: (a: AutoMethods) => Promise<AutoMethodsRun>;
  nameOf: (id: string) => string;
  /** Why it cannot be used here, in words: a strategy that buys. */
  blocked?: string | null;
  error?: string | null;
}) {
  const a = value ?? DEFAULT_AUTO_METHODS;
  const set = <K extends keyof AutoMethods>(k: K, v: AutoMethods[K]) => onChange({ ...a, [k]: v });
  const [pick, setPick] = useState<{ busy: boolean; run: AutoMethodsRun | null; error: string | null }>({ busy: false, run: null, error: null });
  const chip = (on: boolean) => cn(
    'm-0 h-8 min-w-[2.75rem] appearance-none rounded-md border border-solid px-2 font-[inherit] text-[12px] tabular-nums',
    on ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground',
  );
  const label = 'text-[11.5px] text-muted-foreground';

  const runNow = async () => {
    if (!pickNow) return;
    setPick({ busy: true, run: null, error: null });
    try { setPick({ busy: false, run: await pickNow(a), error: null }); } catch (e) { setPick({ busy: false, run: null, error: e instanceof Error ? e.message : String(e) }); }
  };
  const run = pick.run;
  const added = run ? run.picked.filter((m) => !run.before.includes(m)) : [];
  const dropped = run ? run.before.filter((m) => !run.picked.includes(m)) : [];
  const last = a.last ?? null;

  return (
    <section aria-label="Auto-update methods" className="mb-2 rounded-md border border-solid border-border p-2.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-foreground">Auto-update methods</span>
          <span className={cn('block text-[11.5px] leading-snug', a.on ? 'text-foreground' : 'text-muted-foreground')}>
            {blocked ? blocked : a.on ? autoWords(a) : 'Off · the list below is yours and stays as you pick it.'}
          </span>
        </span>
        <button type="button" role="switch" aria-checked={a.on} aria-label="Update the methods every day" disabled={Boolean(blocked)}
                onClick={() => set('on', !a.on)}
                className="m-0 inline-flex min-h-[44px] flex-none cursor-pointer appearance-none items-center border-0 bg-transparent p-0 pl-2 disabled:cursor-not-allowed disabled:opacity-50">
          <span className={cn('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', a.on ? 'bg-[var(--chosen)]' : 'bg-[var(--line)]')}>
            <span className={cn('block h-5 w-5 rounded-full shadow transition-transform', a.on ? 'translate-x-[22px] bg-[var(--chosen-ink)]' : 'translate-x-0.5 bg-muted-foreground')} />
          </span>
        </button>
      </div>

      {!blocked && a.on && (
        <div className="mt-2 grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className={label}>Time (IST)</span>
            <input type="time" aria-label="Update time, IST" value={a.at} onChange={(e) => set('at', e.target.value)}
                   className="h-9 w-full min-w-0 rounded-md border border-solid border-border bg-background px-2 text-[13px] text-foreground sm:w-36" />
            <span className="text-[11px] leading-snug text-[var(--dim)]">After 5:30 PM, so the day just settled counts. 9:00 PM is before the evening&apos;s signals.</span>
          </label>
          <div className="grid gap-1">
            <span className={label}>Win rate at least</span>
            <div role="group" aria-label="Win rate presets" className="flex flex-wrap items-center gap-1">
              {WIN_PRESETS.map((p) => (
                <button key={p} type="button" aria-label={`Win ${p}%${p === BEST_WIN ? ', best when tested' : ''}`} aria-pressed={a.winPct === p} onClick={() => set('winPct', p)} className={chip(a.winPct === p)}
                        title={p === BEST_WIN ? 'Did best when tested: 8–15 Oct, each day picked from the days before it' : undefined}>
                  {p}%{p === BEST_WIN ? ' ★' : ''}
                </button>
              ))}
              <NumberField label="Daily update: win rate at least, percent" value={a.winPct} unit="%" decimals={0} className="w-20" onChange={(n) => set('winPct', n)} />
            </div>
          </div>
          <div className="grid gap-1">
            <span className={label}>Look back</span>
            <div role="group" aria-label="Look-back presets" className="flex flex-wrap items-center gap-1">
              {DAY_PRESETS.map((p) => (
                <button key={p} type="button" aria-label={`Last ${p} days`} aria-pressed={a.days === p} onClick={() => set('days', p)} className={chip(a.days === p)}>{p}d</button>
              ))}
              <NumberField label="Daily update: days to look back" value={a.days} unit="d" decimals={0} className="w-20" onChange={(n) => set('days', n)} />
            </div>
            <span className="text-[11px] leading-snug text-[var(--dim)]">Finished expiry days, up to {MAX_AUTO_DAYS}.</span>
          </div>
          <div className="grid gap-1">
            <span className={label}>At least this many trades</span>
            <div role="group" aria-label="Least trades presets" className="flex flex-wrap items-center gap-1">
              {TRADE_PRESETS.map((p) => (
                <button key={p} type="button" aria-label={`At least ${p} trade${p === 1 ? '' : 's'}`} aria-pressed={a.minTrades === p} onClick={() => set('minTrades', p)} className={chip(a.minTrades === p)}>{p}</button>
              ))}
              <NumberField label="Daily update: least trades" value={a.minTrades} decimals={0} className="w-20" onChange={(n) => set('minTrades', n)} />
            </div>
            <span className="text-[11px] leading-snug text-[var(--dim)]">1 of 1 is 100%: a few more trades keep a lucky one out.</span>
          </div>
        </div>
      )}
      {error && <p role="alert" className="m-0 mt-1.5 text-[11.5px] text-[var(--down)]">{error}</p>}

      {!blocked && a.on && pickNow && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={runNow} disabled={pick.busy || Boolean(error)}
                  className="m-0 h-9 appearance-none rounded-md border border-solid border-border bg-background px-3 font-[inherit] text-[12.5px] text-foreground disabled:opacity-50">
            {pick.busy ? 'Picking…' : 'Pick now'}
          </button>
          <span className="text-[11px] leading-snug text-[var(--dim)]">See what it would pick today, with the settings above. Nothing is saved until you save.</span>
        </div>
      )}
      {pick.error && <p role="alert" className="m-0 mt-1.5 text-[11.5px] text-[var(--down)]">{pick.error}</p>}
      {run && (
        <div role="status" aria-label="What it would pick" className="mt-2 rounded-md bg-muted p-2 text-[12px] leading-snug">
          {run.note
            ? <p className="m-0 text-[var(--warn)]">{run.note}</p>
            : (
              <>
                <p className="m-0 text-foreground">
                  <b>{plural(run.picked.length, 'method')}</b> (now {run.before.length}) · {dayLabel(run.from)} – {dayLabel(run.to)}
                  {' · '}<span className="text-[var(--up)]">+{added.length} new</span>, <span className="text-[var(--down)]">−{dropped.length} dropped</span>
                </p>
                <ul aria-label="Methods it would pick" className="m-0 mt-1 grid list-none gap-0.5 p-0 sm:grid-cols-2">
                  {run.picked.map((id) => {
                    const r = run.records?.find((x) => x.method === id);
                    return (
                      <li key={id} className="min-w-0 text-[11.5px] leading-snug">
                        <span className={added.includes(id) ? 'text-[var(--up)]' : 'text-foreground'}>{nameOf(id)}</span>
                        {r && r.trades > 0 && <span className="text-[var(--dim)] tabular-nums"> · {r.wins}/{r.trades} won · {moneyText(r.net)}</span>}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          <div className="mt-1.5 flex flex-wrap gap-2">
            {!run.note && (
              <button type="button" onClick={() => { onTake(run); setPick({ busy: false, run: null, error: null }); }}
                      className="m-0 h-8 appearance-none rounded-md border-0 bg-[var(--chosen)] px-3 font-[inherit] text-[12px] text-[var(--chosen-ink)]">
                Use this list
              </button>
            )}
            <button type="button" onClick={() => setPick({ busy: false, run: null, error: null })}
                    className="m-0 h-8 appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[12px] text-muted-foreground">
              {run.note ? 'Close' : 'Keep mine'}
            </button>
          </div>
        </div>
      )}

      {last && (
        <p aria-label="Last update" className="m-0 mt-2 text-[11px] leading-snug text-[var(--dim)]">
          Last update {when(last.at)}: {last.note
            ? <span className="text-[var(--warn)]">{last.note}</span>
            : `${plural(last.picked.length, 'method')} (was ${last.before.length}), from ${dayLabel(last.from)} – ${dayLabel(last.to)}.`}
        </p>
      )}
    </section>
  );
}
