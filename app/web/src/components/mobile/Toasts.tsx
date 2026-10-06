import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckCircle2, Hourglass, ListChecks, Target, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * What just happened, said once, on whatever screen is open (owner, 6 Oct 2026): an order began waiting, an order
 * filled, a position closed -- a card that slides down under the header and opens the trade when tapped.
 *
 * It goes the way a hand expects: pushed up or to either side it follows the finger and leaves; let go early and it
 * comes back. Left alone it fades after a few seconds, a thin bar showing how long, and waits while it is held.
 * Read out politely to a screen reader; it never takes the focus and never needs an answer.
 */

export type Toast = {
  id: string;
  /** `summary`: several things at once, or what happened while the screen was off -- one toast, not a stack. */
  kind: 'waiting' | 'filled' | 'closed' | 'gone' | 'summary';
  /** For a close: whether it made or lost, once that is known. */
  tone?: 'up' | 'down';
  title: string;
  /** What it was: "SELL 84,600 PE × 500 @ 45.20". */
  detail?: string;
  /** One more line: what opened it, or in → out and how long it was held. */
  more?: string;
  /** A figure worth its own place, at the right: what a close made. */
  amount?: string;
  /** What a tap opens: this trade's story... */
  tradeId?: string;
  /** ...or, for a summary, the screen that lists them. */
  to?: 'orders';
};

const LOOK = {
  waiting: { icon: Hourglass, colour: 'text-[var(--warn)]', edge: 'var(--warn)' },
  filled: { icon: CheckCircle2, colour: 'text-[var(--up)]', edge: 'var(--up)' },
  closed: { icon: Target, colour: 'text-foreground', edge: 'var(--buy)' },
  gone: { icon: XCircle, colour: 'text-muted-foreground', edge: 'var(--dim)' },
  summary: { icon: ListChecks, colour: 'text-foreground', edge: 'var(--buy)' },
} as const;

/** How long a toast stays when nobody touches it. */
export const TOAST_MS = 7_000;
/** How far a push must go to count: sideways, and upward. Less, and it comes back. */
const SWIPE_X = 72, SWIPE_UP = 36, TAP_SLOP = 8, LEAVE_MS = 220;

export function Toasts({ toasts, onOpen, onDismiss }: { toasts: Toast[]; onOpen: (toast: Toast) => void; onDismiss: (id: string) => void }) {
  return (
    <div
      role="status" aria-live="polite" aria-label="Live events"
      className="pointer-events-none fixed inset-x-0 top-[calc(58px+env(safe-area-inset-top))] z-50 mx-auto flex max-w-[560px] flex-col gap-2 px-3"
    >
      {toasts.map((t) => <ToastCard key={t.id} toast={t} onOpen={onOpen} onDismiss={onDismiss} />)}
    </div>
  );
}

type Leaving = 'left' | 'right' | 'up' | 'fade';

function ToastCard({ toast: t, onOpen, onDismiss }: { toast: Toast; onOpen: (toast: Toast) => void; onDismiss: (id: string) => void }) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  // Each time it is let go its time begins again, and the bar with it, so the two always agree.
  const [cycle, setCycle] = useState(0);

  const leave = useCallback((how: Leaving) => {
    setLeaving(how);
    setDrag(null);
    setTimeout(() => onDismiss(t.id), LEAVE_MS);
  }, [onDismiss, t.id]);

  // Its time on screen: begun again when what it says changes (a close completed with its result), held while touched.
  const held = drag !== null;
  useEffect(() => {
    if (held || leaving) return;
    const id = setTimeout(() => leave('fade'), TOAST_MS);
    return () => clearTimeout(id);
  }, [held, leaving, leave, t.title, t.detail, t.amount]);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (leaving) return;
    start.current = { x: e.clientX, y: e.clientY };
    moved.current = false;
    setDrag({ x: 0, y: 0 });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no capture here: the moves still arrive while over it */ }
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const x = e.clientX - start.current.x;
    const y = Math.min(0, e.clientY - start.current.y); // it can be pushed up, not pulled down over the screen
    if (Math.abs(x) > TAP_SLOP || y < -TAP_SLOP) moved.current = true;
    // One direction at a time, whichever the finger chose: sideways or up.
    setDrag(Math.abs(x) >= Math.abs(y) ? { x, y: 0 } : { x: 0, y });
  };
  const up = () => {
    if (!start.current) return;
    start.current = null;
    const d = drag ?? { x: 0, y: 0 };
    if (Math.abs(d.x) >= SWIPE_X) leave(d.x > 0 ? 'right' : 'left');
    else if (d.y <= -SWIPE_UP) leave('up');
    else { setDrag(null); setCycle((c) => c + 1); }
  };

  const look = LOOK[t.kind];
  const tone = t.kind === 'closed' ? t.tone : undefined;
  const colour = tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : look.colour;
  const edge = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : look.edge;
  const gone = leaving === 'left' ? 'translate(-120%, 0)' : leaving === 'right' ? 'translate(120%, 0)' : leaving === 'up' ? 'translate(0, -160%)' : null;
  const fade = drag ? Math.max(0.35, 1 - Math.max(Math.abs(drag.x) / 220, Math.abs(drag.y) / 120)) : 1;

  return (
    <div
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      // A push that travelled is not a tap: the buttons inside do not hear it.
      onClickCapture={(e) => { if (moved.current) { e.stopPropagation(); e.preventDefault(); moved.current = false; } }}
      className={cn(
        'm-toast pointer-events-auto relative flex touch-none select-none items-stretch overflow-hidden rounded-xl border border-border bg-[var(--panel-2)] shadow-[var(--shadow-lift)]',
        !drag && 'transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none',
      )}
      style={{
        borderLeft: `4px solid ${edge}`,
        transform: gone ?? (drag ? `translate(${drag.x}px, ${drag.y}px)` : undefined),
        opacity: leaving ? 0 : fade,
      }}
    >
      <button
        type="button" disabled={!t.tradeId && !t.to} onClick={() => (t.tradeId || t.to) && onOpen(t)}
        aria-label={[t.title, t.amount, t.detail, t.more, t.tradeId ? 'open the trade' : t.to ? 'open Orders' : null].filter(Boolean).join(', ')}
        className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent py-2.5 pl-3 pr-1 text-left font-[inherit] text-foreground disabled:cursor-default"
      >
        <look.icon aria-hidden="true" className={cn('h-5 w-5 shrink-0', colour)} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn('truncate text-[14.5px] font-semibold', colour)}>{t.title}</span>
            {t.amount && <span className={cn('shrink-0 whitespace-nowrap text-[15px] font-semibold tabular-nums', colour)}>{t.amount}</span>}
          </span>
          {t.detail && <span className="block truncate text-[13px] text-foreground">{t.detail}</span>}
          {t.more && <span className="block truncate text-[12px] text-muted-foreground">{t.more}</span>}
        </span>
      </button>
      <button type="button" aria-label="Dismiss" onClick={() => leave('fade')} className="grid w-11 shrink-0 place-items-center border-0 bg-transparent text-muted-foreground">
        <X className="h-4 w-4" />
      </button>
      {/* How long it stays, running down; it waits while the toast is held. Begun again when the toast is completed. */}
      {!leaving && (
        <span
          key={`${t.title}|${t.amount ?? ''}|${cycle}`} aria-hidden="true"
          className="m-toast-time absolute bottom-0 left-0 h-[2px] w-full origin-left"
          style={{ background: edge, animationDuration: `${TOAST_MS}ms`, animationPlayState: held ? 'paused' : 'running' }}
        />
      )}
    </div>
  );
}
