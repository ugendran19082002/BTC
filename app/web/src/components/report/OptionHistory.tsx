import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { DateRangePicker, describeRange, type DateRangeValue } from '@/components/ui/date-range-picker';
import { Money } from '@/components/ui/money';
import { NumberField } from '@/components/ui/number-field';
import { Switch } from '@/components/ui/switch';
import { useTimeWindow } from '@/components/report/TimeWindow';
import { getOptionReplay, type OptionReplayQuery } from '@/api/option-replay';
import { usePoll } from '@/hooks/usePoll';
import { useSynced } from '@/hooks/useSynced';
import { contractLabel, inr, signedInr, usdToInr } from '@/lib/format';
import { downloadCsv, toCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';
import type { ActualExit, OptionReplay, OptionReplayRow, ReplayExit, ReplayGroup, ReplayRules, ReplaySide } from '@/types/option-replay';

/**
 * The option history (owner, 3 Nov 2026: "in the Methods menu, like the signal history, an option history -- the
 * option taken against each signal; skip perp SL and skip perp TGT, the option's SL and TGT, the time range, the date
 * range and the timeframe editable, user friendly -- to see whether it would have made a profit or a loss").
 *
 * Each line is a trade the desk really made: the option it really sold against a signal, at the price it really got.
 * Its exit is worked again by the server on that contract's recorded prices under the rules set here, and set beside
 * what really happened -- so a rule is judged on the desk's own trades, not on a backtest's guesses. Every choice is
 * remembered (`useSynced`); a rule typed is asked for half a second after the last key, and a rule that cannot be
 * replayed says why instead of asking.
 */

/** What the desk runs today: the perp's levels left out, a 250% option SL, a 90% option TGT (server: `LIVE_RULES`). */
export const LIVE_RULES: ReplayRules = { skipPerpSl: true, skipPerpTgt: true, stopPct: 2.5, targetPct: 0.9 };
export const TF_CHOICES: readonly { key: string; name: string }[] = [
  { key: '3m', name: '3m' }, { key: '5m', name: '5m' }, { key: '15m', name: '15m' }, { key: '30m', name: '30m' },
  { key: '1h', name: '1h' }, { key: '2h', name: '2h' }, { key: '4h', name: '4h' }, { key: 'chain', name: 'Chain' },
];
/** The server's limits (`REPLAY_MAX_DAYS`, `MAX_STOP_PCT`, `MAX_TARGET_PCT`), said before asking. */
const MAX_DAYS = 31;
const MAX_SL_PCT = 2_000;
const MAX_TGT_PCT = 99;
const DEBOUNCE_MS = 500;
const PAGE = 100;

export const REPLAY_EXIT_NAMES: Record<ReplayExit, string> = {
  'option-tgt': 'Option TGT', 'option-sl': 'Option SL', 'perp-sl': 'Perp SL', 'perp-tgt': 'Perp TGT', close: 'Held to 5:29 PM',
};
const ACTUAL_EXIT_NAMES: Record<ActualExit, string> = { 'option-tgt': 'Option TGT', 'option-sl': 'Option SL', desk: 'Desk close', other: 'Other' };

/** The expiry day running now: from 5:30 PM IST it is tomorrow's (the server's `sessionDayOf`). */
export const expiryDayNow = (now = Date.now()) => new Date(now + 12 * 3_600_000).toISOString().slice(0, 10);
const dayBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const daysIn = (r: DateRangeValue) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;

/** What is wrong with the rules as typed, in words; null when they can be asked for. */
export function rulesProblem(r: ReplayRules): string | null {
  if (!Number.isFinite(r.stopPct) || r.stopPct < 0 || r.stopPct * 100 > MAX_SL_PCT) return `Option SL must be 0 (none) to ${MAX_SL_PCT.toLocaleString('en-US')}%.`;
  if (!Number.isFinite(r.targetPct) || r.targetPct < 0 || r.targetPct * 100 > MAX_TGT_PCT) return `Option TGT must be 0 (none) to ${MAX_TGT_PCT}%.`;
  return null;
}

const sameRules = (a: ReplayRules, b: ReplayRules) =>
  a.skipPerpSl === b.skipPerpSl && a.skipPerpTgt === b.skipPerpTgt && a.stopPct === b.stopPct && a.targetPct === b.targetPct;
const winText = (s: ReplaySide) => (s.trades ? `${((100 * s.wins) / s.trades).toFixed(1)}%` : '—');
const toneOf = (usd: number) => (usd > 0 ? 'text-[var(--up)]' : usd < 0 ? 'text-[var(--down)]' : 'text-muted-foreground');
const rupees = (usd: number) => signedInr(usdToInr(usd));
const ist = (ms: number) => new Date(ms + 5.5 * 3_600_000);
const when = (ms: number | null) => {
  if (ms === null) return '—';
  const d = ist(ms);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const price = (n: number | null) => (n === null ? '—' : n.toFixed(n >= 100 ? 0 : 1));

/** Which trades the list shows, by what they make under the rules set: all, those in profit, those in loss -- or those the rules made better or worse. */
export type Show = 'all' | 'profit' | 'loss' | 'better' | 'worse';
const SHOWS: readonly { id: Show; name: string }[] = [
  { id: 'all', name: 'All' }, { id: 'profit', name: 'Profit' }, { id: 'loss', name: 'Loss' }, { id: 'better', name: 'Better' }, { id: 'worse', name: 'Worse' },
];
export const shows = (r: OptionReplayRow, show: Show): boolean =>
  show === 'all' ? true
    : show === 'profit' ? r.replay.netUsd > 0
      : show === 'loss' ? r.replay.netUsd < 0
        : show === 'better' ? r.replay.netUsd > r.actual.netUsd + 1e-9
          : r.replay.netUsd < r.actual.netUsd - 1e-9;

type GroupTab = 'days' | 'timeframes' | 'methods' | 'accounts';
const GROUP_TABS: readonly { id: GroupTab; name: string }[] = [
  { id: 'days', name: 'Days' }, { id: 'timeframes', name: 'Timeframes' }, { id: 'methods', name: 'Methods' }, { id: 'accounts', name: 'Accounts' },
];

/** Every trade shown, as a spreadsheet: what it was, what it did, and what it would have done. */
export function replayCsv(rows: readonly OptionReplayRow[]): string {
  return toCsv(rows, [
    { header: 'expiry_day', value: (r) => r.day },
    { header: 'entered_ist', value: (r) => ist(r.enteredAt).toISOString().slice(0, 16).replace('T', ' ') },
    { header: 'account', value: (r) => r.account },
    { header: 'strategy', value: (r) => r.strategyName },
    { header: 'timeframe', value: (r) => r.tf },
    { header: 'method', value: (r) => r.methodName },
    { header: 'side', value: (r) => r.side },
    { header: 'symbol', value: (r) => r.symbol },
    { header: 'contracts', value: (r) => r.contracts },
    { header: 'sold_at', value: (r) => r.entry },
    { header: 'perp_sl', value: (r) => r.perpSl },
    { header: 'perp_tgt', value: (r) => r.perpTgt },
    { header: 'actual_exit', value: (r) => r.actual.exit },
    { header: 'actual_why', value: (r) => r.actual.why },
    { header: 'actual_net_usd', value: (r) => Math.round(r.actual.netUsd * 10_000) / 10_000 },
    { header: 'replay_exit', value: (r) => r.replay.exit },
    { header: 'replay_why', value: (r) => r.replay.why },
    { header: 'replay_net_usd', value: (r) => Math.round(r.replay.netUsd * 10_000) / 10_000 },
  ]);
}

export function OptionHistory() {
  // Null: the last seven expiry days, rolling -- so the card never opens on a stale week.
  const [range, setRange] = useSynced<DateRangeValue | null>('optionHistory.range', null);
  const [tfs, setTfs] = useSynced<string[]>('optionHistory.tfs', []);
  const [rules, setRules] = useSynced<ReplayRules>('optionHistory.rules', LIVE_RULES);
  const [tab, setTab] = useSynced<GroupTab>('optionHistory.tab', 'days');
  const [show, setShow] = useSynced<Show>('optionHistory.show', 'all');
  const [oneContract, setOneContract] = useSynced<boolean>('optionHistory.oneContract', false);
  const { window: hours, whole, control: hoursControl } = useTimeWindow('optionHistory');
  const [day, setDay] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  // The rules as typed, and the ones asked for half a second after the last change.
  const [draft, setDraft] = useState<ReplayRules>(rules ?? LIVE_RULES);
  useEffect(() => { setDraft(rules ?? LIVE_RULES); }, [rules?.skipPerpSl, rules?.skipPerpTgt, rules?.stopPct, rules?.targetPct]); // eslint-disable-line react-hooks/exhaustive-deps
  const draftProblem = rulesProblem(draft);
  useEffect(() => {
    if (draftProblem || (rules && sameRules(draft, rules))) return;
    const t = setTimeout(() => setRules(draft), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, draftProblem]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = expiryDayNow();
  const span: DateRangeValue = range ?? { from: dayBefore(today, 6), to: today };
  const spanProblem = daysIn(span) > MAX_DAYS ? `At most ${MAX_DAYS} days at a time: pick a shorter range.` : null;
  const asked: OptionReplayQuery = useMemo(() => ({
    from: span.from, to: span.to, hours: whole ? null : hours, tfs: tfs ?? [], rules: rules ?? LIVE_RULES, oneContract: oneContract === true,
  }), [span.from, span.to, whole, hours.from, hours.to, (tfs ?? []).join(','), JSON.stringify(rules), oneContract]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = JSON.stringify(asked);
  const { data, error, loading, refresh } = usePoll(() => getOptionReplay(asked), 5 * 60_000, { deps: [key], enabled: spanProblem === null });
  useEffect(() => { setDay(null); setShown(PAGE); }, [key]);

  const toggleTf = (k: string) => {
    const now = tfs ?? [];
    setTfs(now.includes(k) ? now.filter((x) => x !== k) : TF_CHOICES.map((c) => c.key).filter((c) => c === k || now.includes(c)));
  };
  const asLive = sameRules(draft, LIVE_RULES);
  const period = `${range ? describeRange(span) : 'Last 7 days'}${whole ? '' : ` · ${hours.from}–${hours.to}`}`;

  const chip = (on: boolean, label: string, onClick: () => void, title?: string) => (
    <button
      key={label} type="button" aria-pressed={on} onClick={onClick} title={title}
      className={cn(
        'h-9 min-w-[44px] rounded-md border border-solid px-2.5 font-[inherit] text-[13px]',
        on ? 'border-[var(--accent)] bg-[var(--accent-fill)] font-semibold text-foreground' : 'border-border bg-transparent text-muted-foreground',
      )}
    >
      {label}
    </button>
  );

  const settings = (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      <section aria-label="Which trades" className="grid min-w-0 content-start gap-2 rounded-lg border border-solid border-border px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium">Expiry days</span>
          <span className="flex items-center gap-2">
            <DateRangePicker value={span} onChange={(v: DateRangeValue | null) => setRange(v)} />
            {range && (
              <button type="button" onClick={() => setRange(null)} className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
                Last 7 days
              </button>
            )}
          </span>
        </div>
        {spanProblem && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">{spanProblem}</p>}
        <div className="grid gap-1.5">
          <span className="text-[13px] font-medium">Timeframes <span className="font-normal text-muted-foreground">· none chosen is all</span></span>
          <div role="group" aria-label="Timeframes" className="flex flex-wrap gap-1.5">
            {chip((tfs ?? []).length === 0, 'All', () => setTfs([]))}
            {TF_CHOICES.map((c) => chip((tfs ?? []).includes(c.key), c.name, () => toggleTf(c.key), c.key === 'chain' ? 'The timeframe chain (the "all time" strategies)' : undefined))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <span className="text-[13px] font-medium">Size</span>
          <div role="group" aria-label="Size" className="flex flex-wrap gap-1.5">
            {chip(!oneContract, 'As traded', () => setOneContract(false), 'Each trade at the contracts it really had')}
            {chip(oneContract === true, '1 contract each', () => setOneContract(true), 'Every trade as one contract: a day of big lots does not outweigh the rest')}
          </div>
        </div>
        {hoursControl}
      </section>

      <section aria-label="Exit rules" className="grid min-w-0 content-start gap-1 rounded-lg border border-solid border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="text-[13px] font-medium">Exit rules <span className="font-normal text-muted-foreground">· worked again on each trade</span></span>
          {!asLive && (
            <button type="button" onClick={() => setDraft(LIVE_RULES)} className="min-h-[36px] shrink-0 border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
              As live
            </button>
          )}
        </div>
        <Switch
          label="Skip perp SL" checked={draft.skipPerpSl} onCheckedChange={(v) => setDraft((d) => ({ ...d, skipPerpSl: v }))}
          description={draft.skipPerpSl ? 'The perp reaching the signal\'s SL does not close the trade.' : 'The perp reaching the signal\'s SL buys the option back at once.'}
        />
        <Switch
          label="Skip perp TGT" checked={draft.skipPerpTgt} onCheckedChange={(v) => setDraft((d) => ({ ...d, skipPerpTgt: v }))}
          description={draft.skipPerpTgt ? 'The perp reaching the signal\'s TGT does not close the trade.' : 'The perp reaching the signal\'s TGT buys the option back at once.'}
        />
        <div className="grid grid-cols-2 gap-2 pt-1">
          <label className="grid min-w-0 gap-1 text-[12px] text-muted-foreground">
            Option SL
            <NumberField
              label="Option SL, per cent of the price sold" unit="%" decimals={1} invalid={draftProblem?.startsWith('Option SL') ?? false}
              value={Math.round(draft.stopPct * 1_000) / 10} onChange={(n) => setDraft((d) => ({ ...d, stopPct: n / 100 }))}
            />
          </label>
          <label className="grid min-w-0 gap-1 text-[12px] text-muted-foreground">
            Option TGT
            <NumberField
              label="Option TGT, per cent of the price sold" unit="%" decimals={1} invalid={draftProblem?.startsWith('Option TGT') ?? false}
              value={Math.round(draft.targetPct * 1_000) / 10} onChange={(n) => setDraft((d) => ({ ...d, targetPct: n / 100 }))}
            />
          </label>
        </div>
        <p role={draftProblem ? 'alert' : undefined} className={cn('m-0 text-[12px] leading-snug', draftProblem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
          {draftProblem ?? (
            <>
              {draft.stopPct > 0 ? `Bought back if the option rises ${Math.round(draft.stopPct * 100)}% (sold at 10, out at ${(10 * (1 + draft.stopPct)).toFixed(1)})` : 'No option SL'}
              {'; '}
              {draft.targetPct > 0 ? `bought back once ${Math.round(draft.targetPct * 100)}% has decayed (sold at 10, out at ${(10 * (1 - draft.targetPct)).toFixed(1)})` : 'no option TGT'}
              . Otherwise held to 5:29 PM. 0 is none.
            </>
          )}
        </p>
      </section>
    </div>
  );

  return (
    <section aria-label="Option history">
      <CollapsibleCard id="option-history" title="Option history" right={
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {period}{data ? ` · ${data.replay.trades.toLocaleString('en-US')} trades` : ''}
          <button type="button" aria-label="Refresh" onClick={() => void refresh()} className="grid h-8 w-8 place-items-center rounded-md border-0 bg-transparent text-muted-foreground">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
          </button>
        </span>
      }>
        <p className="mb-3 mt-0 text-[12.5px] leading-snug text-muted-foreground">
          The options the desk really sold against each signal, at the prices it really got. Each exit is worked again on
          that contract&apos;s recorded prices with the rules below, beside what really happened. After charges.
        </p>
        {settings}
        {error && !data && <p role="alert" className="mt-3 text-[13px] text-[var(--down)]">Could not load the option history: {error.message}</p>}
        {!data && !error && spanProblem === null && <p className="mt-3 text-[13px] text-muted-foreground">Working the trades again…</p>}
        {data && (
          <Results
            data={data} tab={tab ?? 'days'} onTab={setTab} show={show ?? 'all'} onShow={setShow}
            day={day} onDay={(d) => { setDay(d); setShown(PAGE); }} shown={shown} onMore={() => setShown((n) => n + PAGE)} stale={loading}
          />
        )}
      </CollapsibleCard>
    </section>
  );
}

function Results({ data, tab, onTab, show, onShow, day, onDay, shown, onMore, stale }: {
  data: OptionReplay; tab: GroupTab; onTab: (t: GroupTab) => void; show: Show; onShow: (s: Show) => void;
  day: string | null; onDay: (d: string | null) => void; shown: number; onMore: () => void; stale: boolean;
}) {
  const { actual: a, replay: r } = data;
  const change = r.netUsd - a.netUsd;
  const groups = data[tab];
  const rows = data.rows.filter((x) => (day === null || x.day === day) && shows(x, show));
  const left = [data.noPrices > 0 && `${data.noPrices} without recorded prices`, data.open > 0 && `${data.open} still open`].filter(Boolean);

  const side = (label: string, s: ReplaySide, strong: boolean) => (
    <div className={cn('grid min-w-0 gap-1 rounded-md border border-solid px-3 py-2', strong ? 'border-[var(--accent)]' : 'border-border')}>
      <span className="text-[10.5px] uppercase tracking-[0.6px] text-muted-foreground">{label}</span>
      <Money value={s.netUsd} signed strong />
      <span className="text-[12px] tabular-nums text-muted-foreground">
        <span className="text-[var(--up)]">{s.wins}</span> won · <span className="text-[var(--down)]">{s.losses}</span> lost · {winText(s)}
      </span>
      <span className="text-[12px] tabular-nums text-muted-foreground">
        Profit <span className="text-[var(--up)]">{rupees(s.profitUsd)}</span> · Loss <span className="text-[var(--down)]">{rupees(-s.lossUsd)}</span>
      </span>
    </div>
  );

  return (
    <div className={cn('mt-3 grid min-w-0 gap-3', stale && 'opacity-70')} aria-busy={stale}>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        {side('As traded', a, false)}
        {side('With these rules', r, true)}
        <div className="grid min-w-0 content-start gap-1 rounded-md border border-solid border-border px-3 py-2">
          <span className="text-[10.5px] uppercase tracking-[0.6px] text-muted-foreground">Change</span>
          <span className={cn('text-[15px] font-semibold tabular-nums', toneOf(change))}>{rupees(change)}</span>
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {r.lossUsd === a.lossUsd ? 'Loss the same' : `Loss ${inr(usdToInr(Math.abs(a.lossUsd - r.lossUsd)))} ${r.lossUsd < a.lossUsd ? 'smaller' : 'bigger'}`}
            {' · '}Profit {r.profitUsd === a.profitUsd ? 'the same' : `${inr(usdToInr(Math.abs(r.profitUsd - a.profitUsd)))} ${r.profitUsd > a.profitUsd ? 'bigger' : 'smaller'}`}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[12px]" aria-label="How the replay closed them">
        {(Object.keys(REPLAY_EXIT_NAMES) as ReplayExit[]).filter((k) => data.exits[k] > 0).map((k) => (
          <span key={k} className="rounded-md border border-solid border-border px-2 py-1 tabular-nums text-muted-foreground">
            {REPLAY_EXIT_NAMES[k]} <span className="font-semibold text-foreground">{data.exits[k].toLocaleString('en-US')}</span>
          </span>
        ))}
        {left.length > 0 && <span className="px-1 py-1 text-muted-foreground">Left out: {left.join(', ')}.</span>}
      </div>

      <div className="min-w-0">
        <div role="tablist" aria-label="Group by" className="mb-2 flex flex-wrap gap-1.5">
          {GROUP_TABS.map((t) => (
            <button
              key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)}
              className={cn('h-9 rounded-md border border-solid px-3 font-[inherit] text-[13px]', tab === t.id ? 'border-[var(--accent)] font-semibold text-foreground' : 'border-border bg-transparent text-muted-foreground')}
            >
              {t.name}
            </button>
          ))}
        </div>
        <GroupTable groups={groups} tab={tab} day={day} onDay={onDay} />
      </div>

      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Show trades" className="flex flex-wrap gap-1.5">
            {SHOWS.map((s) => (
              <button
                key={s.id} type="button" aria-pressed={show === s.id} onClick={() => onShow(s.id)}
                className={cn('h-9 rounded-md border border-solid px-3 font-[inherit] text-[13px]', show === s.id ? 'border-[var(--accent)] font-semibold text-foreground' : 'border-border bg-transparent text-muted-foreground')}
              >
                {s.name}
              </button>
            ))}
          </div>
          <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
            {day && (
              <button type="button" onClick={() => onDay(null)} className="min-h-[36px] border-0 bg-transparent p-0 font-[inherit] text-[13px] text-[var(--accent)]">
                {day} ✕
              </button>
            )}
            <button
              type="button" onClick={() => downloadCsv(`option-history-${data.from}-to-${data.to}.csv`, replayCsv(rows))}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-solid border-border bg-transparent px-2.5 font-[inherit] text-[13px] text-foreground"
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> CSV
            </button>
          </span>
        </div>
        {data.rowsCut && <p className="mb-2 mt-0 text-[12px] text-muted-foreground">The list holds the newest {data.rows.length.toLocaleString('en-US')} trades; the totals above count every one. Pick a shorter range to see the rest.</p>}
        <TradeTable rows={rows.slice(0, shown)} />
        {rows.length > shown && (
          <button type="button" onClick={onMore} className="mt-2 h-10 w-full rounded-md border border-solid border-border bg-transparent font-[inherit] text-[13px] text-foreground">
            Show more ({(rows.length - shown).toLocaleString('en-US')} left)
          </button>
        )}
      </div>
    </div>
  );
}

function GroupTable({ groups, tab, day, onDay }: { groups: readonly ReplayGroup[]; tab: GroupTab; day: string | null; onDay: (d: string | null) => void }) {
  const head = (s: string, left = false) => <th className={cn('whitespace-nowrap px-2 py-1.5 text-[11px] font-medium text-muted-foreground', left ? 'text-left' : 'text-right')}>{s}</th>;
  const total = groups.reduce((t, g) => ({ trades: t.trades + g.trades, a: t.a + g.actual.netUsd, r: t.r + g.replay.netUsd }), { trades: 0, a: 0, r: 0 });
  return (
    <div className="max-h-[50vh] overflow-auto rounded-md border border-solid border-border">
      <table aria-label={`By ${tab}`} className="w-full min-w-[560px] border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-[var(--panel)]">
          <tr>{head(tab === 'days' ? 'Expiry day' : tab === 'timeframes' ? 'Timeframe' : tab === 'methods' ? 'Method' : 'Account', true)}{head('Trades')}{head('Win % traded → rules')}{head('As traded')}{head('With rules')}{head('Change')}</tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const c = g.replay.netUsd - g.actual.netUsd;
            const pick = tab === 'days';
            return (
              <tr
                key={g.key} onClick={pick ? () => onDay(day === g.key ? null : g.key) : undefined}
                className={cn('border-t border-border', pick && 'cursor-pointer hover:bg-[var(--panel)]', pick && day === g.key && 'bg-[var(--panel)] font-semibold')}
                aria-selected={pick ? day === g.key : undefined}
              >
                <td className="max-w-[16rem] truncate px-2 py-1 text-left" title={g.name}>{g.name}</td>
                <td className="px-2 py-1 text-right tabular-nums">{g.trades.toLocaleString('en-US')}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{winText(g.actual)} → {winText(g.replay)}</td>
                <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(g.actual.netUsd))}>{rupees(g.actual.netUsd)}</td>
                <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(g.replay.netUsd))}>{rupees(g.replay.netUsd)}</td>
                <td className={cn('px-2 py-1 text-right font-semibold tabular-nums', toneOf(c))}>{rupees(c)}</td>
              </tr>
            );
          })}
          {groups.length === 0 && <tr><td colSpan={6} className="px-2 py-3 text-center text-muted-foreground">No trades here.</td></tr>}
        </tbody>
        <tfoot className="bg-[var(--panel)] font-semibold">
          <tr className="border-t border-border">
            <td className="px-2 py-1 text-left">Total</td>
            <td className="px-2 py-1 text-right tabular-nums">{total.trades.toLocaleString('en-US')}</td>
            <td />
            <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(total.a))}>{rupees(total.a)}</td>
            <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(total.r))}>{rupees(total.r)}</td>
            <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(total.r - total.a))}>{rupees(total.r - total.a)}</td>
          </tr>
        </tfoot>
      </table>
      {tab === 'days' && groups.length > 0 && <p className="m-0 border-t border-border px-2 py-1.5 text-[11.5px] text-muted-foreground">Tap a day to list its trades.</p>}
    </div>
  );
}

