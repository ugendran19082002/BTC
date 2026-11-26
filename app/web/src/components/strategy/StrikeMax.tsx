import { useEffect, useState } from 'react';
import {
  STRIKE_FIXED_PRESETS, STRIKE_MAX_DEFAULT_PCT, STRIKE_MAX_PRESETS, fixedFromPct, strikeFixedProblem, strikeMaxProblem, strikeMostOf, strikeWords,
} from '@/lib/side-max';
import { cn } from '@/lib/utils';

/**
 * The most open at once on one strike (owner's list #1, 22 Oct 2026: "50 trades on one strike"; ten were opened on
 * the P-83000 inside six seconds that morning, 07:00, and all ten stopped together at 07:11). One small control beside the
 * sides' limits: the usual figures -- 10 the default, "no limit" -- or any other as "Custom", and, said back, the
 * strike holding the most now ("PE 83000: 7 of 10"), in the warning colour at it. And what its next signal does then
 * (owner, the same day: "86000CE full -- forward it to 86200CE, if every condition is okay"): sold one strike further
 * out by the strategy's own rule, never nearer the money -- the default -- or skipped.
 *
 * By either rule (owner, 26 Nov 2026: "% and fixed rendu-um venum, responsive, check mobile responsive"): a per cent of
 * "at most open", or a fixed number of trades a strike, 1 to 48. Switching rule saves the figure that holds what the
 * other held -- 12% of 400 is 48, so "Fixed" starts at 48 and nothing on the desk moves until a new figure is picked.
 * On a narrow screen the pill becomes a box that wraps, its parts on as many rows as they need.
 */
