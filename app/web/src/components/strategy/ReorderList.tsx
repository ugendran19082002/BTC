import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { dropIndex, moved, moveTo } from '@/lib/strategy-groups';
import { cn } from '@/lib/utils';

/**
 * A list put in order by dragging (owner, 10 Oct 2026: "drag to change the order, user friendly").
 *
 * Each row has a grip: pressed and moved -- mouse, finger or pen -- the row goes where the pointer is, the others
 * making room as it passes, and stays where it is let go. Only the grip takes the drag (`touch-action: none`), so a
 * finger anywhere else on the row scrolls the page as it always did; near the top or bottom of the screen the page
 * scrolls by itself, so a long list is ordered in one drag. The up and down buttons stay, for one place at a time and
 * for the keyboard; on the grip, the arrow keys move the row too. Nothing is saved here: `onChange` gives the order.
 */
export function ReorderList({ items, order, onChange, label }: {
  items: readonly { id: string; name: string; on: boolean }[];
  /** The ids, top first. */
  order: readonly string[];
  onChange: (order: string[]) => void;
  /** What the list is, for a screen reader. */
  label: string;
}) {
  const rows = useRef(new Map<string, HTMLLIElement>());
  const [dragging, setDragging] = useState<string | null>(null);
  const pointerY = useRef(0);
  const latest = useRef(order);
  latest.current = order;

  /** Put the dragged row where the pointer is, among the others' middles. */
  const place = (id: string) => {
    const now = latest.current;
    const others = now.filter((x) => x !== id);
    const middles = others.map((x) => { const r = rows.current.get(x)?.getBoundingClientRect(); return r ? r.top + r.height / 2 : 0; });
    const to = dropIndex(middles, pointerY.current);
    const from = now.indexOf(id);
    if (from >= 0 && to !== from) onChange(moveTo(now, from, to));
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  /*
   * The drag is followed on the window, not on the grip: the row is moved in the page as it passes the others, and a
   * moved element loses the pointer it had captured -- the drag stopped after the first row (seen in a browser).
   */
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => { pointerY.current = e.clientY; placeRef.current(dragging); };
    const end = () => setDragging(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [dragging]);

  // While dragging near an edge of the screen, scroll, and keep the row under the pointer.
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const EDGE = 72;
    const tick = () => {
      const y = pointerY.current;
      const bottom = window.innerHeight - EDGE - 56; // above a phone's tab bar
      const by = y < EDGE ? -Math.ceil((EDGE - y) / 6) : y > bottom ? Math.ceil((y - bottom) / 6) : 0;
      if (by !== 0) { window.scrollBy(0, by); placeRef.current(dragging); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  return (
    <ol aria-label={label} className="m-0 grid list-none gap-1 p-0">
      {order.map((id, i) => {
        const s = items.find((x) => x.id === id);
        if (!s) return null;
        return (
          <li key={id} ref={(el) => { if (el) rows.current.set(id, el); else rows.current.delete(id); }}
              className={cn('flex items-center gap-2 rounded-md bg-muted px-1.5 py-1 transition-shadow',
                dragging === id && 'relative z-10 bg-[var(--panel)] shadow-lg ring-2 ring-[var(--accent)]')}>
            <button
              type="button"
              aria-label={`Drag ${s.name}`}
              aria-roledescription="drag handle"
              title="Drag to move it -- or the arrow keys"
              className="flex h-9 w-8 flex-none cursor-grab touch-none items-center justify-center rounded border-0 bg-transparent p-0 text-muted-foreground active:cursor-grabbing"
              onPointerDown={(e) => {
                e.preventDefault();
                pointerY.current = e.clientY;
                setDragging(id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); onChange(moved(order, i, -1)); }
                if (e.key === 'ArrowDown' && i < order.length - 1) { e.preventDefault(); onChange(moved(order, i, 1)); }
              }}
            >
              <GripVertical className="h-4 w-4" aria-hidden />
            </button>
            <span className="w-5 flex-none text-right text-[12px] tabular-nums text-[var(--dim)]">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{s.name}</span>
            <span className={cn('flex-none text-[11px]', s.on ? 'text-[var(--up)]' : 'text-[var(--dim)]')}>{s.on ? 'on' : 'off'}</span>
            <Button size="sm" variant="outline" className="h-9 w-9 flex-none p-0" aria-label={`Move ${s.name} up`} disabled={i === 0}
                    onClick={() => onChange(moved(order, i, -1))}>
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" className="h-9 w-9 flex-none p-0" aria-label={`Move ${s.name} down`} disabled={i === order.length - 1}
                    onClick={() => onChange(moved(order, i, 1))}>
              <ArrowDown className="h-4 w-4" />
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
