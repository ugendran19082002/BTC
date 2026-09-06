import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * A native select wearing the same clothes as the rest of the controls.
 *
 * Deliberately native rather than a listbox built out of divs: on a phone this
 * opens the platform picker, which is easier to use one-handed than anything
 * reimplemented, and it stays keyboard- and screen-reader-correct for free.
 */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <span className="relative inline-flex items-center">
    <select
      ref={ref}
      className={cn(
        'h-8 w-full appearance-none rounded-md border border-border bg-[var(--bg)]',
        'pl-2.5 pr-7 text-[13px] text-foreground',
        'focus:outline-none focus:ring-1 focus:ring-ring',
        'font-mono',
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 opacity-50" />
  </span>
));
Select.displayName = 'Select';
