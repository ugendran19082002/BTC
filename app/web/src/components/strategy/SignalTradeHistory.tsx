import { useMemo } from 'react';
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

type Show = 'all' | 'live' | 'paper';
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

  const rows = useMemo(() => trades.filter((t) => (show === 'all' || (show === 'live' ? t.status === 'placed' : t.status === 'would-place'))
    && (who === 'all' || t.strategyId === who)), [trades, show, who]);
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
            {([['all', 'All'], ['live', 'Live orders'], ['paper', 'Would sell']] as const).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={show === v} onClick={() => setShow(v)} className={chip(show === v)}>{label}</button>
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

      <p className="m-0 mb-1.5 text-[11.5px] tabular-nums text-muted-foreground" aria-label="history totals">
        {rows.length} trade{rows.length === 1 ? '' : 's'} · <span className="text-[var(--up)]">{totals.won} won</span>
        {' · '}<span className="text-[var(--down)]">{totals.lost} lost</span> · {totals.open} open
        {totals.decided > 0 && ` · win rate ${Math.round((totals.won / totals.decided) * 100)}%`}
        {rows.some((t) => t.option) && (
          <> · live P&amp;L <span className={totals.pnl > 0 ? 'text-[var(--up)]' : totals.pnl < 0 ? 'text-[var(--down)]' : ''}>{signedInr(usdToInr(totals.pnl))}</span></>
        )}
      </p>

      {rows.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-[var(--line)] px-3 py-3 text-[12px] text-muted-foreground">
          No trades {show === 'live' ? 'with live orders' : show === 'paper' ? 'written down' : ''} yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-solid border-border">
          <table aria-label="signal trades" className="w-full min-w-[760px] border-collapse text-[11.5px] tabular-nums">
            <thead>
              <tr className="bg-muted text-left text-[10.5px] uppercase tracking-[0.4px] text-muted-foreground">
                {['Time', 'Signal', 'Option', 'Entry', 'Perp SL', 'Perp TGT', 'Exit', 'Result', 'P&L'].map((h) => (
                  <th key={h} scope="col" className="px-2 py-1.5 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const o = outcomeOf(t);
                const sl = t.option?.perpStop ?? t.levels?.stop ?? null;
                const tgt = t.option?.perpTarget ?? t.levels?.tp1 ?? null;
                const [said] = t.detail.split(' | ');
                return (
                  <tr key={t.id} className="border-0 border-t border-solid border-border align-top">
                    <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                      {stamp(t.at)}
                      <div className="text-[10.5px] text-[var(--dim)]">{nameOf(t.strategyId)}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={t.dir === 1 ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{said}</span>
                      <div className="text-[10.5px] text-[var(--dim)]">{t.mode === 'mtf' ? '5m + TF chain' : t.tf}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {t.option
                        ? <>{t.option.side} {btc(t.option.strike)} ×{t.option.size}</>
                        : <span className="text-[var(--dim)]">{t.dir === 1 ? 'PE' : 'CE'} · would sell</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {t.option ? opt(t.option.entry) : btc(t.perp?.fillPrice)}
                      {!t.option && t.levels && <div className="text-[10.5px] text-[var(--dim)]">zone {btc(t.levels.entryLo)}–{btc(t.levels.entryHi)}</div>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-[var(--down)]">{btc(sl)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-[var(--up)]">
                      {btc(tgt)}
                      {t.levels && (t.levels.tp2 !== null || t.levels.tp3 !== null) && (
                        <div className="text-[10.5px] text-[var(--dim)]">
                          {t.levels.tp2 !== null && `TGT2 ${btc(t.levels.tp2)}`}{t.levels.tp3 !== null && ` · TGT3 ${btc(t.levels.tp3)}`}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {t.option ? opt(o.price) : btc(o.price)}
                      {o.at !== null && <div className="text-[10.5px] text-[var(--dim)]">{stamp(o.at)}</div>}
                    </td>
                    <td className={cn('px-2 py-1.5', TONE[o.tone])} title={t.option?.exitReason ?? undefined}>{o.word}</td>
                    <td className={cn('whitespace-nowrap px-2 py-1.5', t.option ? (t.option.pnlUsd > 0 ? 'text-[var(--up)]' : t.option.pnlUsd < 0 ? 'text-[var(--down)]' : '') : 'text-[var(--dim)]')}>
                      {t.option ? (t.option.open ? '—' : signedInr(usdToInr(t.option.pnlUsd))) : 'paper'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="m-0 mt-1 text-[10.5px] text-[var(--dim)]">
        A would-sell&apos;s result is the paper log&apos;s on the perp (entry at the zone, out at the SL or TGT1); a live order&apos;s is its option&apos;s own.
      </p>
    </div>
  );
}
