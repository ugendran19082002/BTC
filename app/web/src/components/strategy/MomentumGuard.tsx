import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { MOMENTUM_GUARD_DEFAULT_PTS, MOMENTUM_GUARD_MAX_PTS, MOMENTUM_GUARD_MIN_PTS, type MomentumGuard as Guard } from '@/types/strategy';

/**
 * The momentum guard (owner, 30 Oct 2026: "Momentum 1h >= +250, CE mattum, default off"): no new call is sold while the
 * perp has risen its points or more over the last hour, this account's. A pill beside the fill window -- off, or on with
 * the rise now and whether a call would be sold -- opening to the switch and the points. Puts and open trades go on.
 */

type Now = { perp: number; hourAgo: number; rise: number } | null;

/** "+555", "-87": a rise in points. */
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/** Why typed points cannot be saved; null when they can. */
const problemOf = (text: string): string | null => {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= MOMENTUM_GUARD_MIN_PTS && n <= MOMENTUM_GUARD_MAX_PTS
    ? null : `Whole points from ${MOMENTUM_GUARD_MIN_PTS} to ${MOMENTUM_GUARD_MAX_PTS}.`;
};

export function MomentumGuard({ guard, now, busy, onSave }: {
  /** The account's guard as saved. */
  guard: Guard;
  /** The perp now, an hour ago and the rise; null when either is unknown. */
  now: Now;
  busy?: boolean;
  /** The guard to keep; null, back to the default (off). */
  onSave: (guard: Guard | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(guard.on);
  const [text, setText] = useState(String(guard.pts));
  useEffect(() => { if (!open) { setOn(guard.on); setText(String(guard.pts)); } }, [open, guard.on, guard.pts]);
  const problem = problemOf(text);
  const pts = Number(text);
  const edited = on !== guard.on || pts !== guard.pts;
  const blocking = guard.on && now !== null && now.rise >= guard.pts;
  const save = async (g: Guard | null) => { if (await onSave(g)) setOpen(false); };
  const tone = !guard.on ? 'var(--text)' : blocking ? 'var(--down)' : 'var(--up)';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="desk-badge-pill inline-flex cursor-pointer items-center gap-1.5"
        title="No new call is sold while BTC has risen this many points or more in the last hour, this account's. Puts and open trades are not touched."
        style={guard.on
          ? { background: `color-mix(in srgb, ${tone} 12%, transparent)`, color: tone, border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)` }
          : { background: 'color-mix(in srgb, var(--text) 5%, transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
      >
        <span>Momentum guard</span>
        <span className={cn(!guard.on && 'text-muted-foreground')}>
          {!guard.on ? 'off' : `+${guard.pts}/1h · ${now ? `BTC ${signed(now.rise)} · CE ${blocking ? 'blocked' : 'allowed'}` : 'rise unknown'}`}
        </span>
      </PopoverTrigger>
      <PopoverContent aria-label="Momentum guard" className="w-[18rem]">
        <p className="m-0 mb-2 text-[12px] leading-snug text-muted-foreground">
          No new CE sell while BTC has risen this much in the last hour. PE sells and open trades are not touched.
        </p>
        <label className="mb-2 flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={on} disabled={busy} onChange={(e) => setOn(e.target.checked)} />
          On
        </label>
        <label className="flex items-center gap-2 text-[12px]">
          <span>Block CE when BTC rose</span>
          <input
            aria-label="Rise in the last hour, points" inputMode="numeric" value={text} disabled={busy}
            onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
            className={cn('m-0 h-7 w-16 rounded border border-solid border-border bg-[var(--bg)] px-1.5 text-right font-[inherit] text-[12px] tabular-nums text-foreground', problem && 'border-[var(--down)]')}
          />
          <span>pts in 1h</span>
        </label>
        <p aria-label="Now" className="m-0 mt-2 text-[11.5px] tabular-nums text-muted-foreground">
          {now
            ? <>BTC {Math.round(now.perp).toLocaleString('en-IN')} · an hour ago {Math.round(now.hourAgo).toLocaleString('en-IN')} · <span className={cn(now.rise >= (problem ? guard.pts : pts) && 'text-[var(--down)]')}>{signed(now.rise)} in 1h</span></>
            : 'The rise over the last hour cannot be read just now.'}
        </p>
        {problem && <p role="alert" className="m-0 mt-2 text-[11.5px] text-[var(--down)]">{problem}</p>}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" disabled={busy || problem !== null || !edited} onClick={() => void save({ on, pts })}
                  className="m-0 h-8 appearance-none rounded-md border-0 bg-primary px-3 font-[inherit] text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
            Save
          </button>
          <button type="button" disabled={busy || (!guard.on && guard.pts === MOMENTUM_GUARD_DEFAULT_PTS)} onClick={() => void save(null)}
                  className="m-0 h-8 appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[12px] text-muted-foreground disabled:opacity-50">
            Defaults
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
