import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import type { FlowRecord } from '@/api/ledger';
import { usdToInr } from '@/lib/format';
import { dayLabel } from '@/lib/market-report';

/**
 * The money in -- or out -- date by date (owner, 20 Nov 2026: "invested click panna, withdraw click panna, open popup,
 * date wise record"): each day with its total, and under it each kind that made it -- a deposit, money moved in from
 * another account, a withdrawal, money moved out -- with the account where every account is shown. The same sheet as a
 * ledger day's trades: from the bottom, over the tab bar, Escape or the cross to close.
 */
const rupees = (usd: number) => `₹${Math.round(Math.abs(usdToInr(usd) ?? 0)).toLocaleString('en-IN')}`;

/** The kind in words, by its direction: a transfer between accounts reads "Moved in" or "Moved out". */
export function kindWords(type: string, dir: 'in' | 'out'): string {
  if (type === 'sub_account_transfer') return dir === 'in' ? 'Moved in from another account' : 'Moved out to another account';
  if (type === 'withdrawal_cancellation') return 'Withdrawal cancelled';
  if (type.includes('withdrawal')) return type.startsWith('fund') ? 'Fund withdrawal' : 'Withdrawal';
  if (type.includes('deposit')) return type.startsWith('fund') ? 'Fund deposit' : type === 'external_deposit' ? 'External deposit' : 'Deposit';
  return type.replace(/_/g, ' ');
}

export function FlowsSheet({ dir, records, accounts, showAccount, onClose }: {
  dir: 'in' | 'out';
  records: readonly FlowRecord[];
  /** Account names by id, for "every account". */
  accounts: ReadonlyMap<number, string>;
  showAccount: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = before; window.removeEventListener('keydown', esc); };
  }, [onClose]);

  const mine = useMemo(() => records.filter((r) => (dir === 'in' ? r.inUsd > 0 : r.outUsd > 0)), [records, dir]);
  const amount = (r: FlowRecord) => (dir === 'in' ? r.inUsd : r.outUsd);
  const days = useMemo(() => {
    const by = new Map<string, FlowRecord[]>();
    for (const r of mine) by.set(r.day, [...(by.get(r.day) ?? []), r]);
    return [...by.entries()];
  }, [mine]);
  const total = mine.reduce((n, r) => n + amount(r), 0);
  const title = dir === 'in' ? 'Invested' : 'Withdrawn';
  const tone = dir === 'in' ? 'text-[var(--up)]' : 'text-[var(--down)]';

  return (
    <div className="fixed inset-0 z-[25] flex items-end justify-center" role="presentation">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 border-0 bg-black/60 p-0" tabIndex={-1} />
      <div role="dialog" aria-modal="true" aria-labelledby="flows-title"
        className="relative flex max-h-[92vh] w-full max-w-[560px] flex-col rounded-t-2xl border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
        <div className="px-4 pt-2">
          <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--line)]" />
          <div className="flex items-center justify-between gap-2">
            <h2 id="flows-title" className="m-0 min-w-0 truncate text-[17px] font-semibold">{title} · date wise</h2>
            <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-md border-0 bg-transparent text-muted-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div aria-label="Total" className="mb-2 flex items-baseline justify-between gap-2 border-0 border-b border-solid border-[var(--line-soft)] pb-2">
            <span className="text-[13px] text-muted-foreground">{mine.length} record{mine.length === 1 ? '' : 's'} · {days.length} day{days.length === 1 ? '' : 's'}</span>
            <span className={`text-[22px] font-semibold tabular-nums ${tone}`}>{rupees(total)}</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {days.length === 0 ? (
            <p className="m-0 py-6 text-center text-[13px] text-muted-foreground">{dir === 'in' ? 'No money put in yet.' : 'No money taken out yet.'}</p>
          ) : (
            <ul aria-label={`${title}, date wise`} className="m-0 grid list-none gap-3 p-0">
              {days.map(([day, rs]) => (
                <li key={day} aria-label={dayLabel(day)}>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-semibold text-[var(--time)]">{dayLabel(day)}</span>
                    <span className={`text-[14px] font-semibold tabular-nums ${tone}`}>{rupees(rs.reduce((n, r) => n + amount(r), 0))}</span>
                  </div>
                  <ul className="m-0 grid list-none gap-1 rounded-lg bg-muted p-0 px-3 py-2">
                    {rs.map((r) => (
                      <li key={`${r.account}-${r.type}`} className="flex min-w-0 items-baseline justify-between gap-2 text-[13px]">
                        <span className="min-w-0">
                          <span className="block truncate">{kindWords(r.type, dir)}</span>
                          <span className="block text-[11.5px] text-muted-foreground">
                            {showAccount ? `${accounts.get(r.account) ?? `Account ${r.account}`} · ` : ''}{r.n} entr{r.n === 1 ? 'y' : 'ies'}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums">{rupees(amount(r))}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 mt-3 text-[11px] leading-snug text-muted-foreground">
            One line a day and a kind, as the ledger keeps them. A day read before 20 Nov with money both in and out of one kind shows only the difference.
          </p>
        </div>
      </div>
    </div>
  );
}
