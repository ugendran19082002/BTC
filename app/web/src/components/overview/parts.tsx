import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The Overview's building blocks. Deliberately plain: a panel, a labelled row,
 * a tag, and the one state this screen has that the others do not -- data the
 * desk does not capture, said as such rather than drawn as a zero.
 */

export function Panel({ title, right, className, children, id }: {
  title: ReactNode; right?: ReactNode; className?: string; children: ReactNode; id?: string;
}) {
  return (
    <section className={cn('ov-panel', className)} aria-labelledby={id}>
      <header className="ov-panel-head">
        <h3 id={id}>{title}</h3>
        {right}
      </header>
      <div className="ov-panel-body">{children}</div>
    </section>
  );
}

export function Row({ label, value, tone, hint }: {
  label: ReactNode; value: ReactNode; tone?: 'up' | 'down' | 'warn' | 'muted'; hint?: string;
}) {
  return (
    <div className="ov-row" title={hint}>
      <span className="ov-row-label">{label}</span>
      <span className={cn('ov-row-value', tone && `ov-${tone}`)}>{value}</span>
    </div>
  );
}

export function Tag({ tone, children }: { tone: 'up' | 'down' | 'warn' | 'muted' | 'accent'; children: ReactNode }) {
  return <span className={cn('ov-tag', `ov-tag-${tone}`)}>{children}</span>;
}

/** Data the desk does not collect: said plainly, with what it would take. */
export function NotCaptured({ what, why }: { what: string; why: string }) {
  return (
    <div className="ov-notcaptured" role="note">
      <b>{what}: not captured</b>
      <span>{why}</span>
    </div>
  );
}

/** A 0–1 share as a bar and a percent. */
export function ProbBar({ label, value, tone }: { label: string; value: number | null; tone: 'up' | 'down' | 'muted' }) {
  const w = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="ov-prob">
      <span className="ov-prob-label">{label}</span>
      <span className="ov-prob-track" aria-hidden><span className={`ov-prob-fill ov-bg-${tone}`} style={{ width: `${w}%` }} /></span>
      <span className="ov-prob-value">{value === null ? '—' : `${Math.round(w)}%`}</span>
    </div>
  );
}

export const fmt = {
  n: (v: number | null | undefined, places = 0) =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places }),
  pct: (v: number | null | undefined, places = 0) =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(places)}%`,
  signed: (v: number | null | undefined, places = 0) =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })}`,
};
