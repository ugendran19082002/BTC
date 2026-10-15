import { pct } from '@/lib/format';
import { dayLabel, moneyText, timeIst } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { LiveCheck as Check, LiveCheckCount, LiveCheckFate, LiveCheckRow, LiveCheckWhy } from '@/types/signal-backtest';
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

/** The seven columns of a side's fate: what it took, and each way a signal was not taken. */
/** Each column, with a short label for a phone's 40-pixel column (15 Oct 2026: "Rejected" ran into "Expired" at 360px). */
const FATE_COLS: { key: keyof LiveCheckFate; label: string; short: string; hint: string; desk?: boolean }[] = [
  { key: 'taken', label: 'Taken', short: 'Taken', hint: 'Entered: the order filled (the desk), or the trade made (the backtest)' },
  { key: 'notTaken', label: 'Not taken', short: 'Not', hint: 'Every signal of its methods not entered: the columns to the right, added' },
  { key: 'skipped', label: 'Skipped', short: 'Skip', hint: 'Left by the rules: its hours, SL / TGT distance, at its most open, no strike' },
  { key: 'refused', label: 'Refused', short: 'Ref.', hint: 'Turned down at the desk\'s own gate: the daily loss limit, margin, a limit on open trades', desk: true },
  { key: 'rejected', label: 'Rejected', short: 'Rej.', hint: 'Sent, and rejected by Delta', desk: true },
  { key: 'expired', label: 'Expired', short: 'Exp.', hint: 'Sent, and its wait ran out with nothing filled', desk: true },
];

