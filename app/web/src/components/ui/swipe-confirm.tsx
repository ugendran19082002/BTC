import { useEffect, useRef, useState } from 'react';
import { ChevronsRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Drag the thumb to the end to confirm. A tap does nothing.
 *
 * For the actions that spend or close real money -- selling from the chain,
 * closing a position, closing everything. A button fires on any touch,
 * including the one made while scrolling past it or putting the phone down; a
 * swipe needs a deliberate movement across the whole track, which a hand
 * brushing the screen does not make.
 *
 * Keyboard: focus it and press Enter (or Space). A keyboard press is a
 * deliberate act in a way a stray touch is not.
 *
 * While the action runs the thumb stays at the end with a spinner; if it throws,
 * the thumb springs back so it can be tried again. With reduced motion asked
 * for, it moves without animating.
 */

const THUMB = 48;
const PAD = 4;
/** How far along the track counts as "all the way". */
const CONFIRM_AT = 0.9;

type Tone = 'down' | 'up' | 'accent';

const TONES: Record<Tone, { track: string; fill: string; thumb: string; text: string }> = {
  down: { track: 'bg-[var(--down-bg)] border-[var(--down)]/40', fill: 'bg-[var(--down)]/30', thumb: 'bg-[var(--down)] text-white', text: 'text-[var(--down)]' },
  up: { track: 'bg-[var(--up-bg)] border-[var(--up)]/40', fill: 'bg-[var(--up)]/30', thumb: 'bg-[var(--up)] text-black', text: 'text-[var(--up)]' },
  accent: { track: 'bg-muted border-[var(--accent)]/40', fill: 'bg-[var(--accent)]/25', thumb: 'bg-[var(--accent)] text-black', text: 'text-foreground' },
};

export function SwipeToConfirm({
  label, busyLabel = 'Sending…', disabledLabel, onConfirm, disabled, tone = 'down', className,
}: {
  /** What a completed swipe does: "Swipe to sell · ₹0.76". */
  label: string;
  busyLabel?: string;
  /** Shown instead of the label while it cannot be used: "Can't sell". */
  disabledLabel?: string;
  onConfirm: () => unknown | Promise<unknown>;
  disabled?: boolean;
  tone?: Tone;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ fromX: number; startedAt: number } | null>(null);
  const xRef = useRef(0);
  const mounted = useRef(true);
  const [x, setXState] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => () => { mounted.current = false; }, []);

  const setX = (v: number) => { xRef.current = v; setXState(v); };
  const travel = () => Math.max(0, (track.current?.getBoundingClientRect().width ?? 0) - THUMB - PAD * 2);
  const idle = !disabled && !sending;

  const fire = async () => {
    if (!idle) return;
    setSending(true);
    setX(travel());
    try { navigator.vibrate?.(12); } catch { /* not every browser has it */ }
    try {
      await onConfirm();
    } catch {
      // the caller reports its own failure; the thumb just goes back
    } finally {
      if (mounted.current) {
        setSending(false);
        setX(0);
      }
    }
  };

  const release = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    const full = travel();
    if (full > 0 && xRef.current >= full * CONFIRM_AT) void fire();
    else setX(0);
  };

  const t = TONES[tone];
  const full = travel();
  const progress = full > 0 ? Math.min(1, x / full) : 0;
  const shown = sending ? busyLabel : disabled && disabledLabel ? disabledLabel : label;

  return (
    <div
      ref={track}
      className={cn(
        'relative h-14 w-full select-none overflow-hidden rounded-full border border-solid',
        t.track,
        disabled && !sending && 'opacity-50',
        className,
      )}
    >
      {/* the part already swiped over */}
      <div
        aria-hidden
        className={cn('absolute inset-y-0 left-0 rounded-full', t.fill, !dragging && 'motion-safe:transition-[width] motion-safe:duration-300')}
        style={{ width: x + THUMB + PAD * 2 }}
      />

      <span
        aria-hidden
        className={cn('pointer-events-none absolute inset-0 flex items-center justify-center gap-1 pl-12 pr-4 text-[14px] font-semibold', t.text)}
        style={{ opacity: sending ? 1 : Math.max(0, 1 - progress * 1.4) }}
      >
        <span className="truncate">{shown}</span>
        {idle && <ChevronsRight className="h-4 w-4 flex-none motion-safe:animate-pulse" />}
      </span>

      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label}. Swipe all the way right, or press Enter, to confirm.`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-disabled={!idle || undefined}
        aria-busy={sending || undefined}
        onPointerDown={(e) => {
          if (!idle) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          drag.current = { fromX: e.clientX - xRef.current, startedAt: Date.now() };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setX(Math.min(travel(), Math.max(0, e.clientX - drag.current.fromX)));
        }}
        onPointerUp={release}
        onPointerCancel={() => { drag.current = null; setDragging(false); setX(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void fire();
          }
        }}
        className={cn(
          'absolute flex items-center justify-center rounded-full shadow-md outline-none',
          'focus-visible:ring-2 focus-visible:ring-ring',
          idle ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed',
          t.thumb,
          !dragging && 'motion-safe:transition-transform motion-safe:duration-300',
        )}
        style={{
          left: PAD, top: PAD - 1, width: THUMB, height: THUMB,
          transform: `translateX(${x}px)`,
          touchAction: 'none',
        }}
      >
        {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ChevronsRight className="h-5 w-5" />}
      </div>
    </div>
  );
}
