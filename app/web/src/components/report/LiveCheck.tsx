import { pct } from '@/lib/format';
import { dayLabel, moneyText, timeIst } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { LiveCheck as Check, LiveCheckCount, LiveCheckMoney, LiveCheckRow, LiveCheckWhy } from '@/types/signal-backtest';
import { Empty, Loading, Panel } from '@/components/mobile/parts';
import { Updating, useAnswer } from '@/components/report/Updating';
import { count, netClass, rate } from '@/components/report/backtest-parts';

/**
 * The live check, inside a backtest's result and a portfolio's (owner, 14 Oct 2026: "the real trades since 9:30
 * last night and the backtest's do not match in number -- check the calculation"; then "bring it inside the
 * backtest and the portfolio, no tab of its own -- a table that compares them is enough").
 *
 * A table like the result's own "By expiry day", with the desk beside the backtest: for each expiry day the desk's
 * orders and the backtest's trades -- how many, how many won, what they made -- and how many are the same signal
 * on both sides. Two counts that differ are not a wrong calculation until it is known which signals differ and
 * why, so under the table every signal on one side only is listed by its reason, in the desk's own words for one
 * it refused or skipped. A range on which the two agree says so in one line.
 */

const side = (dir: 1 | -1) => (dir === 1 ? 'BUY' : 'SELL');
const stamp = (ms: number) => `${dayLabel(new Date(ms + 19_800_000).toISOString().slice(0, 10)).split(' ').slice(1).join(' ')}, ${timeIst(ms)}`;
const total = (xs: { n: number }[]) => xs.reduce((a, x) => a + x.n, 0);

