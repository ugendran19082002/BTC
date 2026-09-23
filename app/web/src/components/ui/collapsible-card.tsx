import * as React from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePersisted } from '@/hooks/usePersisted';

/**
 * A card whose body folds away, remembered per card.
 *
 * The desk shows a lot at once, and which parts matter depends on the person
 * and the day: someone entering a trade wants the orders and nothing else,
 * someone reading the board wants the reference cards. Rather than guess, let
 * each section fold and remember the choice -- so the page opens tomorrow the
 * way it was left, not the way it shipped.
 *
 * The title stays visible when folded. A collapsed card that hides its own name
 * is a card you cannot find again.
 */
export function CollapsibleCard({
  id,
  title,
  right,
  defaultOpen = true,
  className,
  ariaLabel,
  children,
}: {
  /** stable key for the remembered state; changing it forgets the choice */
  id: string;
  title: React.ReactNode;
  /**
   * Beside the title, and outside the fold button -- so a badge stays readable
   * when folded and a button here ("New") is its own control, not a button
   * nested inside another one, which a screen reader cannot reach.
   */
  right?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  /** names the card as a region, for a screen reader and for tests */
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = usePersisted<boolean>(`open:${id}`, defaultOpen);

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      aria-label={ariaLabel}
      className={cn(
        'rounded-lg border border-border bg-background p-3.5 sm:p-4',
        // min-w-0: a card in a grid or flex column must be able to be narrower
        // than its longest title, or a phone scrolls sideways (Settings, 22 Sep).
        'flex min-w-0 flex-col gap-0',
        className,
      )}
    >
      {/* Wraps rather than truncates: on a phone a long badge moves under the title instead of eating it. */}
      <div className={cn('flex flex-wrap items-center justify-between gap-x-2 gap-y-1', open ? 'mb-2.5' : 'mb-0')}>
        <Collapsible.Trigger
          className={cn(
            // Tailwind preflight is off, so a <button> keeps the platform's own
            // border, background and padding. Left alone the card title rendered
            // as a grey pill across the top of every card.
            'appearance-none border-0 bg-transparent p-0 font-[inherit] cursor-pointer',
            // At least 32px tall: a thumb has to be able to find it on a phone.
            'group flex min-h-8 min-w-[min(100%,15rem)] flex-1 items-center gap-1.5 text-left',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded',
          )}
        >
          <ChevronDown
            aria-hidden
            className={cn(
              'h-3.5 w-3.5 flex-none text-[var(--dim)] transition-transform',
              'group-hover:text-muted-foreground',
              open ? '' : '-rotate-90',
            )}
          />
          <h2 className="m-0 min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
            {title}
          </h2>
        </Collapsible.Trigger>
        {right && <div className="flex flex-none items-center">{right}</div>}
      </div>

      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
