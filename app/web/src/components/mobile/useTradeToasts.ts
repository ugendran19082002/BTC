import { useCallback, useEffect, useRef, useState } from 'react';
import { getTradeDetail } from '@/api/phone';
import type { Trade } from '@/types/trade';
import type { Toast } from '@/components/mobile/Toasts';
import { contractLabel, duration, price, signedInr, usdToInr } from '@/lib/format';
import { tradeEvents, tradeWords, type TradeEvent } from '@/lib/trade-events';

/**
 * The phone's live toasts (owner, 6 Oct 2026): each reading of the open trades against the one before it, and a
 * toast for what changed -- an order waiting, an order filled, a position closed, an order gone unfilled.
 *
 * The rules that keep it from crying wolf:
 *
 *   - The first reading, and the first after the account shown changes, is only the baseline: opening the app, or
 *     looking at another account, is not twenty things happening at once.
 *   - Readings far apart (the screen was off, or the browser tab was in the background) and readings with more than
 *     three changes say nothing: no stack that cannot be read before it goes, and no summary either -- the owner had
 *     it removed (9 Oct 2026): "56 things just happened" on coming back to the tab told nothing Orders does not.
 *   - The same thing about the same trade is said once in ten minutes, whatever the readings do.
 *   - A close is said at once and then completed with how it ended and what it made, from the trade's own record
 *     -- completed where it stands: a toast already pushed away is not brought back.
 */

/** Toasts on screen at once; more changes than this in one reading are summarised. */
export const AT_MOST = 3;
/** Readings further apart than this are a return to the app, not a moment in it. The poll is every 5 s. */
export const AWAY_MS = 45_000;
/** How long the same event of the same trade is not said again. */
export const REPEAT_MS = 10 * 60_000;

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

export function useTradeToasts(
  open: readonly Trade[] | undefined, scope: string, now: () => number = Date.now,
): { toasts: Toast[]; dismiss: (id: string) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prev = useRef<{ scope: string; open: readonly Trade[]; at: number } | null>(null);
  const said = useRef(new Map<string, number>());

  // A toast times itself out and animates its own leaving (Toasts.tsx); this only keeps the list.
  const dismiss = useCallback((id: string) => setToasts((cur) => cur.filter((x) => x.id !== id)), []);
  const add = useCallback((toast: Toast) => setToasts((cur) => [toast, ...cur.filter((x) => x.id !== toast.id)].slice(0, AT_MOST)), []);
  /** Change one that is still on screen; one already gone stays gone. */
  const complete = useCallback((toast: Toast) => setToasts((cur) => cur.map((x) => (x.id === toast.id ? toast : x))), []);

  useEffect(() => {
    if (!open) return;
    const at = now();
    const before = prev.current;
    prev.current = { scope, open, at };
    if (!before || before.scope !== scope) return;

    // Not said in the last ten minutes: a reading that flickers cannot say one thing twice.
    for (const [k, t] of said.current) if (at - t > REPEAT_MS) said.current.delete(k);
    const idOf = (e: TradeEvent) => `${e.trade.account?.id ?? ''}:${e.tradeId}:${e.kind}`;
    const events = tradeEvents(before.open, open).filter((e) => !said.current.has(idOf(e)));
    if (events.length === 0) return;
    for (const e of events) said.current.set(idOf(e), at);

    // Back to the tab, or a burst: marked as said above, and nothing shown -- Orders and History list them.
    if (at - before.at > AWAY_MS || events.length > AT_MOST) return;
    {
      for (const e of events) {
        const id = idOf(e);
        const words = tradeWords(e.trade, contractLabel);
        const by = openedBy(e.trade) || undefined;
        if (e.kind === 'waiting') {
          const limit = e.trade.plan?.entry.limitPrice;
          add({ id, kind: 'waiting', title: 'Order waiting', detail: `${words}${limit != null ? ` @ ${price(limit)}` : ' at market'}`, more: by, tradeId: e.tradeId });
        } else if (e.kind === 'filled') {
          const exits = [e.trade.plan?.takeProfitPrice ? `TGT ${price(e.trade.plan.takeProfitPrice)}` : null, e.trade.plan?.stopPrice ? `SL ${price(e.trade.plan.stopPrice)}` : null].filter(Boolean).join(' · ');
          add({ id, kind: 'filled', title: 'Order filled', detail: `${words} @ ${price(e.trade.entryAvgPrice)}`, more: [exits || null, by ?? null].filter(Boolean).join(' · ') || undefined, tradeId: e.tradeId });
        } else if (e.kind === 'gone') {
          add({ id, kind: 'gone', title: 'Order not filled', detail: words, more: ['cancelled or expired', by ?? null].filter(Boolean).join(' · '), tradeId: e.tradeId });
        } else {
          add({ id, kind: 'closed', title: 'Position closed', detail: words, more: by, tradeId: e.tradeId });
          // How it ended and what it made: the trade's own record says. Not answered: the first toast stands.
          getTradeDetail(e.tradeId).then(({ trade }) => {
            const net = trade.netRealisedUsd ?? trade.realisedPnl;
            const entryAt = trade.fills.filter((f) => f.role === 'entry').reduce<number | null>((m, f) => (m === null || f.ts < m ? f.ts : m), null);
            const exitAt = trade.fills.filter((f) => f.role !== 'entry').reduce<number | null>((m, f) => (m === null || f.ts > m ? f.ts : m), null);
            const heldFor = entryAt !== null && exitAt !== null ? ` · held ${duration(exitAt - entryAt)}` : '';
            complete({
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
    }
    // One short buzz for the reading, where the phone has one: something happened while the screen was on.
    try { navigator.vibrate?.(30); } catch { /* not allowed here: the toast is enough */ }
  }, [open, scope, add, complete, now]);

  return { toasts, dismiss };
}
