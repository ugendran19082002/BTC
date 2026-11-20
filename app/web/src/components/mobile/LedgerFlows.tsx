import { useState, type ReactNode } from 'react';
import { getLedgerFlows } from '@/api/ledger';
import { FlowsSheet } from '@/components/mobile/FlowsSheet';
import { usePoll } from '@/hooks/usePoll';
import { signedInr, usdToInr } from '@/lib/format';
import { dayLabel } from '@/lib/market-report';
import { Loading, Panel, Rupees, Stat, Stats } from '@/components/mobile/parts';

/**
 * Money in and out, on the phone's Ledger (owner, 20 Nov 2026: "ledger total withdraw, total investment add, user
 * friendly, mobile friendly"): what was put in, what was taken out, the net, the wallet as last read and what the money
 * has made -- since the first ledger day -- and, under it, the money in and out over the range picked above. Read from the
 * days the ledger keeps; nothing asked of Delta.
 */
const rupees = (usd: number | null | undefined) => (usd === null || usd === undefined ? '—' : `₹${Math.round(Math.abs(usdToInr(usd) ?? 0)).toLocaleString('en-IN')}`);

export function LedgerFlows({ from, to, account, rangeWords, accounts = [], bare = false }: {
  from: string; to: string; account: number | null; rangeWords: string; accounts?: readonly { id: number; name: string }[];
  /** Inside another card (the Ledger's totals, 20 Nov 2026: "merge, mobile responsive"): its own heading as a divider, no panel of its own. */
  bare?: boolean;
}) {
  // The tile tapped: its money date by date, in a sheet (20 Nov 2026).
  const [open, setOpen] = useState<'in' | 'out' | null>(null);
  const { data: f, error } = usePoll(() => getLedgerFlows(from, to, account), 120_000, { deps: [from, to, account] });
  const wrap = (body: ReactNode) => (bare ? <>{body}</> : <Panel title="Money in & out">{body}</Panel>);
  if (!f) return wrap(<Loading error={error} what="money in and out" />);
  const a = f.allTime;
  const nothing = a.moves === 0;
  // From the first money in: an account's own start, not the ledger's first day.
  const since = `Since ${a.firstMoveDay ? dayLabel(a.firstMoveDay) : f.since ? dayLabel(f.since) : 'the first ledger day'}${account === null ? ' · every account' : ''}`;
  return wrap(
    <>
      <section aria-label="Money in and out" className={bare ? 'mt-3 grid gap-2.5 border-0 border-t border-solid border-[var(--line-soft)] pt-3' : 'grid gap-2.5'}>
        {bare ? (
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
            <span className="text-[13px] font-semibold">Money in &amp; out</span>
            <span className="text-[11.5px] text-muted-foreground">{since}</span>
          </div>
        ) : <p className="m-0 text-[12px] text-muted-foreground">{since}</p>}
        {nothing ? (
          <p className="m-0 text-[13px] text-muted-foreground">No money put in or taken out in the days the ledger has read.</p>
        ) : (
          <>
            <Stats cols={4}>
              <Stat label="Invested" tone="up" onOpen={() => setOpen('in')} openLabel="Invested: show it date wise">{rupees(a.inUsd)}</Stat>
              <Stat label="Withdrawn" tone={a.outUsd > 0 ? 'down' : 'dim'} onOpen={() => setOpen('out')} openLabel="Withdrawn: show it date wise">{rupees(a.outUsd)}</Stat>
              <Stat label="Net invested">{a.netUsd < 0 ? `−${rupees(a.netUsd)}` : rupees(a.netUsd)}</Stat>
              <Stat label={f.wallet.asOf ? `Wallet · ${dayLabel(f.wallet.asOf)}` : 'Wallet'}>{rupees(f.wallet.balanceUsd)}</Stat>
            </Stats>
            {f.profitUsd !== null && (
              <div aria-label="Made" className="flex min-w-0 items-baseline justify-between gap-2 rounded-lg bg-muted px-3 py-2">
                <span className="min-w-0 text-[12.5px] leading-snug text-muted-foreground">Made<span className="block text-[11px]">wallet − net invested</span></span>
                <Rupees usd={f.profitUsd} signed size="lg" />
              </div>
            )}
          </>
        )}
        <div aria-label="In the range" className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-0 border-t border-solid border-[var(--line-soft)] pt-2 text-[12.5px] tabular-nums">
          <span className="text-muted-foreground">{rangeWords}</span>
          <span>
            <span className="text-[var(--up)]">in {rupees(f.range.inUsd)}</span>
            <span className="text-muted-foreground"> · </span>
            <span className={f.range.outUsd > 0 ? 'text-[var(--down)]' : 'text-muted-foreground'}>out {rupees(f.range.outUsd)}</span>
            {f.range.moves > 0 && <span className="text-muted-foreground"> · net {signedInr(usdToInr(f.range.netUsd))}</span>}
          </span>
        </div>
      </section>
      {open && (
        <FlowsSheet
          dir={open} records={f.records ?? []} showAccount={account === null}
          accounts={new Map(accounts.map((x) => [x.id, x.name]))} onClose={() => setOpen(null)}
        />
      )}
    </>,
  );
}