export function StrikeMax({ pct, fixed = null, cap, busiest, full: whenFull = 'next', busy, onSave, onSaveFixed, onSaveFull, onInvalid }: {
  /** The most on one strike as saved: per cent of "at most open". */
  pct: number;
  /** Or a fixed number a strike, which then is the limit; null (or absent) the per cent is. */
  fixed?: number | null;
  /** "At most open" as saved; 0 is no limit, and then no per cent has anything to be a per cent of. */
  cap: number;
  busiest: { symbol: string; open: number } | null;
  /** At a full strike: the next strike out, or skip. */
  full?: 'next' | 'skip';
  busy?: boolean;
  /** Save a per cent -- and so the per cent as the rule. */
  onSave: (pct: number) => Promise<boolean>;
  /** Save a fixed number -- and so the fixed rule. Absent (a server from before it): only the per cent is offered. */
  onSaveFixed?: (n: number) => Promise<boolean>;
  onSaveFull?: (mode: 'next' | 'skip') => Promise<boolean>;
  onInvalid: (message: string) => void;
}) {
  const isFixed = fixed !== null && onSaveFixed !== undefined;
  const value = isFixed ? fixed! : pct;
  const presets: readonly number[] = isFixed ? STRIKE_FIXED_PRESETS : STRIKE_MAX_PRESETS;
  const isPreset = (n: number) => presets.includes(n);
  const [custom, setCustom] = useState(!isPreset(value));
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); setCustom(!isPreset(value)); }, [value, isFixed]); // eslint-disable-line react-hooks/exhaustive-deps
  const most = strikeMostOf(cap, pct, isFixed ? fixed : null);
  const isFull = most !== null && busiest !== null && busiest.open >= most;
  const save = (n: number) => (isFixed ? onSaveFixed!(n) : onSave(n));
  const commit = () => {
    const n = text.trim() === '' ? NaN : Number(text);
    const bad = isFixed ? strikeFixedProblem(n) : strikeMaxProblem(n);
    if (bad) { onInvalid(bad); setText(String(value)); return; }
    if (n !== value) void save(n).then((ok) => { if (!ok) setText(String(value)); });
    else setCustom(!isPreset(value));
  };
  // The other rule, holding what this one holds now: no jump on the desk from the switch itself.
  const switchTo = (unit: 'pct' | 'fixed') => {
    if (busy || (unit === 'fixed') === isFixed) return;
    void (unit === 'fixed' ? onSaveFixed!(fixedFromPct(cap, pct)) : onSave(pct));
  };
  const field = 'm-0 h-7 rounded border border-solid border-border bg-[var(--bg)] px-1 font-[inherit] text-[12px] text-foreground disabled:opacity-50 sm:h-6';
  const seg = (on: boolean) => cn('m-0 h-7 cursor-pointer border-0 px-2 font-[inherit] text-[11.5px] sm:h-6',
    on ? 'bg-[var(--accent)] text-[var(--bg)]' : 'bg-transparent text-foreground', busy && 'cursor-default opacity-50');
  return (
    <span
      role="group" aria-label="most on one strike"
      className="desk-badge-pill inline-flex max-w-full flex-wrap items-center gap-1.5 gap-y-1 max-[560px]:flex max-[560px]:w-full max-[560px]:rounded-xl max-[560px]:px-2.5 max-[560px]:py-1.5"
      title={isFixed
        ? 'The most trades open at once on one strike: a fixed number, this account\'s -- every strategy and the ticket together. At it, the next signal goes one strike further out by the strategy\'s own rule (never nearer the money), or is skipped -- as chosen.'
        : 'The most trades open at once on one strike, as a per cent of "at most open", this account\'s: every strategy and the ticket together. At it, the next signal goes one strike further out by the strategy\'s own rule (never nearer the money), or is skipped -- as chosen.'}
      style={isFull
        ? { background: 'color-mix(in_srgb,_var(--accent)_10%,_transparent)', color: 'var(--accent)', border: '1px solid color-mix(in_srgb,_var(--accent)_30%,_transparent)' }
        : { background: 'color-mix(in_srgb,_var(--text)_5%,_transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
    >
      <span className="whitespace-nowrap">Strike max</span>
      {onSaveFixed && (
        <span role="radiogroup" aria-label="strike max by" className="inline-flex overflow-hidden rounded border border-solid border-border">
          <button type="button" role="radio" aria-checked={!isFixed} aria-label="per cent of at most open" disabled={busy}
                  onClick={() => switchTo('pct')} className={seg(!isFixed)}>%</button>
          <button type="button" role="radio" aria-checked={isFixed} aria-label="fixed number a strike" disabled={busy}
                  onClick={() => switchTo('fixed')} className={cn(seg(isFixed), 'border-l border-solid border-border')}>Fixed</button>
        </span>
      )}
      {custom ? (
        <label className="inline-flex items-center gap-0.5">
          <input
            aria-label={isFixed ? 'most on one strike, trades' : 'most on one strike, per cent'} inputMode="numeric" value={text} disabled={busy} autoFocus={isPreset(value)}
            onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(String(value)); setCustom(!isPreset(value)); } }}
            className={cn(field, 'w-11 text-center tabular-nums')}
          />
          <span className="whitespace-nowrap">{isFixed ? 'a strike' : '%'}</span>
        </label>
      ) : (
        <select
          aria-label="most on one strike"
          value={String(value)}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value === 'custom') { setCustom(true); return; }
            void save(Number(e.target.value));
          }}
          className={cn(field, 'max-w-[9.5rem]')}
        >
          {isFixed
            ? STRIKE_FIXED_PRESETS.map((n) => <option key={n} value={n}>{n === 48 ? '48 a strike · Delta max' : `${n} a strike`}</option>)
            : STRIKE_MAX_PRESETS.map((p) => (
              <option key={p} value={p}>{p === 100 ? '100% · no limit' : `${p}%${p === STRIKE_MAX_DEFAULT_PCT ? ' · default' : ''}`}</option>
            ))}
          <option value="custom">Custom…</option>
        </select>
      )}
      {most !== null && onSaveFull && (
        <select aria-label="when a strike is full" value={whenFull} disabled={busy}
                onChange={(e) => { void onSaveFull(e.target.value as 'next' | 'skip'); }} className={cn(field, 'max-w-[11rem]')}>
          <option value="next">Full: next strike out</option>
          <option value="skip">Full: skip</option>
        </select>
      )}
      <span aria-label="busiest strike now, of the most" className={cn('tabular-nums max-[560px]:basis-full', isFull && 'font-semibold')}>
        {most === null ? `no limit${!(cap > 0) ? ' (no "at most open" set)' : ''}${busiest ? ` · ${strikeWords(busiest.symbol)}: ${busiest.open}` : ''}`
          : busiest === null ? `${most} a strike · none open`
            : `${strikeWords(busiest.symbol)}: ${busiest.open} of ${most}${isFull ? ' · full' : ''}`}
      </span>
    </span>
  );
}
