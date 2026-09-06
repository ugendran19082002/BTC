import { useEffect, useState } from 'react';
import type { AccountResponse } from '../types';
import { getAccount } from '../api';

/**
 * Balances and open positions, when a key is configured.
 *
 * Market data needs no credentials and this panel is the only thing that does.
 * It stays dark until a key exists, and the server has no code path that can
 * place an order — reading is all it can do.
 */
export function AccountPanel({ usdinr }: { usdinr: number }) {
  const [data, setData] = useState<AccountResponse | null>(null);

  useEffect(() => {
    getAccount().then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;

  if (!data.configured) {
    return (
      <div className="card">
        <h2>Account</h2>
        <div className="muted">Not connected.</div>
        <div className="note">
          Balances, margin and open positions need a Delta API key; everything else
          on this desk does not. To switch it on, put a <b>new, read-only</b> key in
          <code> app/server/.env</code> and redeploy:
          <div className="formula" style={{ marginTop: 8 }}>
            DELTA_API_KEY=…<br />
            DELTA_API_SECRET=…
          </div>
          That file is git-ignored and never enters an image. Do not reuse a key that
          has been pasted into a chat or a screenshot — treat it as public and issue
          a fresh one.
        </div>
      </div>
    );
  }

  if (data.error) {
    return (
      <div className="card">
        <h2>Account</h2>
        <div className="down">{data.error}</div>
        <div className="note">
          The key is configured but Delta rejected the request. Usually the key was
          revoked, or the server's IP is not on the key's allowlist.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Account</h2>
      <div className="big">${data.availableUsd?.toFixed(2)}</div>
      <div className="kv"><span>available</span>
        <span>₹{(data.availableInr ?? 0).toFixed(0)}</span></div>
      <div className="kv"><span>margin per lot</span><span>$0.50</span></div>
      <div className="kv"><span>lots this funds</span>
        <span className="up">{data.maxLots}</span></div>
      {data.positions && data.positions.length > 0 && (
        <>
          <div className="kv" style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <span>open positions</span><span>{data.positions.length}</span>
          </div>
          {data.positions.map((p, i) => (
            <div className="kv" key={i}>
              <span className="dim">{p.product_symbol}</span>
              <span className={Number(p.unrealized_pnl ?? 0) >= 0 ? 'up' : 'down'}>
                {p.size} @ {p.entry_price} · {Number(p.unrealized_pnl ?? 0).toFixed(2)}
              </span>
            </div>
          ))}
        </>
      )}
      <div className="note">
        Read-only. This desk cannot place or cancel an order — there is no code
        path for it. {usdinr} rupees to the dollar.
      </div>
    </div>
  );
}
