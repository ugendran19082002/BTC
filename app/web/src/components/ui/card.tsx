import * as React from 'react';
import { cn } from '../../lib/utils';

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

/** A big number that leads a card. */
export function CardLead({
  children,
  tone = 'plain',
}: {
  children: React.ReactNode;
  tone?: 'plain' | 'up' | 'down' | 'warn';
}) {
  const colour =
    tone === 'up' ? 'text-[var(--up)]'
    : tone === 'down' ? 'text-[var(--down)]'
    : tone === 'warn' ? 'text-[var(--warn)]'
    : '';
  return (
    <div className={cn('font-mono text-[22px] font-semibold leading-tight', colour)}>
      {children}
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
