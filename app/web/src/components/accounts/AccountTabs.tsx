import { KeyRound, Layers } from 'lucide-react';
import type { BrokerAccount } from '@/api/accounts';
import { cn } from '@/lib/utils';

/**
 * Which broker account the screen below is showing (owner, 5 Oct 2026): a tab per account over Strategy,
 * Positions, Orders and P&L, opening on the default.
 *
 * Every account that is switched on trades its own strategies at once; a tab only chooses whose are *shown*,
 * and the default is only which tab opens first. Looking at another account moves no order anywhere.
 */
export type AccountChoice = number | 'all';

export function AccountTabs({ accounts, value, onChange, withAll = true, openCounts, openTotal }: {
  accounts: readonly BrokerAccount[];
  value: AccountChoice;
  onChange: (c: AccountChoice) => void;
  /** Trades open on each trading account, by id -- worn on its tab; an account not in it (switched off, not read yet) wears none. */
  openCounts?: ReadonlyMap<number, number>;
  /** Every account's open trades together, for "All accounts": the Positions badge's number. */
  openTotal?: number | null;
  /** False on Strategy: a strategy belongs to one account, so there is no "All accounts" to choose there. */
  withAll?: boolean;
}) {
  if (accounts.length === 0) return null;
  // The default first, then as they were added.
  const ordered = [...accounts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id);
  const tab = (on: boolean) => cn(
    'm-0 inline-flex h-9 shrink-0 appearance-none items-center gap-1.5 rounded-md border-0 px-3 font-[inherit] text-[12.5px]',
    on ? 'bg-primary font-semibold text-primary-foreground' : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
  );
  // How many trades are open there (owner, 6 Oct 2026): the Positions badge is every account's, and each tab says its share.
  const count = (n: number | null | undefined, on: boolean) => (n === null || n === undefined ? null : (
    <span aria-label={`${n} open`}
          className={cn('rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums leading-tight',
            on ? 'bg-black/15' : n > 0 ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-muted text-[var(--dim)]')}>
      {n}
    </span>
  ));
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
      <div role="tablist" aria-label="Broker account" className="inline-flex max-w-full overflow-x-auto rounded-lg border border-solid border-border bg-[var(--panel)] p-1">
        {ordered.map((a) => (
          <button
            key={a.id} type="button" role="tab" aria-selected={value === a.id} className={tab(value === a.id)} onClick={() => onChange(a.id)}
            title={!a.active ? 'Switched off: not trading' : a.isDefault ? 'Trading · the default: this tab opens first' : 'Trading'}
          >
            {/* Which account is the default is the desk's own business -- which tab opens first -- and is not worn here (owner, 5 Oct 2026). */}
            <KeyRound size={13} aria-hidden /> {a.name}
            {count(openCounts?.get(a.id), value === a.id)}
            {!a.active && ' '}
            {!a.active && <span className="rounded-full border border-solid border-current px-1.5 py-[1px] text-[10px] opacity-80">off</span>}
          </button>
        ))}
        {withAll && accounts.length > 1 && (
          <button type="button" role="tab" aria-selected={value === 'all'} className={tab(value === 'all')} onClick={() => onChange('all')}>
            <Layers size={13} aria-hidden /> All accounts
            {count(openTotal, value === 'all')}
          </button>
        )}
      </div>
    </div>
  );
}

/** The account the tabs show: the one chosen if it is still there, else the one the desk trades on. */
export function shownAccount(accounts: readonly BrokerAccount[], choice: AccountChoice | null, withAll = true): AccountChoice {
  // Where "All accounts" is not offered (Strategy), a remembered "all" shows the default account instead.
  if (choice === 'all' && accounts.length > 1 && withAll) return 'all';
  if (typeof choice === 'number' && accounts.some((a) => a.id === choice)) return choice;
  return accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? 'all';
}
