import * as React from 'react';
import { cn } from '../../lib/utils';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger';

const TONE: Record<Tone, string> = {
  neutral: 'border-border text-muted-foreground',
  ok: 'border-[#3fb95055] bg-[#3fb95015] text-[var(--up)]',
  warn: 'border-[#d2992255] bg-[#d2992215] text-[var(--warn)]',
  danger: 'border-[#f8514955] bg-[#f8514915] text-[var(--down)]',
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
