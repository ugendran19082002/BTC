import { getLiveCheck } from '@/api/signal-backtest';
import { usePersisted } from '@/hooks/usePersisted';
import { dayLabel, expiryDayOf, shiftDay, timeIst } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { LiveCheck as Check, LiveCheckCount, LiveCheckRow, LiveCheckWhy } from '@/types/signal-backtest';
import { Empty, Loading, Panel, Segmented, Stat, Stats } from '@/components/mobile/parts';
import { Updating, useAnswer } from '@/components/report/Updating';

/**
 * The backtest against the live desk (owner, 14 Oct 2026: "the real trades since 9:30 last night and the
 * backtest's trades do not match in number -- check the calculation", then "show the skipped and rejected
 * counts").
 *
 * Two counts that differ are not a wrong calculation until it is known which signals differ and why, and that is
 * what this section answers on the screen: the desk's orders, refusals and skips, the backtest's trades of the
 * same signals by each strategy's own rules, how many are the same signal on both sides -- and every signal on
 * one side only under the reason for it, in the desk's own words for one it refused or skipped. A day on which
 * the two agree says so in one line.
 */

type Days = 'today' | 'two' | '7';
const DAYS: { key: Days; label: string; spoken: string }[] = [
  { key: 'today', label: 'This expiry day', spoken: 'The expiry day in progress' },
  { key: 'two', label: 'And the one before', spoken: 'The expiry day in progress and the one before it' },
  { key: '7', label: '7 days', spoken: 'The last 7 expiry days' },
];
const n = (x: number) => x.toLocaleString('en-IN');
const side = (dir: 1 | -1) => (dir === 1 ? 'BUY' : 'SELL');
const stamp = (ms: number) => `${dayLabel(new Date(ms + 19_800_000).toISOString().slice(0, 10)).split(' ').slice(1).join(' ')}, ${timeIst(ms)}`;

