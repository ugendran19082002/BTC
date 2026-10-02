import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { SignalTrade, Strategy } from '@/types/strategy';
import { usePersisted } from '@/hooks/usePersisted';
import { signedInr, stamp, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Every trade the signal strategies took, or with live orders off would have
 * taken: the signal, the option, the signal's SL and TGT on the BTC perp, how
 * it ended and what it made.
 *
 * A real order's result is the option's own: its fill, its exit, why the desk
 * closed it and the money. A "would sell" has no option, so its result is the
 * paper log's on the perp -- waiting at the zone, in the trade, out at the SL
 * or TGT1, timed out, or never filled -- the same verdict the signal history
 * shows. The filters are kept in this browser.
 */

type Show = 'all' | 'live' | 'paper' | 'open' | 'won' | 'lost' | 'skipped';

/** A trade -- sold, or written down as one -- rather than a signal not taken. */
export const isTrade = (t: SignalTrade) => t.status === 'placed' || t.status === 'would-place';

/** The tabs, in the order a person asks: everything, which kind, how they went, and what was passed over. */
const TABS: { v: Show; label: string; test: (t: SignalTrade) => boolean }[] = [
  { v: 'all', label: 'All', test: isTrade },
  { v: 'live', label: 'Live orders', test: (t) => t.status === 'placed' },
  { v: 'paper', label: 'Would sell', test: (t) => t.status === 'would-place' },
  { v: 'open', label: 'Open', test: (t) => isTrade(t) && outcomeOf(t).tone === 'open' },
  { v: 'won', label: 'Won', test: (t) => isTrade(t) && outcomeOf(t).tone === 'up' },
  { v: 'lost', label: 'Lost', test: (t) => isTrade(t) && outcomeOf(t).tone === 'down' },
  { v: 'skipped', label: 'Skipped', test: (t) => !isTrade(t) },
];
/** Rows a page holds. */
export const PAGE = 10;
type Outcome = { word: string; tone: 'up' | 'down' | 'open' | 'quiet'; at: number | null; price: number | null };

const btc = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
const opt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

/** The perp side, in the paper log's words. */
const PERP: Record<string, { word: string; tone: Outcome['tone'] }> = {
  open: { word: 'waiting at the zone', tone: 'open' },
  filled: { word: 'in the trade', tone: 'open' },
  tp1: { word: 'TGT1 hit', tone: 'up' },
  stop: { word: 'SL hit', tone: 'down' },
  timeout: { word: 'timed out', tone: 'quiet' },
  expired: { word: 'never filled', tone: 'quiet' },
  missed: { word: 'missed', tone: 'quiet' },
};

/** How a trade ended, in a word, with when and at what. */
export function outcomeOf(t: SignalTrade): Outcome {
  const o = t.option;
  if (o) {
    if (o.entry === null) return { word: o.open ? 'entry working' : 'not filled', tone: o.open ? 'open' : 'quiet', at: null, price: null };
    if (o.open) return { word: 'open', tone: 'open', at: null, price: null };
    const why = o.exitReason
      ? /stop/i.test(o.exitReason) ? 'perp SL' : /target/i.test(o.exitReason) ? 'perp TGT' : /window|exit time/i.test(o.exitReason) ? 'window end' : 'closed'
      : o.pnlUsd > 0 ? 'target' : 'stop / closed';
    return { word: why, tone: o.pnlUsd > 0 ? 'up' : o.pnlUsd < 0 ? 'down' : 'quiet', at: null, price: o.exit };
  }
  const p = t.perp;
  if (!p) return { word: 'no paper record', tone: 'quiet', at: null, price: null };
  const w = PERP[p.status] ?? { word: p.status, tone: 'quiet' as const };
  return { ...w, at: p.exitAt, price: p.exitPrice };
}

const TONE: Record<Outcome['tone'], string> = {
  up: 'text-[var(--up)]', down: 'text-[var(--down)]', open: 'text-[var(--warn)]', quiet: 'text-[var(--dim)]',
};

export function SignalTradeHistory({ trades, strategies }: { trades: readonly SignalTrade[]; strategies: readonly Strategy[] }) {
  const [show, setShow] = usePersisted<Show>('signal-trades:show', 'all');
  const [who, setWho] = usePersisted<string>('signal-trades:strategy', 'all');
  const nameOf = (id: string) => strategies.find((s) => s.id === id)?.name ?? id;
  const ids = [...new Set(trades.map((t) => t.strategyId))];

  const mine = useMemo(() => trades.filter((t) => who === 'all' || t.strategyId === who), [trades, who]);
  const tab = TABS.find((x) => x.v === show) ?? TABS[0]!;
  const rows = useMemo(() => mine.filter(tab.test), [mine, tab]);
  const count = (x: (typeof TABS)[number]) => mine.filter(x.test).length;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  // A filter changed, or the list shrank: back to a page that exists.
  useEffect(() => { setPage(0); }, [show, who]);
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);
  const totals = useMemo(() => {
    let won = 0; let lost = 0; let open = 0; let pnl = 0;
    for (const t of rows) {
      const o = outcomeOf(t);
      if (o.tone === 'up') won += 1; else if (o.tone === 'down') lost += 1; else if (o.tone === 'open') open += 1;
      if (t.option) pnl += t.option.pnlUsd;
    }
    return { won, lost, open, pnl, decided: won + lost };
  }, [rows]);

  const chip = (on: boolean) => cn('m-0 h-8 appearance-none rounded-md border border-solid px-2.5 font-[inherit] text-[12px]',
    on ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground');

  return (
    <div className="mt-3" aria-label="signal trade history">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-[13.5px] font-semibold text-foreground">Trade history</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <div role="group" aria-label="which trades" className="flex gap-1">
            {TABS.map((x) => (
              <button key={x.v} type="button" aria-pressed={tab.v === x.v} onClick={() => setShow(x.v)} className={chip(tab.v === x.v)}>
                {x.label} <span className="tabular-nums text-[var(--dim)]">{count(x)}</span>
              </button>
            ))}
          </div>
          {ids.length > 1 && (
            <select aria-label="which strategy" value={who} onChange={(e) => setWho(e.target.value)}
                    className="h-8 rounded-md border border-solid border-border bg-background px-2 text-[12px] text-foreground">
              <option value="all">Every strategy</option>
              {ids.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
            </select>
          )}
        </div>
      </div>

      {tab.v === 'skipped' ? (
        <p className="m-0 mb-1.5 text-[11.5px] tabular-nums text-muted-foreground" aria-label="history totals">
          {rows.length} signal{rows.length === 1 ? '' : 's'} not taken — the reason on each row.
        </p>
      ) : (
      <p className="m-0 mb-1.5 text-[11.5px] tabular-nums text-muted-foreground" aria-label="history totals">
        {rows.length} trade{rows.length === 1 ? '' : 's'} · <span className="text-[var(--up)]">{totals.won} won</span>
        {' · '}<span className="text-[var(--down)]">{totals.lost} lost</span> · {totals.open} open
        {totals.decided > 0 && ` · win rate ${Math.round((totals.won / totals.decided) * 100)}%`}
        {rows.some((t) => t.option) && (
          <> · live P&amp;L <span className={totals.pnl > 0 ? 'text-[var(--up)]' : totals.pnl < 0 ? 'text-[var(--down)]' : ''}>{signedInr(usdToInr(totals.pnl))}</span></>
        )}
      </p>
      )}

      {rows.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-[var(--line)] px-3 py-3 text-[12px] text-muted-foreground">
          Nothing here yet{tab.v === 'all' ? '' : ` under ${tab.label}`}.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-solid border-border">
            <table aria-label="signal trades" className="w-full min-w-[860px] border-collapse text-[11.5px] tabular-nums">
              <thead>
                <tr className="bg-muted text-left text-[10.5px] uppercase tracking-[0.4px] text-muted-foreground">
                  {['Signal', 'Option', 'Perp entry', 'Option entry', 'Perp SL', 'Perp TGT', 'Exit', 'Result', 'P&L'].map((h) => (
                    <th key={h} scope="col" className="px-2 py-1.5 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (isTrade(t)
                  ? <Row key={t.id} t={t} name={nameOf(t.strategyId)} />
                  : <SkippedRow key={t.id} t={t} name={nameOf(t.strategyId)} />))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="trade history pages" className="mt-1.5 flex items-center justify-end gap-2 text-[12px]">
              <button type="button" aria-label="previous page" disabled={page === 0} onClick={() => setPage(page - 1)}
                      className="m-0 inline-flex h-8 items-center gap-1 rounded-md border border-solid border-border bg-transparent px-2 font-[inherit] text-foreground disabled:opacity-35">
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <span className="tabular-nums text-muted-foreground" aria-live="polite">
                {page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length} · page {page + 1} of {pages}
              </span>
              <button type="button" aria-label="next page" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}
                      className="m-0 inline-flex h-8 items-center gap-1 rounded-md border border-solid border-border bg-transparent px-2 font-[inherit] text-foreground disabled:opacity-35">
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </nav>
          )}
        </>
      )}
      <p className="m-0 mt-1 text-[10.5px] text-[var(--dim)]">
        A would-sell&apos;s result is the paper log&apos;s on the perp (entry at the zone, out at the SL or TGT1); a live order&apos;s is its option&apos;s own.
      </p>
    </div>
  );
}

