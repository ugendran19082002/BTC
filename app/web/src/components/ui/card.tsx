import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A card, its title, and a note: the panel shape most of the screens are built from.
 */

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-border bg-background p-3.5 sm:p-4',
        'flex flex-col gap-0',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export function CardTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-2">
      <h2 className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
        {children}
      </h2>
      {right}
    </div>
  );
}

/** Short explanatory text under a card. Kept small and grey on purpose. */
export function Note({
  children,
  tone = 'plain',
}: {
  children: React.ReactNode;
  tone?: 'plain' | 'warn' | 'dim';
}) {
  return (
    <p
      className={cn(
        'mt-2.5 mb-0 text-[11.5px] leading-[1.6]',
        tone === 'warn' ? 'text-[var(--warn)]' : tone === 'dim' ? 'text-[var(--dim)]' : 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  );
}
