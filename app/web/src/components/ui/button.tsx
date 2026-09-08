import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'outline' | 'ghost';
type Size = 'sm' | 'md';

/**
 * Tailwind's preflight is off in this project, so a bare <button> keeps the
 * platform's own border, background and font. Every variant therefore has to
 * start from zero -- `ghost` set only a colour, and what showed through was the
 * operating system's grey pill, which reads as a disabled control.
 */
const RESET = 'appearance-none border-0 bg-transparent font-[inherit] m-0';

const variants: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  outline: 'border border-solid border-border bg-muted text-foreground hover:bg-accent',
  ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
};
const sizes: Record<Size, string> = { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3 text-[13px]' };

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(({ className, variant = 'default', size = 'md', ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      RESET,
      'inline-flex items-center justify-center gap-1.5 rounded-md font-medium',
      'transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      'disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap',
      variants[variant],
      sizes[size],
      className,
    )}
    {...props}
  />
));
Button.displayName = 'Button';