/** Which exit was reached, so its time is shown under it: the SL, the TGT, or neither (window end, time-out, by hand). */
export function hitOf(t: SignalTrade): 'sl' | 'tgt' | null {
  if (t.option) {
    if (t.option.open || !t.option.exitReason) return null;
    return /stop/i.test(t.option.exitReason) ? 'sl' : /target/i.test(t.option.exitReason) ? 'tgt' : null;
  }
  return t.perp?.status === 'stop' ? 'sl' : t.perp?.status === 'tp1' ? 'tgt' : null;
}

const When = ({ at }: { at: number | null | undefined }) =>
  (at ? <div className="text-[10.5px] text-[var(--dim)]">{stamp(at)}</div> : null);

function Row({ t, name }: { t: SignalTrade; name: string }) {
  const o = outcomeOf(t);
  const hit = hitOf(t);
  const sl = t.option?.perpStop ?? t.levels?.stop ?? null;
  const tgt = t.option?.perpTarget ?? t.levels?.tp1 ?? null;
  const [said] = t.detail.split(' | ');
  const perpEntry = t.option ? (t.option.perpEntry ?? null) : (t.perp?.fillPrice ?? null);
  const entryAt = t.option ? (t.option.entryAt ?? null) : (t.perp?.filledAt ?? null);
  const exitAt = t.option ? (t.option.exitAt ?? null) : (t.perp?.exitAt ?? null);
  return (
    <tr className="border-0 border-t border-solid border-border align-top">
      <td className="px-2 py-1.5">
        <span className={t.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{said}</span>
        <div className="text-[10.5px] text-[var(--dim)]">{t.mode === 'mtf' ? '5m + TF chain' : t.tf} · {name}</div>
        <div className="text-[10.5px] text-[var(--dim)]">signal {stamp(t.at)}</div>
      </td>
      <td className="whitespace-nowrap px-2 py-1.5">
        {t.option
          ? <>{t.option.side} {btc(t.option.strike)} ×{t.option.size}</>
          : <span className="text-[var(--dim)]">{t.dir === 1 ? 'PE' : 'CE'} · would sell</span>}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5" aria-label="perp entry">
        {btc(perpEntry)}
        {t.levels && <div className="text-[10.5px] text-[var(--dim)]">zone {btc(t.levels.entryLo)}–{btc(t.levels.entryHi)}</div>}
        {!t.option && <When at={entryAt} />}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5" aria-label="option entry">
        {t.option ? opt(t.option.entry) : <span className="text-[var(--dim)]">—</span>}
        {t.option && <When at={entryAt} />}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-[var(--down)]" aria-label="perp SL">
        {btc(sl)}
        {hit === 'sl' && <When at={exitAt} />}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-[var(--up)]" aria-label="perp TGT">
        {btc(tgt)}
        {hit === 'tgt' && <When at={exitAt} />}
        {t.levels && (t.levels.tp2 !== null || t.levels.tp3 !== null) && (
          <div className="text-[10.5px] text-[var(--dim)]">
            {t.levels.tp2 !== null && `TGT2 ${btc(t.levels.tp2)}`}{t.levels.tp3 !== null && ` · TGT3 ${btc(t.levels.tp3)}`}
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5" aria-label="exit">
        {t.option ? opt(o.price) : btc(o.price)}
        {hit === null && <When at={exitAt} />}
      </td>
      <td className={cn('px-2 py-1.5', TONE[o.tone])} title={t.option?.exitReason ?? undefined}>{o.word}</td>
      <td className={cn('whitespace-nowrap px-2 py-1.5', t.option ? (t.option.pnlUsd > 0 ? 'text-[var(--up)]' : t.option.pnlUsd < 0 ? 'text-[var(--down)]' : '') : 'text-[var(--dim)]')}>
        {t.option ? (t.option.open ? '—' : signedInr(usdToInr(t.option.pnlUsd))) : 'paper'}
      </td>
    </tr>
  );
}

/** A signal not taken: the signal, and why, across the row. */
function SkippedRow({ t, name }: { t: SignalTrade; name: string }) {
  const [said, ...why] = t.detail.split(' | ');
  return (
    <tr className="border-0 border-t border-solid border-border align-top">
      <td className="px-2 py-1.5">
        <span className={t.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{said}</span>
        <div className="text-[10.5px] text-[var(--dim)]">{t.mode === 'mtf' ? '5m + TF chain' : t.tf} · {name}</div>
        <div className="text-[10.5px] text-[var(--dim)]">signal {stamp(t.at)}</div>
      </td>
      <td colSpan={8} className="px-2 py-1.5" aria-label="why not taken">
        <span className={cn('mr-1.5 rounded px-1.5 py-px text-[10.5px] font-semibold uppercase',
          t.status === 'failed' ? 'bg-[var(--down)]/12 text-[var(--down)]' : 'bg-muted text-muted-foreground')}>
          {t.status}
        </span>
        <span className="text-muted-foreground">{why.join(' | ') || '—'}</span>
      </td>
    </tr>
  );
}
