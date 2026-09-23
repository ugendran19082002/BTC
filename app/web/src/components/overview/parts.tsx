import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { usePersisted } from '@/hooks/usePersisted';
import { cn } from '@/lib/utils';

/**
 * The Overview's building blocks. Deliberately plain: a panel, a labelled row,
 * a tag, and the one state this screen has that the others do not -- data the
 * desk does not capture, said as such rather than drawn as a zero.
 */

/**
 * "Collapse all" / "Expand all" from the bar: a stamp that changes each time
 * it is pressed, and what it asked for. Each panel follows the newest stamp
 * it has not seen, and keeps its own choice after that.
 */
export const PanelFold = createContext<{ stamp: number; collapsed: boolean }>({ stamp: 0, collapsed: false });

/**
 * A panel folds from its header: the title and its controls stay, the body
 * goes, and the choice is remembered per panel (by `name`, or the title
 * when it is a string). On a phone every panel is one screen, so folding
 * is how the screen is read.
 */
export function Panel({ title, right, className, children, id, name }: {
  title: ReactNode; right?: ReactNode; className?: string; children: ReactNode; id?: string;
  /** The key the fold is remembered under; needed when the title is not a plain string. */
  name?: string;
}) {
  const key = name ?? (typeof title === 'string' ? title : 'panel');
  const [collapsed, setCollapsed] = usePersisted<boolean>(`live:fold:${key}`, false);
  const fold = useContext(PanelFold);
  const seen = useRef(fold.stamp);
  useEffect(() => { if (fold.stamp !== seen.current) { seen.current = fold.stamp; setCollapsed(fold.collapsed); } }, [fold.stamp, fold.collapsed, setCollapsed]);
  return (
    <section className={cn('ov-panel', className, collapsed && 'ov-panel-folded')} aria-labelledby={id}>
      <header className="ov-panel-head">
        <button type="button" className="ov-fold" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${key}`} title={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '▸' : '▾'}</button>
        <h3 id={id}>{title}</h3>
        {!collapsed && right}
      </header>
      {!collapsed && <div className="ov-panel-body">{children}</div>}
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
