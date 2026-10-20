import { useEffect, useState } from 'react';
import { SIDE_MAX_DEFAULT_PCT, SIDE_MAX_PRESETS, sideCaps, sideMaxProblem, type Side } from '@/lib/side-max';
import { cn } from '@/lib/utils';

/**
 * Each side's own limit under "at most open" (owner, 12 Oct 2026: "CE max 80% and PE max 80%, each on its own; the
 * total still held to the max open; user friendly").
 *
 * Two small controls beside the limit they are a per cent of, one for calls and one for puts: a list of the usual
 * figures -- 80 the default, 100 "no limit of its own" -- or any other as "Custom", and, said back in trades, what
 * that side may hold and holds now ("CE 12 of 48"). They are independent: changing one never moves the other. A side
 * at its limit is said in the warning colour -- the next signal that way is skipped, though the desk has room. With
 * no limit set there is nothing to take a per cent of, and it says so.
 */
export function SideMax({ pct, cap, open, busy, onSave, onInvalid }: {
  /** Each side's most, per cent of the limit. */
  pct: { CE: number; PE: number };
  /** "At most open" as saved; 0 is no limit. */
  cap: number;
  open: { CE: number; PE: number };
  busy?: boolean;
  onSave: (side: Side, pct: number) => Promise<boolean>;
  onInvalid: (message: string) => void;
}) {
  const caps = sideCaps(cap, pct);
  return (
    <span role="group" aria-label="CE and PE limits, of at most open" className="inline-flex flex-wrap items-center gap-1.5">
      {(['CE', 'PE'] as const).map((side) => (
        <OneSide key={side} side={side} pct={pct[side]} most={caps ? caps[side] : null} open={open[side]} busy={busy}
                 onSave={(n) => onSave(side, n)} onInvalid={onInvalid} />
      ))}
    </span>
  );
}

function OneSide({ side, pct, most, open, busy, onSave, onInvalid }: {
  side: Side; pct: number; most: number | null; open: number; busy?: boolean;
  onSave: (pct: number) => Promise<boolean>; onInvalid: (message: string) => void;
}) {
  const isPreset = (n: number) => (SIDE_MAX_PRESETS as readonly number[]).includes(n);
  const [custom, setCustom] = useState(!isPreset(pct));
  const [text, setText] = useState(String(pct));
  useEffect(() => { setText(String(pct)); setCustom(!isPreset(pct)); }, [pct]);
  const full = most !== null && open >= most;
  const commit = () => {
    const n = text.trim() === '' ? NaN : Number(text);
    const bad = sideMaxProblem(n);
    if (bad) { onInvalid(bad); setText(String(pct)); return; }
    if (n !== pct) void onSave(n).then((ok) => { if (!ok) setText(String(pct)); });
    else setCustom(!isPreset(pct));
  };
  const field = 'm-0 h-6 rounded border border-solid border-border bg-[var(--bg)] px-1 font-[inherit] text-[12px] text-foreground disabled:opacity-50';
  return (
    <span
      role="group" aria-label={`${side} limit`}
      className="desk-badge-pill inline-flex items-center gap-1.5"
      title={`The most ${side === 'CE' ? 'call' : 'put'} trades open at once, as a per cent of "at most open". Its own limit: the other side has its own, and the two together are still held to "at most open". 100% is no limit of its own.`}
      style={full
        ? { background: 'color-mix(in_srgb,_var(--accent)_10%,_transparent)', color: 'var(--accent)', border: '1px solid color-mix(in_srgb,_var(--accent)_30%,_transparent)' }
        : { background: 'color-mix(in_srgb,_var(--text)_5%,_transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
    >
      <span>{side} max</span>
      {custom ? (
        <label className="inline-flex items-center gap-0.5">
          <input
            aria-label={`${side} max, per cent`} inputMode="numeric" value={text} disabled={busy} autoFocus={isPreset(pct)}
            onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(String(pct)); setCustom(!isPreset(pct)); } }}
            className={cn(field, 'w-10 text-center tabular-nums')}
          />
          <span>%</span>
        </label>
      ) : (
        <select
          aria-label={`${side} max`}
          value={String(pct)}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value === 'custom') { setCustom(true); return; }
            void onSave(Number(e.target.value));
          }}
          className={cn(field, 'max-w-[9.5rem]')}
        >
          {SIDE_MAX_PRESETS.map((p) => (
            <option key={p} value={p}>{p === 100 ? '100% · no limit' : `${p}%${p === SIDE_MAX_DEFAULT_PCT ? ' · default' : ''}`}</option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      )}
      <span aria-label={`${side} open now, of its limit`} className={cn('tabular-nums', full && 'font-semibold')}>
        {most === null ? `${open} open · no limit set` : `${open} of ${most}${full ? ' · full' : ''}`}
      </span>
    </span>
  );
}
