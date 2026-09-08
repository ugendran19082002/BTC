import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A tick box with a label that is part of the target.
 *
 * Preflight is off, so the native box keeps the platform's own look and cannot
 * be styled. It is kept for the semantics -- focus, keyboard, screen readers --
 * and hidden behind a box that is drawn, with the whole label clickable so the
 * target is a line rather than a 13px square.
 */
export const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: React.ReactNode }
>(({ className, label, checked, disabled, ...props }, ref) => (
  <label
    className={cn(
      'inline-flex cursor-pointer select-none items-center gap-2 py-1',
      disabled && 'cursor-not-allowed opacity-50',
      className,
    )}
  >
    <span className="relative flex h-[18px] w-[18px] flex-none items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        // kept in the tree for behaviour, invisible so the drawn box shows
        className="absolute inset-0 m-0 h-full w-full cursor-[inherit] opacity-0"
        {...props}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-colors',
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[#0b0e11]'
            : 'border-border bg-muted text-transparent',
        )}
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    </span>
    <span className="text-[12.5px] text-foreground">{label}</span>
  </label>
));
Checkbox.displayName = 'Checkbox';
