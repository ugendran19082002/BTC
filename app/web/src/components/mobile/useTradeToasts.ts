import { useCallback, useEffect, useRef, useState } from 'react';
import { getTradeDetail } from '@/api/phone';
import type { Trade } from '@/types/trade';
import type { Toast } from '@/components/mobile/Toasts';
import { contractLabel, price, signedInr, usdToInr } from '@/lib/format';
import { tradeEvents, tradeWords } from '@/lib/trade-events';

/**
 * The phone's live toasts (owner, 6 Oct 2026): each reading of the open trades against the one before it, and a
 * toast for what changed -- an order waiting, an order filled, a position closed, an order gone unfilled.
 *
 * The first reading, and the first after the account shown changes, is only the baseline: opening the app, or
 * looking at another account, is not twenty things happening at once. A close is said at once and then completed
 * with how it ended and what it made, from the trade's own record, when that answers.
 */

const SHOW_MS = 7_000;
const AT_MOST = 3;

const ENDED: Record<string, string> = {
  'option-tgt': 'Target hit', 'perp-tgt': 'Target hit', 'option-sl': 'Stop hit', 'perp-sl': 'Stop hit',
  'window-end': 'Closed at its exit time', manual: 'Closed by hand',
};

export function useTradeToasts(open: readonly Trade[] | undefined, scope: string): { toasts: Toast[]; dismiss: (id: string) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prev = useRef<{ scope: string; open: readonly Trade[] } | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  /** Show, or replace the one of the same id, and start its clock again. */
  const show = useCallback((toast: Toast) => {
    setToasts((cur) => [toast, ...cur.filter((x) => x.id !== toast.id)].slice(0, AT_MOST));
    const old = timers.current.get(toast.id);
    if (old) clearTimeout(old);
    timers.current.set(toast.id, setTimeout(() => dismiss(toast.id), SHOW_MS));
  }, [dismiss]);

  useEffect(() => {
    if (!open) return;
    const before = prev.current;
    prev.current = { scope, open };
    if (!before || before.scope !== scope) return;
    const events = tradeEvents(before.open, open);
    if (events.length === 0) return;
    for (const e of events) {
      const id = `${e.trade.account?.id ?? ''}:${e.tradeId}:${e.kind}`;
      const words = tradeWords(e.trade, contractLabel);
      const account = e.trade.account ? ` · ${e.trade.account.name}` : '';
      if (e.kind === 'waiting') {
        const limit = e.trade.plan?.entry.limitPrice;
        show({ id, kind: 'waiting', title: 'Order waiting', detail: `${words}${limit != null ? ` @ ${price(limit)}` : ''}${account}`, tradeId: e.tradeId });
      } else if (e.kind === 'filled') {
        show({ id, kind: 'filled', title: 'Order filled', detail: `${words} @ ${price(e.trade.entryAvgPrice)}${account}`, tradeId: e.tradeId });
      } else if (e.kind === 'gone') {
        show({ id, kind: 'gone', title: 'Order not filled', detail: `${words} · cancelled or expired${account}`, tradeId: e.tradeId });
      } else {
        show({ id, kind: 'closed', title: 'Position closed', detail: `${words}${account}`, tradeId: e.tradeId });
        // How it ended and what it made: the trade's own record says. Not answered: the first toast stands.
        getTradeDetail(e.tradeId).then(({ trade }) => {
          const net = trade.netRealisedUsd ?? trade.realisedPnl;
          show({
            id, kind: 'closed', tone: net > 0 ? 'up' : net < 0 ? 'down' : undefined,
            title: (trade.exitBy && ENDED[trade.exitBy]) || 'Position closed',
            detail: `${words} · ${signedInr(usdToInr(net))}${account}`, tradeId: e.tradeId,
          });
        }).catch(() => undefined);
      }
    }
    // A short buzz where the phone has one: something happened while the screen was on.
    try { navigator.vibrate?.(30); } catch { /* not allowed here: the toast is enough */ }
  }, [open, scope, show]);

  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t); }, []);

  return { toasts, dismiss };
}
