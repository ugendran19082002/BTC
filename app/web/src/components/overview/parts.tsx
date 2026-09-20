import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
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

export function Row({ label, value, tone, hint, mark }: {
  label: ReactNode; value: ReactNode; tone?: 'up' | 'down' | 'warn' | 'muted'; hint?: string;
  /** A leading marker, as the reference screens draw: an arrow for a reading's lean, a dot for a level's kind. */
  mark?: 'arrow' | 'dot';
}) {
  const arrow = tone === 'up' ? '↗' : tone === 'down' ? '↘' : '→';
  return (
    <div className="ov-row" title={hint}>
      <span className="ov-row-label">
        {mark === 'arrow' && <i className={cn('ov-arrow', tone && `ov-${tone}`)} aria-hidden>{arrow}</i>}
        {mark === 'dot' && <i className={cn('ov-dot', `ov-bg-${tone ?? 'muted'}`)} aria-hidden />}
        {label}
      </span>
      <span className={cn('ov-row-value', tone && `ov-${tone}`)}>{value}</span>
    </div>
  );
}

/** The rows a screen does not need at a glance, folded under one line. */
/**
 * The rest of a panel. Nothing folds: every figure is on screen at once, so
 * the eye scans rather than clicks. The label stays as a quiet heading where
 * one was given so the section still reads as a section.
 */
export function More({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="ov-more">
      {label && label !== 'More' && <div className="ov-more-label">{label}</div>}
      {children}
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

/**
 * The width of an element, kept current as it resizes. A chart drawn in
 * pixels at this width keeps its text and points the same size in a
 * half-page panel and on a phone; one drawn to a fixed viewBox and stretched
 * by CSS does not.
 */
export function useWidth<T extends HTMLElement>(fallback = 320): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { const cw = e?.contentRect.width ?? 0; if (cw > 0) setW(Math.floor(cw)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
