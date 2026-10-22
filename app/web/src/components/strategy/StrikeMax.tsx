import { useEffect, useState } from 'react';
import { STRIKE_MAX_DEFAULT_PCT, STRIKE_MAX_PRESETS, strikeCapOf, strikeMaxProblem, strikeWords } from '@/lib/side-max';
import { cn } from '@/lib/utils';

/**
 * The most open at once on one strike (owner's list #1, 22 Oct 2026: "50 trades on one strike"; ten were opened on
 * the P-83000 inside six seconds that morning, 07:00, and all ten stopped together at 07:11). One small control beside the
 * sides' limits: the usual figures -- 10 the default, "no limit" -- or any other as "Custom", and, said back, the
 * strike holding the most now ("PE 83000: 7 of 10"), in the warning colour at it. And what its next signal does then
 * (owner, the same day: "86000CE full -- forward it to 86200CE, if every condition is okay"): sold one strike further
 * out by the strategy's own rule, never nearer the money -- the default -- or skipped.
 */
export function StrikeMax({ pct, cap, busiest, full: whenFull = 'next', busy, onSave, onSaveFull, onInvalid }: {
  /** The most on one strike as saved: per cent of "at most open". */
  pct: number;
  /** "At most open" as saved; 0 is no limit, and then no strike has one either. */
  cap: number;
  busiest: { symbol: string; open: number } | null;
  /** At a full strike: the next strike out, or skip. */
  full?: 'next' | 'skip';
  busy?: boolean;
  onSave: (pct: number) => Promise<boolean>;
  onSaveFull?: (mode: 'next' | 'skip') => Promise<boolean>;
  onInvalid: (message: string) => void;
}) {
  const isPreset = (n: number) => (STRIKE_MAX_PRESETS as readonly number[]).includes(n);
  const [custom, setCustom] = useState(!isPreset(pct));
  const [text, setText] = useState(String(pct));
  useEffect(() => { setText(String(pct)); setCustom(!isPreset(pct)); }, [pct]);
  const most = strikeCapOf(cap, pct);
  const full = most !== null && busiest !== null && busiest.open >= most;
  const commit = () => {
    const n = text.trim() === '' ? NaN : Number(text);
    const bad = strikeMaxProblem(n);
    if (bad) { onInvalid(bad); setText(String(pct)); return; }
    if (n !== pct) void onSave(n).then((ok) => { if (!ok) setText(String(pct)); });
    else setCustom(!isPreset(pct));
  };
  const field = 'm-0 h-6 rounded border border-solid border-border bg-[var(--bg)] px-1 font-[inherit] text-[12px] text-foreground disabled:opacity-50';
  return (
    <span
      role="group" aria-label="most on one strike"
      className="desk-badge-pill inline-flex items-center gap-1.5"
      title="The most trades open at once on one strike, as a per cent of &quot;at most open&quot;, this account's: every strategy and the ticket together. At it, the next signal goes one strike further out by the strategy's own rule (never nearer the money), or is skipped -- as chosen."
      style={full
        ? { background: 'color-mix(in_srgb,_var(--accent)_10%,_transparent)', color: 'var(--accent)', border: '1px solid color-mix(in_srgb,_var(--accent)_30%,_transparent)' }
        : { background: 'color-mix(in_srgb,_var(--text)_5%,_transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
    >
      <span>Strike max</span>
      {custom ? (
        <label className="inline-flex items-center gap-0.5">
          <input
            aria-label="most on one strike, per cent" inputMode="numeric" value={text} disabled={busy} autoFocus={isPreset(pct)}
            onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(String(pct)); setCustom(!isPreset(pct)); } }}
            className={cn(field, 'w-10 text-center tabular-nums')}
          />
          <span>%</span>
        </label>
      ) : (
        <select
          aria-label="most on one strike"
          value={String(pct)}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value === 'custom') { setCustom(true); return; }
            void onSave(Number(e.target.value));
          }}
          className={cn(field, 'max-w-[9.5rem]')}
        >
          {STRIKE_MAX_PRESETS.map((p) => (
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
      <span aria-label="busiest strike now, of the most" className={cn('tabular-nums', full && 'font-semibold')}>
        {most === null ? `no limit${!(cap > 0) ? ' (no "at most open" set)' : ''}${busiest ? ` · ${strikeWords(busiest.symbol)}: ${busiest.open}` : ''}`
          : busiest === null ? `${most} a strike · none open`
            : `${strikeWords(busiest.symbol)}: ${busiest.open} of ${most}${full ? ' · full' : ''}`}
      </span>
    </span>
  );
}
