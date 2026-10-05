import { getAccountSummary, type BrokerAccount } from '@/api/accounts';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Money } from '@/components/ui/money';
import { usePoll } from '@/hooks/usePoll';
import { contractLabel, price, size } from '@/lib/format';

/**
 * An account that is switched off, as Delta has it right now: its wallet and whatever it holds there, read
 * with its own key. Shown on Positions in place of a desk's positions, because an account that is off has no
 * desk -- every account that is switched on trades, and shows its own positions like the default's.
 */
export function AccountSummaryCard({ account }: { account: BrokerAccount }) {
  const { data, error } = usePoll(() => getAccountSummary(account.id), 15_000, { deps: [account.id] });
  const kpi = (label: string, value: React.ReactNode) => (
    <div className="rounded-md border border-solid border-border px-3 py-2">
      <dt className="text-[10.5px] uppercase tracking-[0.4px] text-muted-foreground">{label}</dt>
      <dd className="m-0 mt-0.5 text-[13.5px] font-semibold text-foreground">{value}</dd>
    </div>
  );
  return (
    <CollapsibleCard id="account-summary" title={`${account.name} — on Delta now`} ariaLabel="account summary"
      right={<span className="text-[11px] text-muted-foreground">switched off — not trading</span>}>
      <p className="m-0 mb-2 text-[12px] text-muted-foreground">
        <b className="text-foreground">{account.name}</b> is switched off, so the desk places and manages nothing on it.
        Activate it under Logs → Accounts and its own strategies trade on it, beside the other accounts.
      </p>
      {error && !data && <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">Could not read the account: {error.message}</p>}
      {data && (
        <>
          <dl className="m-0 mb-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {kpi('Wallet balance', <Money value={data.wallet?.balance ?? null} />)}
            {kpi('Free to trade', <Money value={data.wallet?.available ?? null} />)}
            {kpi('Positions on Delta', data.wallet ? data.positions.length : '—')}
            {kpi('Trades on record', data.trades.toLocaleString('en-US'))}
            {kpi('Strategies', data.strategies.toLocaleString('en-US'))}
          </dl>
          {data.note && <p className="m-0 mb-2 text-[12px] text-[var(--warn)]">{data.note}</p>}
          {data.positions.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-solid border-border">
              <table aria-label={`positions on ${account.name}`} className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th scope="col" className="px-2 py-1.5 text-left font-semibold">Contract</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Lots</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Entry</th>
                    <th scope="col" className="px-2 py-1.5 text-right font-semibold">Unrealised</th>
                  </tr>
                </thead>
                <tbody>
                  {data.positions.map((p) => (
                    <tr key={p.symbol} className="border-t border-solid border-border">
                      <td className="px-2 py-1 text-left">{contractLabel(p.symbol)} <span className="text-[var(--dim)]">{p.size < 0 ? 'short' : 'long'}</span></td>
                      <td className="px-2 py-1 text-right tabular-nums">{size(p.size)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{price(p.entryPrice)}</td>
                      <td className="px-2 py-1 text-right"><Money value={p.unrealisedPnl} signed /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.wallet && data.positions.length === 0 && <p className="m-0 text-[12px] text-muted-foreground">Nothing held on this account.</p>}
        </>
      )}
    </CollapsibleCard>
  );
}
