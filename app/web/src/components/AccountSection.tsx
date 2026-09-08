import { useEffect, useState } from 'react';
import type { AccountResponse } from '../types';
import { getAccount } from '../api';
import { CardLead, Note } from './ui/card';
import { Stat, StatDivider } from './ui/stat';
import { SectionTitle } from './ui/section';

/**
 * Balance and open positions, only when a key is set.
 *
 * Nothing else on this desk needs one, and there is no code path here that can
 * place or cancel an order. It sits under the contract because "can I afford
 * this" belongs next to "what would it cost", not in a card of its own three
 * columns away.
 */
export function AccountSection({ usdinr }: { usdinr: number }) {
  const [data, setData] = useState<AccountResponse | null>(null);

  useEffect(() => {
    getAccount().then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;

  const head = (
    <>
      <StatDivider />
      <SectionTitle hint="Read-only. This desk cannot place or cancel an order.">
        your account · read-only
      </SectionTitle>
    </>
  );

  if (!data.configured) {
    return (
      <>
        {head}
        <Stat label="not connected" value="no key set" tone="dim" />
        <Note tone="dim">
          Everything else works without one. A <b>new, read-only</b> key in{' '}
          <code>app/server/.env</code> shows your balance — never one that has been in
          a chat or a screenshot.
        </Note>
      </>
    );
  }

  if (data.error) {
    return (
      <>
        {head}
        <Stat label="key rejected" value={data.error} tone="down" />
        <Note tone="dim">
          Usually revoked, or this server's address is not on the key's allowed list.
        </Note>
      </>
    );
  }

  const lots = data.maxLots ?? 0;
  const usd = data.availableUsd ?? 0;
  // $0.00 on a balance of seven thousandths of a cent reads like a broken panel
  const shown = usd > 0 && usd < 0.01 ? usd.toFixed(5) : usd.toFixed(2);
  const inr = data.availableInr ?? 0;

  return (
    <>
      {head}
      <CardLead tone={lots > 0 ? 'plain' : 'warn'}>${shown}</CardLead>
      <Stat label="in rupees" value={`₹${inr < 1 ? inr.toFixed(3) : inr.toFixed(0)}`} />
      <Stat label="margin per lot" value="$0.50 · ₹42.50" tone="dim" />
      <Stat
        label="lots this covers"
        value={lots}
        tone={lots > 0 ? 'up' : 'warn'}
        hint={lots === 0 ? `Ten lots needs $5, about ₹${(5 * usdinr).toFixed(0)}.` : undefined}
      />

      {data.positions && data.positions.length > 0 && (
        <>
          <StatDivider />
          {data.positions.map((p, i) => (
            <Stat
              key={i}
              label={p.product_symbol ?? '—'}
              value={`${p.size} @ ${p.entry_price} · ${Number(p.unrealized_pnl ?? 0).toFixed(2)}`}
              tone={Number(p.unrealized_pnl ?? 0) >= 0 ? 'up' : 'down'}
            />
          ))}
        </>
      )}
    </>
  );
}