/** Reasons with their counts, the most common first: "670 its SL / TGT distance". */
function Reasons({ label, items, tone }: { label: string; items: LiveCheckCount[]; tone: 'warn' | 'dim' }) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[12px] text-muted-foreground">{label}</div>
      <ul aria-label={label} className="m-0 grid list-none gap-1 p-0">
        {items.map((x) => (
          <li key={x.why} className="flex items-baseline gap-2 text-[13px] leading-snug">
            <b className={cn('min-w-[2.5rem] flex-none text-right tabular-nums', tone === 'warn' ? 'text-[var(--warn)]' : 'text-foreground')}>{n(x.n)}</b>
            <span className="min-w-0 [overflow-wrap:anywhere]">{x.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Signals on one side only, each group under its reason with the first few to look up. */
function OneSide({ label, groups }: { label: string; groups: LiveCheckWhy[] }) {
  if (groups.length === 0) return null;
  return (
    <ul aria-label={label} className="m-0 grid list-none gap-1.5 p-0">
      {groups.map((g) => (
        <li key={g.why} className="rounded-md border border-[var(--line-soft)] px-2.5 py-1.5 text-[13px] leading-snug">
          <span><b className="tabular-nums text-[var(--warn)]">{n(g.n)}</b> {label.toLowerCase()} &mdash; {g.why}</span>
          <span className="block text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
            {g.first.map((s) => `${stamp(s.at)} · ${s.method} · ${s.tf === 'chain' ? 'TF chain' : s.tf} · ${side(s.dir)}`).join('  |  ')}{g.n > g.first.length ? `  |  and ${n(g.n - g.first.length)} more` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Strategy({ r }: { r: LiveCheckRow }) {
  const differ = r.backtestOnly.reduce((a, g) => a + g.n, 0) + r.liveOnly.reduce((a, g) => a + g.n, 0);
  const notTraded = r.backtestSkipped.reduce((a, g) => a + g.n, 0);
  const quiet = r.live.placed + r.live.refused + r.live.skipped + r.backtest + notTraded === 0;
  return (
    <li aria-label={r.name} className="grid min-w-0 gap-1.5 border-0 border-t border-solid border-[var(--line-soft)] py-2.5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[14px] font-semibold [overflow-wrap:anywhere]">{r.name}{r.account ? <span className="font-normal text-muted-foreground"> · {r.account}</span> : null}</span>
        <span className={cn('text-[12.5px] font-medium', quiet ? 'text-muted-foreground' : differ === 0 ? 'text-[var(--up)]' : 'text-[var(--warn)]')}>
          {quiet ? 'No signal of its methods' : differ === 0 ? 'Every order matches' : `${n(differ)} differ`}
        </span>
      </div>
      {!quiet && (
        <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[13px]">
          <dt className="text-muted-foreground">Desk</dt>
          <dd className="m-0 tabular-nums"><b>{n(r.live.placed)}</b> placed · {n(r.live.refused)} refused · {n(r.live.skipped)} skipped</dd>
          <dt className="text-muted-foreground">Backtest</dt>
          <dd className="m-0 tabular-nums"><b>{n(r.backtest)}</b> traded · {n(notTraded)} not traded</dd>
          <dt className="text-muted-foreground">The same signal</dt>
          <dd className="m-0 tabular-nums"><b>{n(r.same)}</b></dd>
        </dl>
      )}
      <OneSide label="In the backtest only" groups={r.backtestOnly} />
      <OneSide label="On the desk only" groups={r.liveOnly} />
      {(r.liveWhy.refused.length > 0 || r.liveWhy.skipped.length > 0 || r.backtestSkipped.length > 0) && (
        <details className="text-[13px]">
          <summary className="min-h-[32px] cursor-pointer py-1 text-[12.5px] text-[var(--accent)]">Refused, skipped and not traded, by reason</summary>
          <div className="grid gap-2 pt-1">
            <Reasons label="The desk refused" items={r.liveWhy.refused} tone="warn" />
            <Reasons label="The desk skipped" items={r.liveWhy.skipped} tone="dim" />
            <Reasons label="The backtest did not trade" items={r.backtestSkipped} tone="dim" />
          </div>
        </details>
      )}
    </li>
  );
}

function Result({ r }: { r: Check }) {
  const t = r.total;
  const differ = t.backtestOnly + t.liveOnly;
  const nothing = t.placed + t.refused + t.skipped + t.backtest === 0;
  return (
    <>
      <Panel title="The live desk against the backtest">
        <p className="m-0 text-[13.5px] text-muted-foreground">
          {dayLabel(r.from)}{r.to !== r.from ? ` → ${dayLabel(r.to)}` : ''} expiry
          {r.liveFrom !== null && r.liveTo !== null ? <> · the desk&apos;s record runs {stamp(r.liveFrom)} → {stamp(r.liveTo)} IST</> : ' · the desk has no record in these days'}
        </p>
        {nothing ? <div className="mt-2"><Empty>No signal of any strategy&apos;s methods in these days yet.</Empty></div> : (
          <>
            <p role="status" aria-label="Whether they match" className={cn('m-0 mt-2 rounded-md px-3 py-2 text-[14px] font-medium leading-snug', differ === 0 ? 'bg-[rgba(38,161,123,0.14)] text-[var(--up)]' : 'bg-[var(--chosen-soft)] text-foreground')}>
              {differ === 0
                ? `They match: all ${n(t.placed)} orders the desk placed are trades in the backtest, and the backtest has no other.`
                : <>
                  <b>{n(t.same)}</b> signals are an order on the desk and a trade in the backtest.
                  {t.backtestOnly > 0 && <> The backtest has <b>{n(t.backtestOnly)}</b> more ({n(t.backtest)} against {n(t.placed)}).</>}
                  {t.liveOnly > 0 && <> The desk has <b>{n(t.liveOnly)}</b> the backtest does not.</>}
                  {' '}Each is under its reason below.
                </>}
            </p>
            <div className="mt-2 grid gap-2">
              <Stats cols={3}>
                <Stat label="Desk · placed">{n(t.placed)}</Stat>
                <Stat label="Desk · refused" tone={t.refused > 0 ? 'warn' : undefined}>{n(t.refused)}</Stat>
                <Stat label="Desk · skipped">{n(t.skipped)}</Stat>
              </Stats>
              <Stats cols={3}>
                <Stat label="Backtest · traded">{n(t.backtest)}</Stat>
                <Stat label="Backtest · not traded">{n(t.backtestSkipped)}</Stat>
                <Stat label="Same signal" tone={differ === 0 ? 'up' : undefined}>{n(t.same)}</Stat>
              </Stats>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Reasons label="Why the desk refused" items={r.liveWhy.refused} tone="warn" />
              <Reasons label="Why the desk skipped" items={r.liveWhy.skipped} tone="dim" />
            </div>
          </>
        )}
        <p className="m-0 mt-3 text-[12px] leading-snug text-muted-foreground">
          Each strategy is backtested by its own rules as they stand now, an account&apos;s strategies together under that account&apos;s limit on open trades, and matched with the desk signal for signal.
          The backtest replays the rules, not the account: a refusal by the daily loss limit or by margin, and a desk or a strategy that was not running, are the desk&apos;s &mdash; they are where a difference is expected, and it is named.
          A day before a strategy&apos;s rules were changed can differ for that alone. Signals of the last two minutes are left out, so the desk has had time to write them down.
        </p>
      </Panel>
      {r.strategies.length > 0 && (
        <Panel title={`Each strategy · ${r.strategies.length}`}>
          <ul aria-label="Each strategy" className="m-0 list-none p-0">{r.strategies.map((s) => <Strategy key={s.id} r={s} />)}</ul>
        </Panel>
      )}
      {r.days.length > 1 && (
        <Panel title="By expiry day">
          <table aria-label="By expiry day" className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-[0.5px] text-muted-foreground">
                <th scope="col" className="py-1 text-left font-medium">Expiry day</th>
                <th scope="col" className="py-1 text-right font-medium">Desk placed</th>
                <th scope="col" className="py-1 text-right font-medium">Backtest</th>
                <th scope="col" className="py-1 text-right font-medium">Same</th>
              </tr>
            </thead>
            <tbody>
              {[...r.days].reverse().map((d) => (
                <tr key={d.day} className="border-0 border-t border-solid border-[var(--line-soft)]">
                  <td className="py-1.5 text-left">{dayLabel(d.day)}</td>
                  <td className="py-1.5 text-right tabular-nums">{n(d.placed)}</td>
                  <td className="py-1.5 text-right tabular-nums">{n(d.backtest)}</td>
                  <td className={cn('py-1.5 text-right font-semibold tabular-nums', d.same === d.placed && d.same === d.backtest ? 'text-[var(--up)]' : '')}>{n(d.same)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}

export function LiveCheck({ now }: { now: number }) {
  const [days, setDays] = usePersisted<Days>('signalBacktest.live.days', 'today');
  const to = expiryDayOf(now);
  const range = { from: days === 'today' ? to : shiftDay(to, days === 'two' ? -1 : -6), to };
  // Asked again each minute: the desk writes a signal down as it comes, and the day in progress moves with it.
  const read = useAnswer(`${range.from}|${range.to}`, () => getLiveCheck(range), 60_000);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <Panel title="Which days">
        <Segmented dense label="Expiry days to check" value={DAYS.some((d) => d.key === days) ? days : 'today'} options={DAYS} onChange={setDays} />
        <p className="m-0 mt-1.5 px-1 text-[12px] leading-snug text-muted-foreground">An expiry day runs 5:30 PM to 5:30 PM IST; the strategies trade it from 9:30 PM.</p>
      </Panel>
      {!read.data
        ? <Panel><Loading error={read.error} what="the live check (each strategy is backtested: a moment the first time)" /></Panel>
        : <Updating busy={read.stale} what="the live check"><Result r={read.data} /></Updating>}
    </div>
  );
}
