import { useState } from 'react';
import { getBacktestPortfolio, saveBacktest } from '@/api/backtest-saves';
import { usePersisted } from '@/hooks/usePersisted';
import { pct } from '@/lib/format';
import { dayLabel, moneyText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { BacktestPortfolioResult, BacktestSave, BtTot } from '@/types/signal-backtest';
import { Chip, Empty, Loading, Panel } from '@/components/mobile/parts';
import { Updating, useAnswer } from '@/components/report/Updating';
import { count, netClass } from '@/components/report/backtest-parts';
import { PERIODS, SavedMethodsPicker, periodRange, type Period } from '@/components/report/SavedMethodsPicker';

/**
 * Methods -- pick by win %, every strategy side by side (owner, 20 Oct 2026: "the strategies across, down the side the
 * win %, total trades, profit, loss, loss trades, PF and the rest; a tap on any strategy changes its methods"): each
 * saved backtest by settings a column, with its own settings and methods as saved, over the days chosen -- the same
 * days its method picker reads -- each alone on its own limit, and their total. A tap on a strategy's name opens its
 * methods, picked by win % on their record; Update keeps the list on it, and the figures are worked again.
 */

/** The most there are columns for, as a run together takes. */
const MOST = 12;
type Fig = {
  label: string; of: (t: BtTot, margin: number) => number | null; show: (v: number) => string;
  /** Which way is better, to mark the best strategy; null, no best. */
  better: 'more' | 'less' | null; money?: boolean;
};
const per = (a: number, n: number) => (n > 0 ? a / n : null);
const FIGS: Fig[] = [
  { label: 'Win %', of: (t) => per(t.wins, t.n), show: (v) => pct(v, 0), better: 'more' },
  { label: 'Trades', of: (t) => t.n, show: count, better: null },
  { label: 'Won trades', of: (t) => t.wins, show: count, better: null },
  { label: 'Lost trades', of: (t) => t.losses, show: count, better: null },
  { label: 'Profit', of: (t) => t.won, show: moneyText, better: null, money: true },
  { label: 'Loss', of: (t) => -t.lost, show: moneyText, better: null, money: true },
  { label: 'Charges', of: (t) => -t.charges, show: moneyText, better: null, money: true },
  { label: 'Net', of: (t) => t.net, show: moneyText, better: 'more', money: true },
  { label: 'PF', of: (t) => (t.lost > 0 ? t.won / t.lost : null), show: (v) => v.toFixed(2), better: 'more' },
  { label: 'Net / trade', of: (t) => per(t.net, t.n), show: moneyText, better: 'more', money: true },
  { label: 'Avg win', of: (t) => per(t.won, t.wins), show: moneyText, better: null, money: true },
  { label: 'Avg loss', of: (t) => (t.losses > 0 ? -t.lost / t.losses : null), show: moneyText, better: null, money: true },
  { label: 'Margin peak', of: (_, m) => m, show: moneyText, better: null },
];

export function MethodsBoard({ saves, onChanged, now = Date.now() }: {
  saves: BacktestSave[];
  /** A saved backtest's methods were kept: the list it came from is read again. */
  onChanged?: () => void;
  now?: number;
}) {
  // The same days as each one's method picker: what it is picked on is what is shown here.
  const [period, setPeriod] = usePersisted<Period>('savedMethods.period', '14');
  const days = PERIODS.find((p) => p.key === period)?.days ?? 14;
  const range = periodRange(days, now);
  const bySettings = saves.filter((s) => s.query.strategy === null);
  const shown = bySettings.slice(0, MOST);
  const ids = shown.map((s) => s.id);
  const key = JSON.stringify({ range, saves: shown.map((s) => `${s.id}:${s.updatedAt}`) });
  const read = useAnswer<BacktestPortfolioResult>(key, () => getBacktestPortfolio(ids, range, 'own'), 300_000, 0, ids.length > 0);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const edited = shown.find((s) => s.id === editing) ?? null;
  const update = async (s: BacktestSave, methods: string[]) => {
    setBusy(true); setSaid(null);
    try {
      await saveBacktest({ id: s.id, name: s.name, query: { ...s.query, methods } });
      setEditing(null);
      setSaid({ ok: true, text: methods.length ? `Kept ${methods.length} method${methods.length === 1 ? '' : 's'} on "${s.name}".` : `"${s.name}" takes every method now.` });
      onChanged?.();
    } catch (e) {
      setSaid({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };
  const r = read.data;
  const cols = r ? shown.map((s) => ({ s, m: r.members.find((m) => m.id === s.id) ?? null })) : [];
  const worked = cols.filter((c) => c.m && c.m.problem === null);
  const th = 'sticky left-0 z-[1] bg-[var(--panel)] px-2 py-1.5 text-left';
  return (
    <Panel title="Methods — pick by win %">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        <p className="m-0 text-[13px] leading-snug text-muted-foreground">
          Every saved backtest side by side, each with its own settings and methods as saved, alone on its own limit.
          {' '}<b className="font-medium text-foreground">Tap a strategy&apos;s name</b> to pick its methods by win % and keep them on it.
        </p>
        <div role="group" aria-label="The days of" className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => <Chip key={p.key} on={period === p.key} onClick={() => setPeriod(p.key)}>{p.label}</Chip>)}
        </div>
        {said && <p role={said.ok ? 'status' : 'alert'} className={cn('m-0 text-[12.5px]', said.ok ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{said.text}</p>}
        {ids.length === 0 ? <Empty>No saved backtest by settings yet: save one above, and it is listed here.</Empty>
          : !r ? <Loading error={read.error} what="each saved backtest (a whole backtest each: a moment the first time)" />
            : (
              <Updating busy={read.stale} failed={read.failed} what="the saved backtests">
                <div className="min-w-0 overflow-x-auto rounded-md border border-[var(--line-soft)]">
                  <table className="w-full border-collapse text-[13px] tabular-nums">
                    <caption className="sr-only">Each saved backtest, {dayLabel(range.from)} to {dayLabel(range.to)}: tap a name to pick its methods</caption>
                    <thead>
                      <tr className="text-[12px]">
                        <th scope="col" className={cn(th, 'font-medium text-muted-foreground')}><span className="sr-only">Figure</span></th>
                        {cols.map(({ s }) => (
                          <th key={s.id} scope="col" className="px-1 py-1 text-right align-bottom font-medium">
                            <button type="button" aria-pressed={editing === s.id} aria-label={`${s.name}: its methods, ${s.query.methods.length ? `${s.query.methods.length} picked` : 'every method'} -- pick by win %`}
                              onClick={() => setEditing(editing === s.id ? null : s.id)}
                              className={cn('m-0 min-h-[44px] w-full appearance-none rounded-md border border-solid px-2 py-1 text-right font-[inherit]',
                                editing === s.id ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)] text-[var(--chosen-text)]' : 'border-transparent bg-transparent text-foreground hover:border-border')}>
                              <span className="block whitespace-nowrap font-semibold">{s.name}</span>
                              <span className="block whitespace-nowrap text-[11px] text-[var(--accent)] underline underline-offset-2">{s.query.methods.length ? `${s.query.methods.length} methods` : 'every method'} ✎</span>
                            </button>
                          </th>
                        ))}
                        {worked.length > 1 && <th scope="col" className="px-2 py-1 text-right align-bottom font-semibold">Total</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {FIGS.map((f) => {
                        const vals = cols.map(({ m }) => (m && m.problem === null ? f.of(m.total, m.marginPeakUsd) : null));
                        const known = vals.filter((v): v is number => v !== null);
                        const best = f.better && known.length > 1 ? (f.better === 'more' ? Math.max(...known) : Math.min(...known)) : null;
                        const tot = r.total;
                        const total = f.label === 'Margin peak' ? r.margin.sumOfPeaksUsd : f.of(tot, 0);
                        return (
                          <tr key={f.label} className="border-t border-[var(--line-soft)]">
                            <th scope="row" className={cn(th, 'whitespace-nowrap font-normal text-muted-foreground')}>{f.label}</th>
                            {vals.map((v, i) => {
                              const m = cols[i]!.m;
                              const top = best !== null && v !== null && Math.abs(v - best) < 1e-9;
                              return (
                                <td key={cols[i]!.s.id} className={cn('whitespace-nowrap px-2 py-1.5 text-right', f.money && v !== null && netClass(v), top && 'font-semibold')}>
                                  {m?.problem && f.label === 'Win %' ? <span className="text-[11.5px] text-muted-foreground" title={m.problem}>—</span> : v === null ? '—' : f.show(v)}
                                  {top && <><span className="sr-only"> (best)</span><span aria-hidden className="ml-0.5 text-[10px] text-[var(--up)]">▲</span></>}
                                </td>
                              );
                            })}
                            {worked.length > 1 && <td className={cn('whitespace-nowrap px-2 py-1.5 text-right font-semibold', f.money && total !== null && netClass(total))}>{total === null ? '—' : f.show(total)}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="m-0 text-[12px] leading-snug text-muted-foreground">
                  {dayLabel(range.from)} → {dayLabel(range.to)}, after charges, in rupees. ▲ the best of them. PF: profit over loss. Total: all of them added up, each on its own limit;
                  {' '}its margin peak is the sum of each one&apos;s.
                  {cols.filter((c) => c.m?.problem).map((c) => ` ${c.s.name}: ${c.m!.problem}`).join('')}
                  {bySettings.length > MOST && ` The first ${MOST} of ${bySettings.length} are shown.`}
                  {saves.length > bySettings.length && ` ${saves.length - bySettings.length} worked by a strategy keep the strategy's methods, and are not listed.`}
                </p>
              </Updating>
            )}
        {edited && (
          <SavedMethodsPicker key={edited.id} save={edited} busy={busy} now={now} period={period} onPeriod={setPeriod} onClose={() => setEditing(null)} onUpdate={(methods) => void update(edited, methods)} />
        )}
      </div>
    </Panel>
  );
}
