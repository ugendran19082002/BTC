import { ChevronDown } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import { cn } from '@/lib/utils';

/**
 * Folding for a card that draws its own header -- the P&L panels, the Live
 * screen's sections -- the same way `CollapsibleCard` folds the plain ones,
 * and remembered under the same keys (`open:<id>`).
 *
 * The card keeps its look: mark its root `fold-host` with `data-folded`, its
 * header `fold-head`, and put a `FoldButton` in the header. Folded, everything
 * in the card but the header (and anything marked `fold-keep`) is hidden by
 * CSS (styles.css), so the card's insides need no rewiring. The title stays
 * visible: a folded card that hides its name is a card you cannot find again.
 */
export function useFold(id: string, defaultOpen = true) {
  return usePersisted<boolean>(`open:${id}`, defaultOpen);
}

/** The chevron that folds a card: down when open, sideways when folded. Named for a screen reader. */
export function FoldButton({ open, onToggle, label, className }: {
  open: boolean; onToggle: () => void; label: string; className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
      title={open ? 'Collapse' : 'Expand'}
      className={cn(
        'm-0 inline-flex h-7 w-7 flex-none appearance-none items-center justify-center rounded-md border-0 bg-transparent p-0',
        'text-[var(--dim)] hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    >
      <ChevronDown aria-hidden className={cn('h-4 w-4 transition-transform', open ? '' : '-rotate-90')} />
    </button>
  );
}
