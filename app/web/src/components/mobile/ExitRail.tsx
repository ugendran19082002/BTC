import { CheckCircle2, XCircle } from 'lucide-react';
import { railOf } from '@/lib/exit-rail';
import { pct } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The price between its target and its stop, drawn (owner's reference, 6 Oct 2026): TGT at the left, SL at the
 * right, the entry between, and a marker for the price now that slides as it moves -- the line filling green toward
 * the target or red toward the stop, the points and the share still to go under each side, and a badge when a level
 * is reached. One for the BTC perp, where a signal trade's real exits are; one for the option, when it has its own.
 *
 * The movement is the point, so it is animated -- and not for a person who has asked their phone for less motion.
 */
export function ExitRail({ title, entry, target, stop, current, fmt, nowLabel, live = false }: {
  /** What this line is of: "BTC perp", "Option". */
  title: string;
  entry: number | null;
  target: number | null;
  stop: number | null;
  current: number | null;
  /** How a price on this line is written: two places for an option, whole numbers for the perp. */
  fmt: (n: number) => string;
  /** What the price now is, in a word: "last", "ask", "bid". */
  nowLabel: string;
  /** The price is arriving as it prints: the marker pulses. */
  live?: boolean;
}) {
  const r = railOf({ entry, target, stop, current });
  if (!r) return null;
  const pts = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(n >= 10 ? 1 : 2));
  const gap = (g: { points: number; pct: number | null } | null) => (g ? `${pts(g.points)}${g.pct !== null ? ` (${pct(g.pct, g.pct < 0.1 ? 1 : 0)})` : ''}` : null);
  const fillFrom = r.entryAt !== null && r.currentAt !== null ? Math.min(r.entryAt, r.currentAt) : null;
  const fillTo = r.entryAt !== null && r.currentAt !== null ? Math.max(r.entryAt, r.currentAt) : null;
  const tone = r.hit === 'stop' || r.side === 'stop' ? 'down' : r.hit === 'target' || r.side === 'target' ? 'up' : null;
  const said = [
    `${title}: ${current !== null ? `${nowLabel} ${fmt(current)}` : 'no price'}`,
    r.hit ? `${r.hit === 'target' ? 'target' : 'stop'} reached` : null,
    !r.hit && r.toTarget && target !== null ? `${pts(r.toTarget.points)} to the target ${fmt(target)}` : null,
    !r.hit && r.toStop && stop !== null ? `${pts(r.toStop.points)} from the stop ${fmt(stop)}` : null,
  ].filter(Boolean).join(', ');

  return (
    <div role="img" aria-label={said}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">{title}</span>
        {r.hit === 'target' ? (
          <span className="inline-flex items-center gap-1 rounded bg-[var(--up-bg)] px-1.5 py-0.5 text-[11.5px] font-semibold text-[var(--up)]"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> TGT HIT</span>
        ) : r.hit === 'stop' ? (
          <span className="inline-flex items-center gap-1 rounded bg-[var(--down-bg)] px-1.5 py-0.5 text-[11.5px] font-semibold text-[var(--down)]"><XCircle className="h-3.5 w-3.5" aria-hidden="true" /> SL HIT</span>
        ) : current !== null ? (
          <span className="text-[12.5px] tabular-nums text-muted-foreground">{nowLabel} <b className={cn('text-[13.5px]', tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-foreground')}>{fmt(current)}</b></span>
        ) : null}
      </div>

      {/* The names of the points, over them. The ends hang inward so a label never leaves the card. */}
      <div className="relative h-[27px] text-[10.5px] leading-[1.25] tabular-nums" aria-hidden="true">
        {r.targetAt !== null && target !== null && <Tag at={r.targetAt} name="TGT" value={fmt(target)} tone="up" />}
        {r.entryAt !== null && entry !== null && <Tag at={r.entryAt} name="Entry" value={fmt(entry)} />}
        {r.stopAt !== null && stop !== null && <Tag at={r.stopAt} name="SL" value={fmt(stop)} tone="down" />}
      </div>

      <div className="relative h-4" aria-hidden="true">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gradient-to-r from-[color-mix(in_srgb,var(--up)_35%,transparent)] via-[var(--panel-3)] to-[color-mix(in_srgb,var(--down)_35%,transparent)]" />
        {fillFrom !== null && fillTo !== null && tone && (
          <div
            className={cn('absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-[left,width] duration-700 ease-out motion-reduce:transition-none', tone === 'up' ? 'bg-[var(--up)]' : 'bg-[var(--down)]')}
            style={{ left: `${fillFrom}%`, width: `${fillTo - fillFrom}%` }}
          />
        )}
        {r.targetAt !== null && <Dot at={r.targetAt} className="bg-[var(--up)]" />}
        {r.entryAt !== null && <Dot at={r.entryAt} className="border-2 border-[var(--buy)] bg-[var(--bg)]" />}
        {r.stopAt !== null && <Dot at={r.stopAt} className="bg-[var(--down)]" />}
        {r.currentAt !== null && (
          <span
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-700 ease-out motion-reduce:transition-none"
            style={{ left: `${r.currentAt}%` }}
          >
            {live && !r.hit && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden', tone === 'down' ? 'bg-[var(--down)]' : tone === 'up' ? 'bg-[var(--up)]' : 'bg-foreground')} />}
            <span className={cn('absolute inset-0 rounded-full border-2 border-[var(--bg)] shadow', tone === 'down' ? 'bg-[var(--down)]' : tone === 'up' ? 'bg-[var(--up)]' : 'bg-foreground')} />
          </span>
        )}
      </div>

      <div className="flex justify-between gap-2 text-[11px] tabular-nums" aria-hidden="true">
        <span className="text-[var(--up)]">{r.toTarget && !r.hit ? `${gap(r.toTarget)} to TGT` : r.hit === 'target' ? 'target reached' : ''}</span>
        <span className="text-right text-[var(--down)]">{r.toStop && !r.hit ? `${gap(r.toStop)} to SL` : r.hit === 'stop' ? 'stop reached' : ''}</span>
      </div>
    </div>
  );
}

function Tag({ at, name, value, tone }: { at: number; name: string; value: string; tone?: 'up' | 'down' }) {
  // Near an end, the label hangs from that end rather than being centred half off the card.
  const edge = at <= 14 ? 'left' : at >= 86 ? 'right' : 'centre';
  return (
    <span
      className={cn('absolute top-0 flex flex-col whitespace-nowrap transition-[left] duration-700 ease-out motion-reduce:transition-none', edge === 'centre' && '-translate-x-1/2 items-center', edge === 'right' && 'items-end')}
      style={edge === 'left' ? { left: 0 } : edge === 'right' ? { right: 0 } : { left: `${at}%` }}
    >
      <span className={cn('font-semibold', tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-muted-foreground')}>{name}</span>
      <span className="text-foreground">{value}</span>
    </span>
  );
}

function Dot({ at, className }: { at: number; className: string }) {
  return <span className={cn('absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full', className)} style={{ left: `${at}%` }} />;
}
