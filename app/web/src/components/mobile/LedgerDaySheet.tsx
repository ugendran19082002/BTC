import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { getLedgerDay, type DayTrade } from '@/api/ledger';
import { clock, duration, price, signedInr, stamp, usdToInr } from '@/lib/format';
import { dayLabel } from '@/lib/market-report';
import { todayIst } from '@/lib/report';
import { cn } from '@/lib/utils';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { Chip, Empty, Loading, Pill, Stat, Stats, When } from '@/components/mobile/parts';

/**
 * One ledger day's trades, from the bottom of the screen (owner, 30 Oct 2026: "the entries under a day, a tap opens a
 * popup: entry, exit, charges, P&L, the strike, PE or CE, entry time, exit time -- mobile friendly"). The day's own
 * figures on top, the ledger row's; each trade on its line -- sold or bought, the strike and CE or PE, how it closed,
 * its net -- its In and its Out each with a time and a price, its charges and what it booked; a tap opens the trade's
 * own story. CE or PE, won or lost, and the order, each a tap; forty lines at a time.
 */

type Sort = 'exit-new' | 'entry-new' | 'net-high' | 'net-low';
const SORTS: { key: Sort; label: string; by: (a: DayTrade, b: DayTrade) => number }[] = [
  { key: 'exit-new', label: 'Newest exit', by: (a, b) => (b.exitAt ?? b.entryAt ?? 0) - (a.exitAt ?? a.entryAt ?? 0) },
  { key: 'entry-new', label: 'Newest entry', by: (a, b) => (b.entryAt ?? 0) - (a.entryAt ?? 0) },
  { key: 'net-high', label: 'Most made', by: (a, b) => b.netUsd - a.netUsd },
  { key: 'net-low', label: 'Most lost', by: (a, b) => a.netUsd - b.netUsd },
];
const EXIT: Record<NonNullable<DayTrade['exitBy']>, { word: string; tone: 'up' | 'down' | 'dim' }> = {
  'option-tgt': { word: 'TGT', tone: 'up' }, 'perp-tgt': { word: 'Perp TGT', tone: 'up' },
  'option-sl': { word: 'SL', tone: 'down' }, 'perp-sl': { word: 'Perp SL', tone: 'down' },
  'window-end': { word: 'Time exit', tone: 'dim' }, manual: { word: 'By hand', tone: 'dim' },
};
const money = (usd: number) => signedInr(usdToInr(usd));
const PAGE = 40;

