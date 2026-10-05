import { KeyRound } from 'lucide-react';

/**
 * Whose trade it is: shown only where several accounts' trades are on one screen ("All accounts"), so a row is
 * never read as another account's. Nothing on an account's own tab, where every row is that account's.
 */
export function AccountTag({ account }: { account: { id: number; name: string } | null | undefined }) {
  if (!account) return null;
  return (
    <span aria-label="account" title={`Broker account: ${account.name}`}
          className="inline-flex items-center gap-1 rounded border border-solid border-[var(--accent-line)] bg-[var(--accent-soft)] px-1.5 py-px text-[10.5px] font-semibold text-[var(--accent)]">
      {/* The key the account tabs wear: an account called "SELL" must not read as the SELL beside it. */}
      <KeyRound size={10} aria-hidden />
      {account.name}
    </span>
  );
}
