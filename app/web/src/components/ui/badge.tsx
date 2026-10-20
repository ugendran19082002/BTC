import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A small bordered label in one of four tones: neutral, ok, warn, danger.
 */

type Tone = 'neutral' | 'ok' | 'warn' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'border-border text-muted-foreground',
  ok: 'border-[color-mix(in_srgb,_var(--up)_33%,_transparent)] bg-[color-mix(in_srgb,_var(--up)_8%,_transparent)] text-[var(--up)]',
  warn: 'border-[color-mix(in_srgb,_var(--warn)_33%,_transparent)] bg-[color-mix(in_srgb,_var(--warn)_8%,_transparent)] text-[var(--warn)]',
  danger: 'border-[color-mix(in_srgb,_var(--down)_33%,_transparent)] bg-[color-mix(in_srgb,_var(--down)_8%,_transparent)] text-[var(--down)]',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-block rounded-full border px-2 py-[1px] text-[10px] tracking-[0.3px]',
        TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
