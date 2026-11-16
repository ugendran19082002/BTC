import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { CAP_SWAP_DEFAULT, CAP_SWAP_MAX_PCT, CAP_SWAP_MAX_PER_MIN, CAP_SWAP_MIN_PCT, type CapSwap as Swap } from '@/types/strategy';

/**
 * Swap at full cap (owner, 16 Nov 2026: "swap button vachu kudu ui ... user friendly"): when the account's "at most open" --
 * or a side's -- is full, the open sale that has kept the most of its premium, if that is the % set or more, is bought back
 * and the new signal sold in its place. A pill beside the re-entry one, opening to the switch, the % (with the tested
 * levels one tap away) and the most a minute. Server `CAP_SWAP_KEY`.
 */

/** The levels studied (docs/research/2026-11-16-held-swap*), one tap each. */
const QUICK = [60, 70, 75, 80] as const;

const pctProblemOf = (text: string): string | null => {
  const n = Number(text);
  return /^\d+$/.test(text.trim()) && n >= CAP_SWAP_MIN_PCT && n <= CAP_SWAP_MAX_PCT
    ? null : `A whole % from ${CAP_SWAP_MIN_PCT} to ${CAP_SWAP_MAX_PCT}.`;
};
const perMinProblemOf = (text: string): string | null => {
  const n = Number(text);
  return /^\d+$/.test(text.trim()) && n >= 1 && n <= CAP_SWAP_MAX_PER_MIN ? null : `Swaps a minute: 1 to ${CAP_SWAP_MAX_PER_MIN}.`;
};

export function CapSwap({ swap, busy, onSave }: {
  /** The account's setting as saved. */
  swap: Swap;
  busy?: boolean;
  /** The setting to keep; null, back to the default (off). */
  onSave: (swap: Swap | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(swap.on);
  const [pctText, setPctText] = useState(String(swap.pct));
  const [perMinText, setPerMinText] = useState(String(swap.perMin));
  useEffect(() => {
    if (!open) { setOn(swap.on); setPctText(String(swap.pct)); setPerMinText(String(swap.perMin)); }
  }, [open, swap.on, swap.pct, swap.perMin]);
  const problem = pctProblemOf(pctText) ?? perMinProblemOf(perMinText);
  const pct = Number(pctText);
  const perMin = Number(perMinText);
  const edited = on !== swap.on || pct !== swap.pct || perMin !== swap.perMin;
  const save = async (s: Swap | null) => { if (await onSave(s)) setOpen(false); };
  const tone = 'var(--up)';
  // The example in words: a sale at 20 with this % kept is bought back at or under this price.
  const exampleAt = problem ? null : Math.round(20 * (1 - pct / 100) * 10) / 10;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="desk-badge-pill inline-flex cursor-pointer items-center gap-1.5"
        title="When the account (or a side) is full, a trade that has already kept this much of its premium is bought back, so the new signal can be sold in its place."
        style={swap.on
          ? { background: `color-mix(in srgb, ${tone} 12%, transparent)`, color: tone, border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)` }
          : { background: 'color-mix(in srgb, var(--text) 5%, transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
      >
        <span>Swap at full cap</span>
        <span className={cn(!swap.on && 'text-muted-foreground')}>
          {swap.on ? `on · ${swap.pct}% kept · max ${swap.perMin}/min` : 'off'}
        </span>
      </PopoverTrigger>
      <PopoverContent aria-label="Swap at full cap" className="w-[19rem]">
        <p className="m-0 mb-1.5 text-[12.5px] font-semibold leading-snug">When "at most open" is full</p>
        <p className="m-0 mb-2 text-[12px] leading-snug text-muted-foreground">
          Instead of skipping a new signal, buy back the open trade that has kept the most of its premium, if it has
          kept at least this much, and sell the new signal in its place. The number of open trades stays the same.
          If a side (CE or PE) is the full one, only a trade on that side is swapped.
        </p>
        <label className="mb-2.5 flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={on} disabled={busy} onChange={(e) => setOn(e.target.checked)} />
          On
        </label>
        <div className="mb-1.5 text-[12px]">Swap a trade that has kept at least</div>
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q} type="button" disabled={busy} aria-pressed={pct === q} onClick={() => setPctText(String(q))}
              className={cn('m-0 h-7 appearance-none rounded-md border border-solid px-2.5 font-[inherit] text-[12px] tabular-nums',
                pct === q ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-transparent text-foreground')}
            >
              {q}%
            </button>
          ))}
          {/* The box and its sign kept together on one line. */}
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <input
              aria-label="Premium kept, per cent" inputMode="numeric" value={pctText} disabled={busy}
              onChange={(e) => setPctText(e.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
              className={cn('m-0 h-7 w-10 rounded border border-solid border-border bg-[var(--bg)] px-1.5 text-right font-[inherit] text-[12px] tabular-nums text-foreground', pctProblemOf(pctText) && 'border-[var(--down)]')}
            />
            <span className="text-[12px]">%</span>
          </span>
        </div>
        <p aria-label="Example" className="m-0 mb-2.5 text-[11.5px] tabular-nums text-muted-foreground">
          {exampleAt !== null ? `e.g. sold at 20 → swapped once it can be bought back at ${exampleAt} or less` : ' '}
        </p>
        <label className="flex items-center gap-2 text-[12px]">
          <span>At most</span>
          <input
            aria-label="Swaps a minute" inputMode="numeric" value={perMinText} disabled={busy}
            onChange={(e) => setPerMinText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            className={cn('m-0 h-7 w-12 rounded border border-solid border-border bg-[var(--bg)] px-1.5 text-right font-[inherit] text-[12px] tabular-nums text-foreground', perMinProblemOf(perMinText) && 'border-[var(--down)]')}
          />
          <span>swaps a minute</span>
        </label>
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          Tested 1 Oct – 16 Nov: 70% kept +₹7,461, 75% +₹5,603, 80% +₹3,843 over the period. Works only while auto-trading is on.
        </p>
        {problem && <p role="alert" className="m-0 mt-2 text-[11.5px] text-[var(--down)]">{problem}</p>}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" disabled={busy || problem !== null || !edited} onClick={() => void save({ on, pct, perMin })}
                  className="m-0 h-8 appearance-none rounded-md border-0 bg-primary px-3 font-[inherit] text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
            Save
          </button>
          <button type="button" disabled={busy || (!swap.on && swap.pct === CAP_SWAP_DEFAULT.pct && swap.perMin === CAP_SWAP_DEFAULT.perMin)} onClick={() => void save(null)}
                  className="m-0 h-8 appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[12px] text-muted-foreground disabled:opacity-50">
            Defaults (off)
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
