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
  children,
}: {
  /** stable key for the remembered state; changing it forgets the choice */
  id: string;
  title: React.ReactNode;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = usePersisted<boolean>(`open:${id}`, defaultOpen);

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'rounded-lg border border-border bg-background p-3.5 sm:p-4',
        'flex flex-col gap-0',
        className,
      )}
    >
      <Collapsible.Trigger
        className={cn(
          // Tailwind preflight is off, so a <button> keeps the platform's own
          // border, background and padding. Left alone the card title rendered
          // as a grey pill across the top of every card.
          'appearance-none border-0 bg-transparent p-0 font-[inherit] cursor-pointer',
          'group flex w-full items-baseline justify-between gap-2 text-left',
          open ? 'mb-2.5' : 'mb-0',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded',
        )}
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <ChevronDown
            className={cn(
              'h-3 w-3 flex-none translate-y-[1px] text-[var(--dim)] transition-transform',
              'group-hover:text-muted-foreground',
              open ? '' : '-rotate-90',
            )}
          />
          <h2 className="m-0 truncate text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
            {title}
          </h2>
        </span>
        {right}
      </Collapsible.Trigger>

      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