function TradeTable({ rows }: { rows: readonly OptionReplayRow[] }) {
  const head = (s: string, left = false) => <th className={cn('whitespace-nowrap px-2 py-1.5 text-[11px] font-medium text-muted-foreground', left ? 'text-left' : 'text-right')}>{s}</th>;
  return (
    <div className="max-h-[70vh] overflow-auto rounded-md border border-solid border-border">
      <table aria-label="Trades" className="w-full min-w-[900px] border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-[var(--panel)]">
          <tr>
            {head('Entered', true)}{head('TF', true)}{head('Method', true)}{head('Option', true)}{head('Sold at')}
            {head('As traded', true)}{head('Net')}{head('With rules', true)}{head('Net')}{head('Change')}
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => {
            const c = x.replay.netUsd - x.actual.netUsd;
            return (
              <tr key={x.tradeId} className="border-t border-border">
                <td className="whitespace-nowrap px-2 py-1 text-left tabular-nums">{when(x.enteredAt)}</td>
                <td className="px-2 py-1 text-left">{x.tf === 'chain' ? 'Chain' : x.tf}</td>
                <td className="max-w-[12rem] truncate px-2 py-1 text-left" title={x.strategyName ? `${x.methodName} · ${x.strategyName}` : x.methodName}>{x.methodName}</td>
                <td className="whitespace-nowrap px-2 py-1 text-left">
                  <span className={x.side === 'CE' ? 'text-[var(--down)]' : 'text-[var(--up)]'}>{x.side}</span> {contractLabel(x.symbol)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{price(x.entry)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-left text-muted-foreground">{ACTUAL_EXIT_NAMES[x.actual.why]} · {price(x.actual.exit)}</td>
                <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(x.actual.netUsd))}>{rupees(x.actual.netUsd)}</td>
                <td className="whitespace-nowrap px-2 py-1 text-left" title={`Out ${when(x.replay.exitAt)}`}>{REPLAY_EXIT_NAMES[x.replay.why]} · {price(x.replay.exit)}</td>
                <td className={cn('px-2 py-1 text-right tabular-nums', toneOf(x.replay.netUsd))}>{rupees(x.replay.netUsd)}</td>
                <td className={cn('px-2 py-1 text-right font-semibold tabular-nums', toneOf(c))}>{Math.abs(c) < 1e-9 ? '—' : rupees(c)}</td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={10} className="px-2 py-3 text-center text-muted-foreground">No trades match.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