export function LedgerDaySheet({ day, account, showAccount, onOpenTrade, onClose }: {
  day: string; account: number | null; showAccount: boolean; onOpenTrade: (tradeId: string) => void; onClose: () => void;
}) {
  const r = usePoll(() => getLedgerDay(day, account), 60_000, { deps: [day, account] });
  const [side, setSide] = useState<'all' | 'CE' | 'PE'>('all');
  const [result, setResult] = useState<'all' | 'win' | 'loss'>('all');
  const [sortKey, setSortKey] = usePersisted<Sort>('m-ledger-day-sort', 'exit-new');
  const [limit, setLimit] = useState(PAGE);
  const sort = SORTS.find((s) => s.key === sortKey) ?? SORTS[0]!;
  useEffect(() => { setLimit(PAGE); }, [side, result, sortKey]);
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = before; window.removeEventListener('keydown', esc); };
  }, [onClose]);

  const all = r.data?.trades ?? [];
  const shown = useMemo(() => all
    .filter((t) => (side === 'all' || t.optionSide === side) && (result === 'all' || (result === 'win' ? t.netUsd > 0 : t.netUsd < 0)))
    .sort(sort.by), [all, side, result, sort]);
  const count = (f: (t: DayTrade) => boolean) => all.filter(f).length;
  const d = r.data?.desk;
  const name = day === todayIst(Date.now()) ? 'Today' : dayLabel(day);

  return (
    // Over the tab bar (z-20) and under a trade opened from it (TradeDetail, z-30): back from the trade is back to this list.
    <div className="fixed inset-0 z-[25] flex items-end justify-center" role="presentation">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 border-0 bg-black/60 p-0" tabIndex={-1} />
      <div role="dialog" aria-modal="true" aria-labelledby="ledger-day-title"
        className="relative flex max-h-[92vh] w-full max-w-[560px] flex-col rounded-t-2xl border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
        <div className="px-4 pt-2">
          <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--line)]" />
          <div className="flex items-center justify-between gap-2">
            <h2 id="ledger-day-title" className="m-0 min-w-0 truncate text-[17px] font-semibold">{name} · trades</h2>
            <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {!r.data ? <Loading error={r.error} what="the day's trades" /> : (
            <>
              <section aria-label="The day" className="mt-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] text-muted-foreground">Net after charges</span>
                  <span className={cn('text-[22px] font-semibold tabular-nums', d!.netUsd > 0 ? 'text-[var(--up)]' : d!.netUsd < 0 ? 'text-[var(--down)]' : '')}>{money(d!.netUsd)}</span>
                </div>
                <div className="mt-1.5">
                  <Stats>
                    <Stat label="Trades">{d!.trades}{d!.open ? ` · ${d!.open} open` : ''}</Stat>
                    <Stat label="Won">{all.length ? `${Math.round((count((t) => t.netUsd > 0) / all.length) * 100)}%` : '—'}</Stat>
                    <Stat label="Booked" tone={d!.realisedUsd > 0 ? 'up' : d!.realisedUsd < 0 ? 'down' : undefined}>{money(d!.realisedUsd)}</Stat>
                    <Stat label="Charges" tone={d!.chargesUsd > 0 ? 'down' : undefined}>{money(-d!.chargesUsd)}</Stat>
                  </Stats>
                </div>
              </section>

              <div role="group" aria-label="CE or PE" className="mt-3 flex flex-wrap gap-2">
                <Chip on={side === 'all'} onClick={() => setSide('all')}>All {all.length}</Chip>
                <Chip on={side === 'CE'} onClick={() => setSide(side === 'CE' ? 'all' : 'CE')}>CE {count((t) => t.optionSide === 'CE')}</Chip>
                <Chip on={side === 'PE'} onClick={() => setSide(side === 'PE' ? 'all' : 'PE')}>PE {count((t) => t.optionSide === 'PE')}</Chip>
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <div role="group" aria-label="Won or lost" className="flex gap-2">
                  <Chip on={result === 'win'} onClick={() => setResult(result === 'win' ? 'all' : 'win')}>Won</Chip>
                  <Chip on={result === 'loss'} onClick={() => setResult(result === 'loss' ? 'all' : 'loss')}>Lost</Chip>
                </div>
                <span className="relative min-w-0">
                  <select
                    aria-label="Sort" value={sort.key} onChange={(e) => setSortKey(e.target.value as Sort)}
                    className="h-10 w-full min-w-0 appearance-none truncate rounded-lg border border-solid border-border bg-muted pl-3 pr-8 font-[inherit] text-[14px] text-foreground"
                  >
                    {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                  <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </span>
              </div>

              {shown.length === 0 ? <div className="mt-3"><Empty>{all.length ? 'None match.' : 'No trade this day.'}</Empty></div> : (
                <ul className="m-0 mt-2 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="The day's trades">
                  {shown.slice(0, limit).map((t) => <TradeLine key={t.tradeId} t={t} day={day} showAccount={showAccount} onOpen={() => onOpenTrade(t.tradeId)} />)}
                </ul>
              )}
              {shown.length > limit && (
                <button
                  type="button" onClick={() => setLimit((l) => l + PAGE)}
                  className="mt-2 flex h-11 w-full items-center justify-center rounded-lg border border-solid border-border bg-transparent font-[inherit] text-[13.5px] text-foreground"
                >
                  Show {Math.min(PAGE, shown.length - limit)} more · {limit} of {shown.length}
                </button>
              )}
              <p className="m-0 mt-3 text-[11.5px] leading-snug text-muted-foreground">
                From the desk&apos;s own record of every fill Delta confirmed. Charges are Delta&apos;s fees on each fill; a trade that crossed midnight shows
                whole and is marked, while the day&apos;s figures above count only its own fills.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A moment on a line: its time on the sheet's own day, its date and time on another. */
const whenOf = (ms: number | null, day: string) => (ms === null ? '—' : todayIst(ms) === day ? clock(ms) : stamp(ms));

/** One trade: the side, strike and CE / PE, how it closed and its net; In and Out; charges and what it booked. */
function TradeLine({ t, day, showAccount, onOpen }: { t: DayTrade; day: string; showAccount: boolean; onOpen: () => void }) {
  const exit = t.exitBy ? EXIT[t.exitBy] : null;
  const held = t.entryAt !== null && t.exitAt !== null ? duration(t.exitAt - t.entryAt) : null;
  return (
    <li>
      <button type="button" onClick={onOpen} aria-label={`${t.strike ?? ''} ${t.optionSide}: open the trade`}
        className="block w-full border-0 bg-transparent px-0 py-2.5 text-left font-[inherit] text-foreground active:bg-muted">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('shrink-0 text-[12px] font-bold', t.action === 'buy' ? 'text-[var(--buy)]' : 'text-[var(--down)]')}>{t.action === 'buy' ? 'BUY' : 'SELL'}</span>
            <span className="truncate text-[14.5px] font-semibold tabular-nums">{t.strike?.toLocaleString('en-US') ?? t.symbol} {t.optionSide}</span>
            <span className="shrink-0 text-[12px] text-muted-foreground">×{t.contracts}</span>
          </span>
          <span className={cn('shrink-0 text-[15px] font-semibold tabular-nums', t.netUsd > 0 ? 'text-[var(--up)]' : t.netUsd < 0 ? 'text-[var(--down)]' : '')}>{t.open ? 'Open' : money(t.netUsd)}</span>
        </span>
        <span className="mt-1.5 grid grid-cols-2 gap-1.5">
          <Leg label="In" at={whenOf(t.entryAt, day)} px={t.entryPrice} />
          <Leg label="Out" at={t.open ? 'still open' : whenOf(t.exitAt, day)} px={t.exitPrice} />
        </span>
        <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] leading-snug text-muted-foreground">
          {exit && <Pill tone={exit.tone}>{exit.word}</Pill>}
          {t.spans && <Pill tone="warn">Over midnight</Pill>}
          <span className="tabular-nums">Charges {money(-t.chargesUsd)} · booked {money(t.grossUsd)}{held ? ` · held ${held}` : ''}</span>
          {(t.strategy || (showAccount && t.account)) && (
            <span className="min-w-0 break-words">{[t.strategy, showAccount && t.account ? t.account.name : null].filter(Boolean).join(' · ')}</span>
          )}
        </span>
      </button>
    </li>
  );
}

function Leg({ label, at, px }: { label: string; at: string; px: number | null }) {
  return (
    <span className="grid min-w-0 gap-0.5 rounded-md bg-muted px-2 py-1.5 leading-tight">
      <span className="flex min-w-0 items-baseline justify-between gap-1.5">
        <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">{label}</span>
        <span className="min-w-0 truncate text-[14px] font-semibold tabular-nums">{price(px)}</span>
      </span>
      <When className="truncate text-[12px]">{at}</When>
    </span>
  );
}