/** One side's row: its counts, with a dash where the column is not a thing that side can do. */
function FateRow({ side, fate, desk }: { side: string; fate: LiveCheckFate; desk: boolean }) {
  return (
    <tr>
      <th scope="row" className="whitespace-normal py-0.5 text-left text-[12px] font-medium normal-case leading-tight tracking-normal text-muted-foreground">{side}</th>
      {FATE_COLS.map((c) => (
        <td key={c.key} className={cn('py-0.5 pl-1 text-right tabular-nums', c.key === 'taken' ? 'font-semibold text-foreground' : c.desk && desk && fate[c.key] > 0 ? 'text-[var(--warn)]' : '')}>
          {c.desk && !desk ? <span className="text-muted-foreground">—</span> : count(fate[c.key])}
          {c.key === 'taken' && fate.waiting > 0 && <span className="block text-[10.5px] font-normal text-muted-foreground">{count(fate.waiting)} waiting</span>}
        </td>
      ))}
    </tr>
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

/** "12 lots", "12 or 16 lots", "1 to 12 lots": the lots orders were sold with, in words. */
const lotsWords = (xs: readonly number[]) => {
  const lots = (n: number) => `lot${n === 1 ? '' : 's'}`;
  if (xs.length === 1) return `${count(xs[0]!)} ${lots(xs[0]!)}`;
  if (xs.length === 2) return `${count(xs[0]!)} or ${count(xs[1]!)} lots`;
  return `${count(xs[0]!)} to ${count(xs[xs.length - 1]!)} lots`;
};
/** "+300%", "none, +160% or +300%": the option stops orders were sold with. */
const stopWords = (xs: readonly number[]) => {
  const one = (x: number) => (x > 0 ? `+${Math.round(x * 100)}%` : 'none');
  const w = xs.map(one);
  return w.length === 1 ? w[0]! : `${w.slice(0, -1).join(', ')} or ${w[w.length - 1]}`;
};

/**
 * The desk sold with other settings then (14 Oct 2026 audit): the backtest replays every day by the rules as they
 * stand now, so where the lots or the option stop have changed since, its money is not what the desk made -- said
 * out loud rather than left to look like a calculation gone wrong.
 */
export function rulesThenWords(x: NonNullable<LiveCheckRow['rulesThen']>): string {
  return `The desk's ${count(x.orders)} order${x.orders === 1 ? ' was' : 's were'} sold with ${lotsWords(x.lots)} and an option stop of ${stopWords(x.stopPct)}; `
    + `this backtest uses the strategy as it is now: ${lotsWords([x.now.lots])}, option stop ${stopWords([x.now.stopPct])}. Its money is by today's settings, not what the desk made.`;
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
      {r.rulesThen && <p className="m-0 rounded-md bg-[var(--chosen-soft)] px-2 py-1 text-[12.5px] leading-snug text-foreground">{rulesThenWords(r.rulesThen)}</p>}
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
  // Each side's own, added up across the rows: a strategy's against the desk, a saved backtest's against the live rules.
  const deskOnly = merged([...r.liveOnly, ...r.strategies.flatMap((x) => x.liveOnly)]);
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
          {/* Settings changed since the desk traded: the decisions are compared, but the money cannot be (14 Oct 2026 audit). */}
          {r.strategies.some((x) => x.rulesThen) && (
            <p aria-label="Settings changed since" className="m-0 rounded-md bg-[var(--chosen-soft)] px-3 py-2 text-[12.5px] leading-snug text-foreground">
              {r.strategies.length === 1
                // One strategy: its own words here, as there is no list of strategies below to name it in.
                ? rulesThenWords(r.strategies[0]!.rulesThen!)
                : <>
                  {(() => { const n = r.strategies.filter((x) => x.rulesThen).length; return `${n} strateg${n === 1 ? 'y was' : 'ies were'} traded with other lots or another stop than ${n === 1 ? 'it has' : 'they have'} now`; })()}
                  {' '}-- the backtest uses today&apos;s settings, so its money is not what the desk made. Each one is named under &ldquo;Each strategy&rdquo; below.
                </>}
            </p>
          )}

          {/*
            What became of the signals on each side, day by day (owner, 14 Oct 2026: "taken, not taken, skipped, refused,
            rejected, expired -- columns, in the live check and the backtest"). Two rows a day -- the desk (or the live
            rules) and the backtest -- under the same seven columns, and a line for the same signals and the money.
            Refused, rejected and expired are the desk's alone: the backtest has no gate of the account's and fills
            every order it decides on, so its cells there are a dash, not a zero.
          */}
          <table aria-label="Live check by expiry day" className="w-full table-fixed border-collapse text-[12.5px]">
            <colgroup><col className="w-[19%]" /><col /><col /><col /><col /><col /><col /></colgroup>
            <thead>
              <tr className="text-[10.5px] uppercase tracking-[0.4px] text-muted-foreground">
                <th scope="col" className="py-1 text-left font-medium"><span className="sr-only">Side</span></th>
                {FATE_COLS.map((c) => (
                  <th key={c.key} scope="col" aria-label={c.label} className="whitespace-normal py-1 pl-1 text-right align-bottom font-medium leading-tight" title={c.hint}>
                    {/* The whole word from a tablet up, a short one in a phone's narrow column; read out as the whole word. */}
                    <span aria-hidden className="max-sm:hidden">{c.label}</span>
                    <span aria-hidden className="sm:hidden">{c.short}</span>
                  </th>
                ))}
              </tr>
            </thead>
            {[{ day: 'all', label: `All ${days.length} day${days.length === 1 ? '' : 's'}`, fate: r.fate, same: t.same, extraBt: t.backtestOnly, extraLive: t.liveOnly, bt: r.money.backtest, real: r.money.real }, ...days.map((d) => ({
              day: d.day, label: `${dayLabel(d.day)}${d.live ? ' · so far' : ''}`, fate: d.fate, same: d.same, extraBt: d.backtest - d.same, extraLive: d.placed - d.same, bt: d.bt, real: d.real,
            }))].filter((_, i) => i > 0 || days.length > 1).map((x) => (
              <tbody key={x.day} aria-label={x.label} className="border-0 border-t border-solid border-[var(--line-soft)]">
                <tr><th scope="rowgroup" colSpan={7} className="pb-0.5 pt-2 text-left text-[13px] font-semibold normal-case tracking-normal text-foreground">{x.label}</th></tr>
                <FateRow side={them} fate={x.fate.live} desk={!saved} />
                <FateRow side="Backtest" fate={x.fate.backtest} desk={false} />
                <tr>
                  {/* Wrapped, never wider than the phone: the desk's tables are nowrap by default. */}
                  <td colSpan={7} className="whitespace-normal pb-2 pt-0.5 text-[12px] leading-snug">
                    <span className={cn('font-semibold', x.extraBt === 0 && x.extraLive === 0 && x.same > 0 ? 'text-[var(--up)]' : 'text-foreground')}>Same signal {count(x.same)}</span>
                    {x.extraBt === 0 && x.extraLive === 0 ? (x.same > 0 ? <span className="text-[var(--up)]"> · all match</span> : null) : <>
                      {x.extraBt > 0 && <span className="text-[var(--warn)]"> · +{count(x.extraBt)} backtest</span>}
                      {x.extraLive > 0 && <span className="text-[var(--warn)]"> · +{count(x.extraLive)} {saved ? 'live' : 'desk'}</span>}
                    </>}
                    {(x.bt.n > 0 || (x.real && x.real.n > 0)) && (
                      <span className="block text-muted-foreground">
                        {x.bt.n > 0 && <>Backtest <span className={netClass(x.bt.net)}>{moneyText(x.bt.net)}</span>, won {pct(rate(x.bt), 0)}</>}
                        {x.real && x.real.n > 0 && <>{x.bt.n > 0 ? ' · ' : ''}live rules <span className={netClass(x.real.net)}>{moneyText(x.real.net)}</span></>}
                      </span>
                    )}
                  </td>
                </tr>
              </tbody>
            ))}
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
