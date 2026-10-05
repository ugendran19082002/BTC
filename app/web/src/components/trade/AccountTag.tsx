/**
 * Whose trade it is: shown only where several accounts' trades are on one screen ("All accounts"), so a row is
 * never read as another account's. Nothing on an account's own tab, where every row is that account's.
 */
export function AccountTag({ account }: { account: { id: number; name: string } | null | undefined }) {
  if (!account) return null;
  return (
    <span aria-label="account" title={`Broker account: ${account.name}`}
          className="inline-flex items-center rounded border border-solid border-[#3b82f6]/40 bg-[#3b82f6]/10 px-1.5 py-px text-[10.5px] font-semibold text-[#60a5fa]">
      {account.name}
    </span>
  );
}
