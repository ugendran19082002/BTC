import { useEffect, useState } from 'react';
import type { AccountResponse } from '../types';
import { getAccount } from '../api';
import { Card, CardTitle, CardLead, Note } from './ui/card';
import { Stat, StatDivider } from './ui/stat';

/**
 * Balance and open positions, only when a key is set.
 *
 * Nothing else on this desk needs one, and there is no code path here that can
 * place or cancel an order.
 */
export function AccountPanel({ usdinr }: { usdinr: number }) {
  const [data, setData] = useState<AccountResponse | null>(null);

  useEffect(() => {
    getAccount().then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;

  if (!data.configured) {
    return (
      <Card>
        <CardTitle>Your account</CardTitle>
        <p className="m-0 text-[13px] text-muted-foreground">Not connected.</p>
        <Note>
          Everything else here works without a key. To see your balance and open
          positions, put a <b>new, read-only</b> key in <code>app/server/.env</code>{' '}
          and redeploy.
        </Note>
        <div className="mt-2 rounded-md bg-muted px-2.5 py-2 font-mono text-[11.5px]">
          DELTA_API_KEY=…
          <br />
          DELTA_API_SECRET=…
        </div>
        <Note tone="warn">
          Do not reuse a key that has been in a chat or a screenshot. Treat that one
          as public and make a fresh one.
        </Note>
      </Card>
    );
  }

  if (data.error) {
    return (
      <Card>
        <CardTitle>Your account</CardTitle>
        <p className="m-0 text-[13px] text-[var(--down)]">{data.error}</p>
        <Note>
          The key is set but Delta rejected it. Usually it has been revoked, or this
          server's IP is not on the key's allowed list.
        </Note>
      </Card>
    );
  }

  const lots = data.maxLots ?? 0;

  return (
    <Card>
      <CardTitle>Your account</CardTitle>
      <CardLead>${data.availableUsd?.toFixed(2)}</CardLead>
      <Stat label="in rupees" value={`₹${(data.availableInr ?? 0).toFixed(0)}`} />
      <Stat label="margin per lot" value="$0.50" tone="dim" />
      <Stat label="lots this covers" value={lots} tone={lots > 0 ? 'up' : 'warn'} />

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

      <Note tone="dim">
        Read-only. This desk cannot place or cancel an order. ₹{usdinr} to the dollar.
      </Note>
    </Card>
  );
}