/** One side of a day: the count, how many of the closed made money, and what they made after charges. */
function Cell({ n, money, note }: { n: number; money: LiveCheckMoney | null; note?: string }) {
  return (
    <>
      <span className="block text-[14px] font-semibold tabular-nums">{count(n)}</span>
      {money && money.n > 0 && <span className={cn('block whitespace-nowrap text-[12px] font-semibold tabular-nums', netClass(money.net))}>{moneyText(money.net)}</span>}
      {money && money.n > 0 && <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">won {pct(rate(money), 0)}</span>}
      {note && <span className="block whitespace-nowrap text-[11.5px] text-muted-foreground">{note}</span>}
    </>
  );
}

function Reasons({ label, items, tone = 'dim' }: { label: string; items: LiveCheckCount[]; tone?: 'warn' | 'dim' }) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[12px] text-muted-foreground">{label}</div>
      <ul aria-label={label} className="m-0 grid list-none gap-1 p-0">
        {items.map((x) => (
          <li key={x.why} className="flex items-baseline gap-2 text-[13px] leading-snug">
            <b className={cn('min-w-[2.5rem] flex-none text-right tabular-nums', tone === 'warn' ? 'text-[var(--warn)]' : 'text-foreground')}>{count(x.n)}</b>
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
    <div className="min-w-0">
      <div className="mb-1 text-[12px] text-muted-foreground">{label} · {count(total(groups))}</div>
      <ul aria-label={label} className="m-0 grid list-none gap-1.5 p-0">
        {groups.map((g) => (
          <li key={g.why} className="rounded-md border border-[var(--line-soft)] px-2.5 py-1.5 text-[13px] leading-snug">
            <span><b className="tabular-nums text-[var(--warn)]">{count(g.n)}</b> &mdash; {g.why}</span>
            <span className="block text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
              {g.first.map((s) => `${stamp(s.at)} · ${s.method} · ${s.tf === 'chain' ? 'TF chain' : s.tf} · ${side(s.dir)}`).join('  |  ')}{g.n > g.first.length ? `  |  and ${count(g.n - g.first.length)} more` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What is set apart, in a few words: "3 backtest trades the desk has no record of · 1 desk order outside the rules as they stand". */
function apartWords(r: Check): string {
  const n = r.notCompared;
  return [
    n.backtest > 0 ? `${count(n.backtest)} backtest trade${n.backtest === 1 ? '' : 's'} of signals the desk has no record of` : null,
    n.desk > 0 ? `${count(n.desk)} desk order${n.desk === 1 ? '' : 's'} outside the rules as they stand now` : null,
  ].filter(Boolean).join(' · ');
}

/** The same reason under several rows, added up: what the whole comparison differs by. */
function merged(groups: LiveCheckWhy[]): LiveCheckWhy[] {
  const m = new Map<string, LiveCheckWhy>();
  for (const g of groups) {
    const h = m.get(g.why);
    if (h) { h.n += g.n; h.first = [...h.first, ...g.first].slice(0, 3); } else m.set(g.why, { ...g, first: [...g.first] });
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.why.localeCompare(b.why));
}

function Row({ r, saved }: { r: LiveCheckRow; saved: boolean }) {
  const differ = total(r.backtestOnly) + total(r.liveOnly);
  const notTraded = total(r.backtestSkipped);
  return (
    <li aria-label={r.name} className="grid min-w-0 gap-1 border-0 border-t border-solid border-[var(--line-soft)] py-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[13.5px] font-semibold [overflow-wrap:anywhere]">{r.name}{r.account ? <span className="font-normal text-muted-foreground"> · {r.account}</span> : null}</span>
        <span className={cn('text-[12.5px] font-medium', differ === 0 ? 'text-[var(--up)]' : 'text-[var(--warn)]')}>{differ === 0 ? 'Matches' : `${count(differ)} differ`}</span>
      </div>
      <p className="m-0 text-[12.5px] tabular-nums text-muted-foreground">
        {!saved && <>Desk <b className="text-foreground">{count(r.live.placed)}</b> placed · {count(r.live.refused)} refused · {count(r.live.skipped)} skipped · </>}
        Backtest <b className="text-foreground">{count(r.backtest)}</b> traded · {count(notTraded)} not traded · same signal <b className="text-foreground">{count(r.same)}</b>
      </p>
      {r.backtestOnly.map((g) => <p key={`b${g.why}`} className="m-0 text-[12.5px] leading-snug"><b className="tabular-nums text-[var(--warn)]">{count(g.n)}</b> in the backtest only &mdash; {g.why}</p>)}
      {r.liveOnly.map((g) => <p key={`l${g.why}`} className="m-0 text-[12.5px] leading-snug"><b className="tabular-nums text-[var(--warn)]">{count(g.n)}</b> on the desk only &mdash; {g.why}</p>)}
    </li>
  );
}

export function LiveCheckResult({ r }: { r: Check }) {
  const t = r.total;
  const differ = t.backtestOnly + t.liveOnly;
  const saved = r.against.kind === 'portfolio';
  const nothing = t.placed + t.refused + t.skipped + t.backtest === 0;
  const days = [...r.days].filter((d) => d.placed + d.backtest > 0).reverse();
  // The other side: the desk's own decisions for a strategy, or the live rules run with these settings.
  const them = saved ? 'Live rules' : 'Desk';
  const apart = r.notCompared.backtest + r.notCompared.desk;
  const latest = days[0] ?? null;
  const backtestOnly = merged(r.strategies.flatMap((x) => x.backtestOnly));
  const deskOnly = saved ? r.liveOnly : merged(r.strategies.flatMap((x) => x.liveOnly));
  return (
    <Panel title={saved ? 'Live check · the live rules with these settings' : 'Live check · the desk beside this backtest'}>
      {nothing ? <Empty>{apart > 0 ? `Nothing to compare in these days: ${apartWords(r)}.` : 'The desk has no order, and the backtest no trade, in these days.'}</Empty> : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
          {latest && days.length > 1 && (
            <p aria-label="The latest expiry day" className="m-0 text-[13.5px] leading-snug">
              <b>{dayLabel(latest.day)}{latest.live ? ', so far' : ''}:</b> {saved ? 'the live rules take' : 'the desk placed'} <b>{count(latest.placed)}</b>, the backtest makes <b>{count(latest.backtest)}</b>, <b className={latest.same === latest.placed && latest.same === latest.backtest ? 'text-[var(--up)]' : ''}>{count(latest.same)}</b> the same signal.
              {' '}Over all {days.length} days:
            </p>
          )}
          <p role="status" aria-label="Whether they match" className={cn('m-0 rounded-md px-3 py-2 text-[14px] font-medium leading-snug', differ === 0 ? 'bg-[rgba(38,161,123,0.14)] text-[var(--up)]' : 'bg-[var(--chosen-soft)] text-foreground')}>
            {differ === 0
              ? (saved
                ? `They match: the live rules with these settings take the same ${count(t.backtest)} trades as the backtest${r.money.real && Math.abs(r.money.real.net - r.money.backtest.net) < 0.005 ? ', and make the same money' : ''}.`
                : `They match: all ${count(t.placed)} orders the desk placed are trades in the backtest, and the backtest has no other.`)
              : <>
                {saved ? 'The live rules take' : 'The desk placed'} <b>{count(t.placed)}</b>{saved ? ' trades' : ' orders'}, the backtest makes <b>{count(t.backtest)}</b> trades: <b>{count(t.same)}</b> are the same signal.
                {t.backtestOnly > 0 && <> <b>{count(t.backtestOnly)}</b> are in the backtest only.</>}
                {t.liveOnly > 0 && <> <b>{count(t.liveOnly)}</b> are {saved ? 'the live rules\'' : 'on the desk'} only.</>}
                {' '}Why is under the table.
              </>}
          </p>
          {apart > 0 && <p aria-label="Not compared" className="m-0 text-[12.5px] leading-snug text-muted-foreground">Not compared: {apartWords(r)}.</p>}

          {/* Four plain columns, each cell its lines stacked: what a 360px phone holds without folding anything away. */}
          <table aria-label="Live check by expiry day" className="w-full table-fixed border-collapse text-[13px]">
            <colgroup><col className="w-[30%]" /><col className="w-[24%]" /><col className="w-[24%]" /><col className="w-[22%]" /></colgroup>
            <thead>
              <tr className="text-[11px] uppercase tracking-[0.5px] text-muted-foreground">
                <th scope="col" className="py-1 pr-1 text-left font-medium">Expiry day</th>
                <th scope="col" className="py-1 pr-1 text-right font-medium">{them}</th>
                <th scope="col" className="py-1 pr-1 text-right font-medium">Backtest</th>
                <th scope="col" className="py-1 text-right font-medium">Same</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const extraBt = d.backtest - d.same, extraDesk = d.placed - d.same;
                const all = extraBt === 0 && extraDesk === 0;
                return (
                  <tr key={d.day} className="border-0 border-t border-solid border-[var(--line-soft)] align-top">
                    <th scope="row" className="py-2 pr-1 text-left text-[13px] font-semibold normal-case tracking-normal text-foreground">
                      {dayLabel(d.day)}
                      {d.live && <span className="block text-[11.5px] font-normal text-muted-foreground">so far</span>}
                    </th>
                    <td className="py-2 pr-1 text-right"><Cell n={d.placed} money={d.real} /></td>
                    <td className="py-2 pr-1 text-right"><Cell n={d.backtest} money={d.bt} /></td>
                    <td className="py-2 text-right">
                      <span className={cn('block text-[14px] font-semibold tabular-nums', all && d.same > 0 ? 'text-[var(--up)]' : '')}>{count(d.same)}</span>
                      {all ? (d.same > 0 && <span className="block text-[11.5px] text-[var(--up)]">all match</span>) : <>
                        {extraBt > 0 && <span className="block whitespace-nowrap text-[11.5px] text-[var(--warn)]">+{count(extraBt)} backtest</span>}
                        {extraDesk > 0 && <span className="block whitespace-nowrap text-[11.5px] text-[var(--warn)]">+{count(extraDesk)} {saved ? 'live' : 'desk'}</span>}
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="m-0 text-[12px] leading-snug text-muted-foreground">
            {saved
              ? 'Live rules: the trades the desk\'s own rules make with these settings, on the same signals, under the same limit. Backtest: this backtest\'s trades. Same: signals both trade.'
              : <>Desk: the orders it decided to place on signals of this strategy &mdash; its decisions, not their fills. Backtest: the trades this backtest makes of the same signals. Same: signals that are both.
                {r.liveFrom !== null && r.liveTo !== null ? <> The desk&apos;s record runs {stamp(r.liveFrom)} → {stamp(r.liveTo)} IST.</> : ' The desk has no record of signals in these days.'}</>}
          </p>

          {(differ > 0 || t.refused + t.skipped > 0) && (
            <details open={differ > 0} className="min-w-0">
              <summary className="min-h-[36px] cursor-pointer py-1.5 text-[13px] font-semibold">Why they differ{differ > 0 ? ` · ${count(differ)}` : ' · nothing does'}</summary>
              <div className="grid gap-3 pt-1">
                <OneSide label="In the backtest only" groups={backtestOnly} />
                <OneSide label={saved ? 'The live rules only' : 'On the desk only'} groups={deskOnly} />
                <OneSide label="Not compared: the backtest's" groups={r.notComparedWhy.backtest} />
                <OneSide label="Not compared: the desk's" groups={r.notComparedWhy.desk} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Reasons label={`The desk refused · ${count(t.refused)}`} items={r.liveWhy.refused} tone="warn" />
                  <Reasons label={`The desk skipped · ${count(t.skipped)}`} items={r.liveWhy.skipped} />
                </div>
              </div>
            </details>
          )}

          {r.strategies.length > 1 && (
            <details className="min-w-0">
              <summary className="min-h-[36px] cursor-pointer py-1.5 text-[13px] font-semibold">{saved ? 'Each saved backtest' : 'Each strategy'} · {r.strategies.length}</summary>
              <ul aria-label={saved ? 'Each saved backtest' : 'Each strategy'} className="m-0 list-none p-0 pt-1">{r.strategies.map((x) => <Row key={x.id} r={x} saved={saved} />)}</ul>
            </details>
          )}

          <p className="m-0 text-[12px] leading-snug text-muted-foreground">
            {saved
              ? 'Each saved backtest\'s settings are run as the strategy the desk would run with them -- its hours, strike rule, lots, target and stop, premium floor and SL / TGT range -- through the same rules the desk trades by, and compared signal for signal. Where they differ, the backtest is not doing what the desk would.'
              : 'The strategy is backtested by its own rules as they stand now, beside its account\'s other strategies and under that account\'s limit, as the desk holds them, and laid beside what the desk decided with each signal. A signal the desk has no record of, and an order outside the strategy\'s rules as they stand, are set apart rather than counted.'}
            {' '}The backtest replays the rules, not the account: a refusal by the daily loss limit or by margin is the desk&apos;s &mdash; a difference there is expected, and it is named.
          </p>
        </div>
      )}
    </Panel>
  );
}

/** The check, asked with the result it stands under and again each minute: the desk writes a signal down as it comes. */
export function LiveCheck({ askKey, read }: { askKey: string; read: () => Promise<Check> }) {
  const answer = useAnswer(`live|${askKey}`, read, 60_000);
  if (!answer.data) return <Panel title="Live check · the desk beside this backtest"><Loading error={answer.error} what="the live check" /></Panel>;
  return <Updating busy={answer.stale} what="the live check"><LiveCheckResult r={answer.data} /></Updating>;
}
