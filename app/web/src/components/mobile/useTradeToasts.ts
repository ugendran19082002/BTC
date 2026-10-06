import { useCallback, useEffect, useRef, useState } from 'react';
import { getTradeDetail } from '@/api/phone';
import type { Trade } from '@/types/trade';
import type { Toast } from '@/components/mobile/Toasts';
import { contractLabel, duration, price, signedInr, usdToInr } from '@/lib/format';
import { tradeEvents, tradeWords } from '@/lib/trade-events';

/**
 * The phone's live toasts (owner, 6 Oct 2026): each reading of the open trades against the one before it, and a
 * toast for what changed -- an order waiting, an order filled, a position closed, an order gone unfilled.
 *
 * The first reading, and the first after the account shown changes, is only the baseline: opening the app, or
 * looking at another account, is not twenty things happening at once. A close is said at once and then completed
 * with how it ended and what it made, from the trade's own record, when that answers.
 */

const AT_MOST = 3;

const ENDED: Record<string, string> = {
  'option-tgt': 'Target hit', 'perp-tgt': 'Target hit', 'option-sl': 'Stop hit', 'perp-sl': 'Stop hit',
  'window-end': 'Closed at its exit time', manual: 'Closed by hand',
};

/** What opened it, in a few words: the method and the strategy, or "by hand". */
const openedBy = (t: Trade): string => {
  const sig = t.plan?.signal;
  const parts = [sig ? `#${sig.n} ${sig.name} · ${sig.tf}` : null, t.plan?.strategyName ?? (t.plan?.origin === 'manual' ? 'by hand' : null), t.account?.name ?? null];
  return parts.filter(Boolean).join(' · ');
};

export function useTradeToasts(open: readonly Trade[] | undefined, scope: string): { toasts: Toast[]; dismiss: (id: string) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prev = useRef<{ scope: string; open: readonly Trade[] } | null>(null);

  // A toast times itself out and animates its own leaving (Toasts.tsx); this only keeps the list.
  const dismiss = useCallback((id: string) => setToasts((cur) => cur.filter((x) => x.id !== id)), []);
  /** Show, or replace the one of the same id in its place. */
  const show = useCallback((toast: Toast) => {
    setToasts((cur) => (cur.some((x) => x.id === toast.id) ? cur.map((x) => (x.id === toast.id ? toast : x)) : [toast, ...cur].slice(0, AT_MOST)));
  }, []);

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
      const by = openedBy(e.trade) || undefined;
      if (e.kind === 'waiting') {
        const limit = e.trade.plan?.entry.limitPrice;
        show({ id, kind: 'waiting', title: 'Order waiting', detail: `${words}${limit != null ? ` @ ${price(limit)}` : ' at market'}`, more: by, tradeId: e.tradeId });
      } else if (e.kind === 'filled') {
        const exits = [e.trade.plan?.takeProfitPrice ? `TGT ${price(e.trade.plan.takeProfitPrice)}` : null, e.trade.plan?.stopPrice ? `SL ${price(e.trade.plan.stopPrice)}` : null].filter(Boolean).join(' · ');
        show({ id, kind: 'filled', title: 'Order filled', detail: `${words} @ ${price(e.trade.entryAvgPrice)}`, more: [exits || null, by ?? null].filter(Boolean).join(' · ') || undefined, tradeId: e.tradeId });
      } else if (e.kind === 'gone') {
        show({ id, kind: 'gone', title: 'Order not filled', detail: words, more: ['cancelled or expired', by ?? null].filter(Boolean).join(' · '), tradeId: e.tradeId });
      } else {
        show({ id, kind: 'closed', title: 'Position closed', detail: words, more: by, tradeId: e.tradeId });
        // How it ended and what it made: the trade's own record says. Not answered: the first toast stands.
        getTradeDetail(e.tradeId).then(({ trade }) => {
          const net = trade.netRealisedUsd ?? trade.realisedPnl;
          const entryAt = trade.fills.filter((f) => f.role === 'entry').reduce<number | null>((m, f) => (m === null || f.ts < m ? f.ts : m), null);
          const exitAt = trade.fills.filter((f) => f.role !== 'entry').reduce<number | null>((m, f) => (m === null || f.ts > m ? f.ts : m), null);
          const heldFor = entryAt !== null && exitAt !== null ? ` · held ${duration(exitAt - entryAt)}` : '';
          show({
            id, kind: 'closed', tone: net > 0 ? 'up' : net < 0 ? 'down' : undefined,
            title: (trade.exitBy && ENDED[trade.exitBy]) || 'Position closed',
            amount: signedInr(usdToInr(net)),
            detail: words,
            more: `in ${price(trade.entryAvgPrice)} → out ${price(trade.exitAvgPrice)}${heldFor}`,
            tradeId: e.tradeId,
          });
        }).catch(() => undefined);
      }
    }
    // A short buzz where the phone has one: something happened while the screen was on.
    try { navigator.vibrate?.(30); } catch { /* not allowed here: the toast is enough */ }
  }, [open, scope, show]);

  return { toasts, dismiss };
}
