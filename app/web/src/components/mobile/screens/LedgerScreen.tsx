import { useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { getLedger, syncLedger, type LedgerDay, type LedgerStatus } from '@/api/ledger';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { signedInr, stamp, usdToInr } from '@/lib/format';
import { dayLabel } from '@/lib/market-report';
import { daysAgoIst, todayIst } from '@/lib/report';
import { cn } from '@/lib/utils';
import { usePhoneData } from '@/components/mobile/phone-context';
import { Empty, Loading, Panel, Pill, Rupees, Segmented, Stat, Stats } from '@/components/mobile/parts';

/**
 * The ledger (owner, 29 Oct 2026: "a ledger on the phone, day by day -- profit, loss, charges, others; my system's
 * P&L and the Delta app's reconciled, checked every day at 11:59 PM and synced by hand -- user friendly, mobile
 * friendly"). Each IST day of the range: what the desk booked -- its profit, its loss, Delta's charges on its fills,
 * the credits Delta added -- and beside it Delta's own wallet for the day and the verdict. A day opens onto the two
 * side by side, line by line. The desk checks each day by itself at 11:59 PM; Sync checks today, or one day, now.
 * Everything in rupees, the desk's rate; a check reads nothing but Delta's wallet, so this view-only phone may ask.
 */

type RangeKey = '7' | '30' | '90';
const RANGES: { key: RangeKey; label: string; spoken: string; days: number }[] = [
  { key: '7', label: '7D', spoken: '7 days', days: 7 }, { key: '30', label: '30D', spoken: '30 days', days: 30 }, { key: '90', label: '90D', spoken: '90 days', days: 90 },
];

/** The verdict in a word and a colour. `off` is the difference, said in rupees. */
const VERDICT: Record<LedgerStatus, { word: (offUsd: number | null) => string; tone: 'up' | 'down' | 'warn' | 'dim' }> = {
  match: { word: () => '✓ Matches Delta', tone: 'up' },
  mismatch: { word: (d) => `Off by ${d === null ? '—' : signedInr(usdToInr(Math.abs(d))).replace(/^[+−-]/, '')}`, tone: 'down' },
  open: { word: () => 'Trades open', tone: 'warn' },
  unread: { word: () => 'Delta not read', tone: 'warn' },
  paper: { word: () => 'Paper', tone: 'dim' },
  partial: { word: () => 'Partly checked', tone: 'warn' },
  unchecked: { word: () => 'Not checked yet', tone: 'dim' },
};
const money = (usd: number | null | undefined) => (usd === null || usd === undefined ? '—' : signedInr(usdToInr(usd)));

export function LedgerScreen() {
  const p = usePhoneData();
  const [rangeKey, setRangeKey] = usePersisted<RangeKey>('m-ledger-range', '7');
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0]!;
  const today = todayIst(p.now);
  const from = daysAgoIst(range.days - 1, p.now);
  const led = usePoll(() => getLedger(from, today, p.accountParam), 60_000, { deps: [from, today, p.accountParam] });
  const [syncing, setSyncing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const sync = async (day: string | null) => {
    setSyncing(day ?? today);
    setProblem(null);
    try { await syncLedger(day, p.accountParam); await led.refresh(); } catch (e) { setProblem((e as Error).message); } finally { setSyncing(null); }
  };

  const r = led.data;
  const t = r?.totals;
  const others = t?.delta ? t.delta.othersUsd + t.delta.fundingUsd : null;
  return (
    <>
      <Segmented label="Range" value={range.key} options={RANGES} onChange={setRangeKey} />

      {!r ? <Panel><Loading error={led.error} what="the ledger" /></Panel> : (
        <>
          <Panel>
            <section aria-label="Ledger totals">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-[13px] text-muted-foreground">Net after charges · desk</span>
                <span className="text-[11.5px] text-muted-foreground">Last {range.days} days{p.accountParam === null ? ' · every account' : ''}</span>
              </div>
              <Rupees usd={t!.desk.netUsd} signed size="xl" />
              <p className="m-0 mb-2 text-[12.5px] tabular-nums text-muted-foreground">
                {t!.desk.trades.toLocaleString('en-IN')} trade{t!.desk.trades === 1 ? '' : 's'} · {t!.days} day{t!.days === 1 ? '' : 's'}
              </p>
              <Stats>
                <Stat label="Profit" tone={t!.desk.profitUsd > 0 ? 'up' : undefined}>{money(t!.desk.profitUsd)}</Stat>
                <Stat label="Loss" tone={t!.desk.lossUsd > 0 ? 'down' : undefined}>{money(-t!.desk.lossUsd)}</Stat>
                <Stat label="Charges" tone={t!.desk.chargesUsd > 0 ? 'down' : undefined}>{money(-t!.desk.chargesUsd)}</Stat>
                <Stat label="Others · Delta">{money(others)}</Stat>
              </Stats>
              <Reconciled checked={t!.checked} matched={t!.matched} mismatched={t!.mismatched} days={t!.days} />
            </section>
          </Panel>

          <Panel>
            <section aria-label="Sync with Delta" className="grid gap-2">
              <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">
                Checked by itself every day at 11:59 PM.{' '}
                {r.lastAutoAt ? <>Last: <span className="tabular-nums text-[var(--time)]">{stamp(r.lastAutoAt)}</span>.</> : 'Not yet run.'}
              </p>
              <button
                type="button" disabled={syncing !== null || r.accounts.length === 0} onClick={() => void sync(null)}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border-0 bg-[var(--up)] font-[inherit] text-[14.5px] font-semibold text-[var(--bg)] disabled:opacity-50"
              >
                <RefreshCw aria-hidden="true" className={cn('h-4 w-4', syncing === today && 'animate-spin')} />
                {syncing === today ? 'Checking with Delta…' : 'Sync today with Delta'}
              </button>
              {r.accounts.length === 0 && <p className="m-0 text-[12.5px] text-[var(--warn)]">No broker account is switched on: there is no Delta wallet to check against.</p>}
              {problem && <p role="alert" className="m-0 text-[12.5px] text-[var(--down)]">{problem}</p>}
            </section>
          </Panel>

          <Panel title="Each day">
            {r.days.length === 0 ? <Empty>Nothing traded or checked in this range.</Empty> : (
              <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Ledger days">
                {r.days.map((d) => (
                  <DayItem
                    key={d.day} d={d} today={today} open={open === d.day} onToggle={() => setOpen(open === d.day ? null : d.day)}
                    syncing={syncing === d.day} busy={syncing !== null} onSync={() => void sync(d.day)}
                  />
                ))}
              </ul>
            )}
          </Panel>
          <p className="m-0 px-1 text-[12px] leading-snug text-muted-foreground">
            Desk: every fill of the day, the profit and loss of each exit, Delta&apos;s charges on each fill. Delta: the day&apos;s wallet entries --
            trading and charges against the desk, credits as others, deposits and withdrawals apart. They match within ₹{Math.round(usdToInr(r.toleranceUsd) ?? 0)}.
            Days are IST, midnight to midnight.
          </p>
        </>
      )}
    </>
  );
}

/** How many checked days agreed with Delta, as a bar and in words. */
function Reconciled({ checked, matched, mismatched, days }: { checked: number; matched: number; mismatched: number; days: number }) {
  const share = checked ? matched / checked : 0;
  return (
    <div className="mt-2.5" aria-label="Reconciled with Delta">
      <div className="mb-1 flex flex-wrap justify-between gap-x-2 text-[12.5px]">
        <span className="text-muted-foreground">Reconciled with Delta</span>
        <span className={cn('font-medium tabular-nums', mismatched ? 'text-[var(--down)]' : checked ? 'text-[var(--up)]' : 'text-muted-foreground')}>
          {checked === 0 ? 'No day checked yet' : `${matched} of ${checked} checked match${mismatched ? ` · ${mismatched} off` : ''}`}
          {checked < days ? ` · ${days - checked} not checked` : ''}
        </span>
      </div>
      {/* The days that matched in green and the ones off in red, each its share of the checked: one red day is a sliver, not the whole bar. */}
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="presentation">
        <div className="h-full bg-[var(--up)]" style={{ width: `${Math.round(share * 100)}%` }} />
        <div className="h-full bg-[var(--down)]" style={{ width: `${checked ? Math.round((mismatched / checked) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

/** One day: its figures at a glance, and opened, the desk and Delta side by side. */
function DayItem({ d, today, open, onToggle, syncing, busy, onSync }: {
  d: LedgerDay; today: string; open: boolean; onToggle: () => void; syncing: boolean; busy: boolean; onSync: () => void;
}) {
  const v = VERDICT[d.status];
  const name = d.day === today ? 'Today' : dayLabel(d.day);
  const others = d.delta ? d.delta.othersUsd + d.delta.fundingUsd : null;
  return (
    <li className="py-2.5">
      <button
        type="button" onClick={onToggle} aria-expanded={open} aria-label={`${name}: ${open ? 'close' : 'open'} the day`}
        className="block w-full border-0 bg-transparent p-0 text-left font-[inherit] text-foreground"
      >
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14.5px] font-semibold">{name}</span>
            <Pill tone={v.tone}>{v.word(d.diffUsd)}</Pill>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Rupees usd={d.desk.netUsd} signed size="sm" />
            <ChevronDown aria-hidden="true" className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
          </span>
        </span>
        {/* Four across from 360px; two by two under it, where four left "−₹78.2…" (29 Oct 2026, checked at 320px). */}
        <span className="mt-1.5 grid grid-cols-2 gap-1 text-[11.5px] tabular-nums min-[360px]:grid-cols-4">
          <Mini label="Profit" value={money(d.desk.profitUsd)} tone={d.desk.profitUsd > 0 ? 'up' : undefined} />
          <Mini label="Loss" value={money(-d.desk.lossUsd)} tone={d.desk.lossUsd > 0 ? 'down' : undefined} />
          <Mini label="Charges" value={money(-d.desk.chargesUsd)} tone={d.desk.chargesUsd > 0 ? 'down' : undefined} />
          <Mini label="Others" value={money(others)} />
        </span>
        <span className="mt-1 block text-[12px] leading-snug text-muted-foreground">
          {d.delta ? <>Delta {money(d.delta.netUsd)}</> : d.status === 'paper' ? 'Paper day: nothing on Delta' : 'Delta not checked'}
          {' · '}{d.desk.trades} trade{d.desk.trades === 1 ? '' : 's'}
          {d.changed && <span className="text-[var(--warn)]"> · changed since checked</span>}
        </span>
      </button>
      {open && <DayDetail d={d} syncing={syncing} busy={busy} onSync={onSync} />}
    </li>
  );
}

/** A small figure under a day: four of them a row on a phone of 360px and up, two by two under it. */
function Mini({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <span className="grid min-w-0 gap-px rounded-md bg-muted px-1.5 py-1 leading-tight">
      <span className="truncate text-[10.5px] text-muted-foreground">{label}</span>
      <span className={cn('truncate font-semibold', tone === 'up' && 'text-[var(--up)]', tone === 'down' && 'text-[var(--down)]')}>{value}</span>
    </span>
  );
}

/** The desk and Delta side by side, line by line; the difference; where it lies; when and how it was checked. */
function DayDetail({ d, syncing, busy, onSync }: { d: LedgerDay; syncing: boolean; busy: boolean; onSync: () => void }) {
  const w = d.delta;
  const line = (label: string, desk: number | null, delta: number | null, strong = false) => (
    <div className={cn('grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-2 py-1 text-[13px] tabular-nums', strong && 'font-semibold')}>
      <span className="min-w-0 text-muted-foreground">{label}</span>
      <span className="text-right">{money(desk)}</span>
      <span className="text-right">{money(delta)}</span>
    </div>
  );
  return (
    <div className="mt-2 rounded-lg border border-solid border-[var(--line-soft)] px-3 py-2" aria-label="The day, desk and Delta">
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-solid border-x-0 border-t-0 border-[var(--line-soft)] pb-1 text-[11.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
        <span />
        <span className="text-right">Desk</span>
        <span className="text-right">Delta</span>
      </div>
      {line('Booked P&L', d.desk.realisedUsd, w ? w.tradingUsd : null)}
      {line('Charges', -d.desk.chargesUsd, w ? w.chargesUsd : null)}
      {w && w.fundingUsd !== 0 && line('Funding', null, w.fundingUsd)}
      <div className="border-t border-solid border-x-0 border-b-0 border-[var(--line-soft)]">{line('Net', d.desk.netUsd, w ? w.netUsd : null, true)}</div>
      {d.diffUsd !== null && (
        <p className={cn('m-0 mt-1 text-[13px] font-medium', d.status === 'match' ? 'text-[var(--up)]' : d.status === 'mismatch' ? 'text-[var(--down)]' : 'text-[var(--warn)]')}>
          Difference {money(d.diffUsd)}{d.status === 'match' ? ' — within the tolerance' : ''}
        </p>
      )}
      {d.detail && <p className="m-0 mt-1 text-[12.5px] leading-snug text-muted-foreground">{d.detail}</p>}
      {d.changed && d.checkedDeskUsd !== null && (
        <p className="m-0 mt-1 text-[12.5px] leading-snug text-[var(--warn)]">The desk&apos;s day has changed since it was checked ({money(d.checkedDeskUsd)} then, {money(d.desk.netUsd)} now): sync it again.</p>
      )}
      {w && (
        <dl className="m-0 mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px] tabular-nums">
          <dt className="text-muted-foreground">Others (credits)</dt><dd className="m-0 text-right">{money(w.othersUsd)}</dd>
          <dt className="text-muted-foreground">Deposits &amp; withdrawals</dt><dd className="m-0 text-right">{money(w.transfersUsd)}</dd>
          {w.closingUsd !== null && <><dt className="text-muted-foreground">Delta balance, end of day</dt><dd className="m-0 text-right">₹{Math.round(usdToInr(w.closingUsd) ?? 0).toLocaleString('en-IN')}</dd></>}
          <dt className="text-muted-foreground">Wallet entries</dt><dd className="m-0 text-right">{w.entries.toLocaleString('en-IN')}</dd>
        </dl>
      )}
      {d.perAccount && d.perAccount.length > 1 && (
        <ul className="m-0 mt-2 list-none p-0 text-[12.5px]" aria-label="Each account">
          {d.perAccount.map((a) => (
            <li key={a.accountId} className="flex items-center justify-between gap-2 py-0.5">
              <span className="truncate">{a.name}</span>
              <Pill tone={VERDICT[a.status].tone}>{VERDICT[a.status].word(a.diffUsd)}</Pill>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 mt-2 text-[12px] text-muted-foreground">
        {d.checkedAt ? <>Checked <span className="tabular-nums text-[var(--time)]">{stamp(d.checkedAt)}</span> · {d.how === 'auto' ? 'by itself' : 'by hand'}</> : 'Not checked yet.'}
      </p>
      <button
        type="button" disabled={busy} onClick={onSync}
        className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-solid border-border bg-transparent font-[inherit] text-[14px] text-foreground disabled:opacity-50"
      >
        <RefreshCw aria-hidden="true" className={cn('h-4 w-4', syncing && 'animate-spin')} />
        {syncing ? 'Checking with Delta…' : 'Sync this day'}
      </button>
    </div>
  );
}
