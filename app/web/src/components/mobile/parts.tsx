import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Card, CardTitle } from '@/components/ui/card';
import { pnlTone, signedInr, signedUsd, inr, usd, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The phone's building blocks (6 Oct 2026): one way to show a figure, a row, a filter and a list item, so every
 * screen reads the same. Sizes are for a thumb: 44px to tap, 13px and up to read, nothing that needs a zoom.
 */

/** Rupees large, dollars small; signed and coloured when the sign is the point. Never wraps between the two. */
export function Rupees({ usd: v, signed = false, size = 'md' }: { usd: number | null | undefined; signed?: boolean; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const tone = signed ? pnlTone(v) : undefined;
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums">
      <span className={cn(
        'font-semibold',
        size === 'sm' && 'text-[13px]', size === 'md' && 'text-[15px]', size === 'lg' && 'text-[20px]', size === 'xl' && 'text-[28px] leading-tight',
        tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-foreground',
      )}>
        {signed ? signedInr(usdToInr(v)) : inr(usdToInr(v))}
      </span>
      {size !== 'sm' && <span className="text-[11px] text-muted-foreground">{signed ? signedUsd(v) : usd(v)}</span>}
    </span>
  );
}

/** A label and its value on one line; the value side wraps, the label never does. */
export function Row({ label, children, strong = false }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 min-w-0 text-right text-[14px] tabular-nums', strong && 'font-semibold')}>{children}</dd>
    </div>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <dl className="m-0 flex flex-col divide-y divide-[var(--line-soft)]">{children}</dl>;
}

/** A small tile: a label over a figure. */
export function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: 'up' | 'down' | 'warn' | 'dim' }) {
  return (
    <div className="min-w-0 rounded-md bg-muted px-2.5 py-2">
      <dt className="truncate text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className={cn(
        // 14px on the narrowest phones, so "+₹4,123" fits a third of 360px whole rather than as "+₹4,1…".
        'm-0 truncate text-[14px] font-semibold tabular-nums min-[390px]:text-[15px]',
        tone === 'up' && 'text-[var(--up)]', tone === 'down' && 'text-[var(--down)]',
        tone === 'warn' && 'text-[var(--warn)]', tone === 'dim' && 'text-muted-foreground',
      )}>
        {children}
      </dd>
    </div>
  );
}

export function Stats({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <dl className={cn('m-0 grid gap-2', cols === 3 ? 'grid-cols-3' : 'grid-cols-2')}>{children}</dl>;
}

/** A status word in a coloured pill. */
export function Pill({ tone, children }: { tone: 'up' | 'down' | 'warn' | 'dim' | 'accent' | 'buy'; children: ReactNode }) {
  return (
    <span className={cn(
      'inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold',
      tone === 'up' && 'bg-[var(--up-bg)] text-[var(--up)]',
      tone === 'down' && 'bg-[var(--down-bg)] text-[var(--down)]',
      tone === 'warn' && 'bg-[var(--warn-bg)] text-[var(--warn)]',
      tone === 'dim' && 'bg-muted text-muted-foreground',
      tone === 'accent' && 'bg-[var(--accent-soft)] text-[var(--accent)]',
      tone === 'buy' && 'bg-[color-mix(in_srgb,var(--buy)_15%,transparent)] text-[var(--buy)]',
    )}>
      {children}
    </span>
  );
}

/** SELL red, BUY blue: the side of a trade as a pill. */
export const SidePill = ({ long }: { long: boolean }) => <Pill tone={long ? 'buy' : 'down'}>{long ? 'BUY' : 'SELL'}</Pill>;

/** One choice of a few, as a single control: the chosen one filled. For ranges -- Today, 7 days, 30 days. */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { key: T; label: string; spoken?: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid rounded-lg bg-muted p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.key} type="button" role="radio" aria-checked={value === o.key} aria-label={o.spoken} onClick={() => onChange(o.key)}
          className={cn(
            'h-10 min-w-0 whitespace-nowrap rounded-md border-0 px-1 font-[inherit] text-[13.5px] font-semibold',
            value === o.key ? 'bg-[var(--up)] text-[var(--bg)]' : 'bg-transparent text-muted-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A line with the area under it shaded, green above nothing and red below: a day minute by minute, or a running
 * total day by day. An SVG of a few hundred points -- no chart library on the phone.
 */
export function AreaChart({ values, label, height = 96 }: { values: number[]; label: string; height?: number }) {
  const id = useId().replace(/:/g, '');
  if (values.length < 2) return null;
  const W = 320, H = height, PAD = 4;
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(values.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const last = values[values.length - 1]!;
  const colour = last > 0 ? 'var(--up)' : last < 0 ? 'var(--down)' : 'var(--muted)';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className="block w-full" style={{ height: H }}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity={0.35} />
          <stop offset="100%" stopColor={colour} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#g${id})`} />
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <path d={line} fill="none" stroke={colour} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** A thin bar, filled to `value` (0-1). */
export function Bar({ value, tone, label }: { value: number; tone: 'up' | 'down' | 'warn'; label: string }) {
  const v = Math.min(1, Math.max(0, value));
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} className="h-1.5 overflow-hidden rounded-full bg-[var(--panel-3)]">
      <div className="h-full rounded-full" style={{ width: `${Math.max(2, v * 100)}%`, background: `var(--${tone})` }} />
    </div>
  );
}

/** How much of the day's loss limit is left -- the number the order gate stops at. */
export function LossMeter({ limitUsd, leftUsd, usedPct }: { limitUsd: number; leftUsd: number; usedPct: number }) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex justify-between gap-2 text-[13px]">
        <span className="text-muted-foreground">Daily loss limit</span>
        <span className="whitespace-nowrap tabular-nums"><b>{inr(usdToInr(leftUsd))}</b> <span className="text-muted-foreground">left of {inr(usdToInr(limitUsd))}</span></span>
      </div>
      <Bar value={usedPct} tone={usedPct >= 0.8 ? 'down' : usedPct >= 0.5 ? 'warn' : 'up'} label="Daily loss limit used" />
      {usedPct >= 1 && <p className="m-0 mt-1.5 text-[13px] font-medium text-[var(--down)]">The limit is reached: the desk takes no new order today.</p>}
    </div>
  );
}

/** A row of filters that scrolls sideways rather than wrapping onto three lines. */
export function Chips({ label, children }: { label: string; children: ReactNode }) {
  return <div role="group" aria-label={label} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">{children}</div>;
}

export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button" aria-pressed={on} onClick={onClick}
      className={cn(
        'h-10 shrink-0 whitespace-nowrap rounded-full border px-4 text-[14px] font-medium',
        on ? 'border-[var(--up)] bg-[var(--up-bg)] text-[var(--up)]' : 'border-border bg-transparent text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** A tappable list item that opens something: the whole row is the target, with a chevron to say so. */
export function ListButton({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button" onClick={onClick} aria-label={label}
      className="flex w-full items-center gap-3 border-0 bg-transparent px-0 py-2.5 text-left font-[inherit] text-foreground active:bg-muted"
    >
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** A card with a title, the usual block of a screen. */
export function Panel({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      {title !== undefined && <CardTitle right={right}>{title}</CardTitle>}
      {children}
    </Card>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 py-2 text-[14px] text-muted-foreground">{children}</p>;
}

/** Reading, failed, or the thing itself: a screen never shows blank while it waits. */
export function Loading({ error, what }: { error: Error | null; what: string }) {
  return <Empty>{error ? `Could not read ${what}: ${error.message}` : `Reading ${what}…`}</Empty>;
}
