import * as React from 'react';
import { cn } from '@/lib/utils';
import type { Way } from '@/types/live';

/**
 * The shared vocabulary of the Live screen.
 *
 * Every arrow, every colour and every "measured over N" badge on this screen
 * is drawn by something in this file, so the screen cannot say UP in two
 * different greens or call the same confidence "high" in one card and "strong"
 * in the next.
 */

export const ARROW: Record<Way, string> = { UP: '↑', DOWN: '↓', SIDE: '↔' };
export const WORD: Record<Way, string> = { UP: 'Up', DOWN: 'Down', SIDE: 'No side' };

/**
 * Colour says *direction*, never quality.
 *
 * Green is not "good". On a desk that sells premium, up is the direction that
 * hurts a short call, and a screen that paints the profitable side green
 * teaches the eye to read the colour instead of the number.
 */
export const toneOf = (w: Way | null): 'up' | 'down' | 'dim' =>
  (w === 'UP' ? 'up' : w === 'DOWN' ? 'down' : 'dim');

export const TONE_TEXT = {
  up: 'text-[var(--up)]',
  down: 'text-[var(--down)]',
  dim: 'text-[var(--dim)]',
  warn: 'text-[var(--warn)]',
} as const;

export const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
export const pct0 = (v: number) => `${Math.round(v * 100)}%`;
export const usd0 = (v: number) => Math.round(v).toLocaleString('en-IN');
export const signedR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;

/** A card: the screen is a column of these, and nothing else. */
export function Card({ title, hint, right, children, id, className }: {
  title: React.ReactNode;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={cn('rounded-lg border border-border bg-card p-3 sm:p-4', className)}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.8px] text-muted-foreground" title={hint}>
          {title}
        </h2>
        {right ? <div className="flex-none text-[11px] text-muted-foreground">{right}</div> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * What a number is standing on.
 *
 * Every figure on this screen is either measured, modelled or observed, and
 * the three are not interchangeable. A measured badge carries its sample size,
 * because "measured" over eleven windows is not measured.
 */
export function Provenance({ kind, n, note }: {
  kind: 'measured' | 'modelled' | 'observed' | 'ungraded';
  n?: number;
  note?: string;
}) {
  const label = kind === 'measured' && n !== undefined
    ? `measured · n=${n.toLocaleString('en-IN')}`
    : kind === 'measured' ? 'measured'
      : kind === 'modelled' ? 'modelled'
        : kind === 'observed' ? 'observed now'
          : 'never graded';
  const tone = kind === 'ungraded' ? 'border-[var(--warn)] text-[var(--warn)]' : 'border-border text-muted-foreground';
  return (
    <span
      className={cn('ml-1.5 inline-block rounded border px-1 py-px align-middle text-[9.5px] uppercase tracking-wide', tone)}
      title={note}
    >
      {label}
    </span>
  );
}

/** A row of label and value, monospaced on the right so columns line up. */
export function Row({ label, value, tone = 'dim', hint }: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: keyof typeof TONE_TEXT | 'plain';
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={hint}>
      <span className="min-w-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className={cn('flex-none font-mono text-[12.5px]', tone === 'plain' ? '' : TONE_TEXT[tone])}>{value}</span>
    </div>
  );
}

/**
 * Something the reader must see before acting.
 *
 * Warnings are never collapsed and never truncated. The one on this screen
 * that matters most -- that a signal's measured net R is negative -- is
 * precisely the one a tidier design would have hidden behind a chevron.
 */
export function Warnings({ items }: { items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-2 space-y-1" aria-label="Warnings">
      {items.map((w) => (
        <li key={w} className="flex gap-1.5 text-[12px] leading-snug text-[var(--warn)]">
          <span aria-hidden className="flex-none">!</span>
          <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}

/** Nothing to show, said in a sentence rather than an empty box. */
export function Nothing({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-[12.5px] text-muted-foreground">{children}</p>;
}
