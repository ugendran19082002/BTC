import { CheckCircle2, Hourglass, Target, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * What just happened, said once, on whatever screen is open (owner, 6 Oct 2026): an order began waiting, an order
 * filled, a position closed -- a card that slides down under the header, stays a few seconds and opens the trade
 * when tapped. Read out politely to a screen reader; it never takes the focus and never needs an answer.
 */

export type Toast = {
  id: string;
  kind: 'waiting' | 'filled' | 'closed' | 'gone';
  /** For a close: whether it made or lost, once that is known. */
  tone?: 'up' | 'down';
  title: string;
  detail?: string;
  tradeId?: string;
};

const LOOK = {
  waiting: { icon: Hourglass, colour: 'text-[var(--warn)]', edge: 'border-l-[var(--warn)]' },
  filled: { icon: CheckCircle2, colour: 'text-[var(--up)]', edge: 'border-l-[var(--up)]' },
  closed: { icon: Target, colour: 'text-foreground', edge: 'border-l-[var(--buy)]' },
  gone: { icon: XCircle, colour: 'text-muted-foreground', edge: 'border-l-[var(--dim)]' },
} as const;

export function Toasts({ toasts, onOpen, onDismiss }: { toasts: Toast[]; onOpen: (tradeId: string) => void; onDismiss: (id: string) => void }) {
  return (
    <div
      role="status" aria-live="polite" aria-label="Live events"
      className="pointer-events-none fixed inset-x-0 top-[calc(58px+env(safe-area-inset-top))] z-50 mx-auto flex max-w-[560px] flex-col gap-2 px-3"
    >
      {toasts.map((t) => {
        const look = LOOK[t.kind];
        const edge = t.kind === 'closed' && t.tone ? (t.tone === 'up' ? 'border-l-[var(--up)]' : 'border-l-[var(--down)]') : look.edge;
        const colour = t.kind === 'closed' && t.tone ? (t.tone === 'up' ? 'text-[var(--up)]' : 'text-[var(--down)]') : look.colour;
        return (
          <div key={t.id} className={cn('m-toast pointer-events-auto flex items-stretch overflow-hidden rounded-xl border border-l-4 border-border bg-[var(--panel-2)] shadow-[var(--shadow-lift)]', edge)}>
            <button
              type="button" disabled={!t.tradeId} onClick={() => t.tradeId && onOpen(t.tradeId)}
              className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent px-3 py-2.5 text-left font-[inherit] text-foreground disabled:cursor-default"
            >
              <look.icon aria-hidden="true" className={cn('h-5 w-5 shrink-0', colour)} />
              <span className="min-w-0">
                <span className={cn('block truncate text-[14px] font-semibold', colour)}>{t.title}</span>
                {t.detail && <span className="block truncate text-[12.5px] text-muted-foreground">{t.detail}</span>}
              </span>
            </button>
            <button type="button" aria-label="Dismiss" onClick={() => onDismiss(t.id)} className="grid w-11 shrink-0 place-items-center border-0 bg-transparent text-muted-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
