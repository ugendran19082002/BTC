import { useEffect, useState } from 'react';
import { SPLIT_PRESETS, ceShareProblem, sideCaps } from '@/lib/ce-pe-split';
import { cn } from '@/lib/utils';

/**
 * "At most open" shared between calls and puts (owner, 12 Oct 2026: "split the max open between CE and PE trades --
 * 60 as 40 and 20, or 30 and 30; user friendly").
 *
 * Beside the cap it divides: a list of the usual splits, or any other as "Custom" -- the calls' per cent, the puts
 * having the rest -- and, said back in trades, what each side may hold and holds now ("CE 12 of 24 · PE 30 of 36").
 * A side at its share is said in the warning colour: the next signal that way is skipped, though the other has room.
 * The shares follow the cap -- nothing to re-save when it changes. With no cap there is nothing to share, and it says so.
 */
export function CePeSplit({ pct, cap, open, busy, onSave, onInvalid }: {
  /** The calls' share in per cent; null: no split. */
  pct: number | null;
  /** "At most open" as saved; 0 is no cap. */
  cap: number;
  open: { CE: number; PE: number };
  busy?: boolean;
  onSave: (pct: number | null) => Promise<boolean>;
  onInvalid: (message: string) => void;
}) {
  const preset = pct !== null && (SPLIT_PRESETS as readonly number[]).includes(pct);
  const [custom, setCustom] = useState(pct !== null && !preset);
  const [text, setText] = useState(pct === null ? '50' : String(pct));
  useEffect(() => { if (pct !== null) setText(String(pct)); setCustom(pct !== null && !(SPLIT_PRESETS as readonly number[]).includes(pct)); }, [pct]);
  const caps = sideCaps(cap, pct);
  const full = caps ? { CE: open.CE >= caps.CE, PE: open.PE >= caps.PE } : null;
  const commit = () => {
    const n = text.trim() === '' ? NaN : Number(text);
    const bad = ceShareProblem(n);
    if (bad) { onInvalid(bad); setText(pct === null ? '50' : String(pct)); return; }
    if (n !== pct) void onSave(n).then((ok) => { if (!ok) setText(pct === null ? '50' : String(pct)); });
  };
  const field = 'm-0 h-6 rounded border border-solid border-border bg-[var(--bg,#0a0d10)] px-1 font-[inherit] text-[12px] text-foreground disabled:opacity-50';
  return (
    <span
      role="group" aria-label="CE / PE split of at most open"
      className="desk-badge-pill inline-flex flex-wrap items-center gap-1.5"
      title="Shares the limit on open trades between calls and puts: each side is held to its own share, so one side cannot fill the whole desk. The shares follow the limit."
      style={full && (full.CE || full.PE)
        ? { background: 'rgba(250, 204, 21, 0.1)', color: '#facc15', border: '1px solid rgba(250, 204, 21, 0.3)' }
        : { background: 'rgba(255, 255, 255, 0.05)', color: '#cbd5e1', border: '1px solid #2a303a' }}
    >
      <span>CE / PE</span>
      <select
        aria-label="CE / PE split"
        value={pct === null ? '' : custom ? 'custom' : String(pct)}
        disabled={busy}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'custom') { setCustom(true); return; }
          setCustom(false);
          void onSave(v === '' ? null : Number(v));
        }}
        className={cn(field, 'max-w-[11rem]')}
      >
        <option value="">No split</option>
        {SPLIT_PRESETS.map((p) => <option key={p} value={p}>CE {p}% / PE {100 - p}%</option>)}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <label className="inline-flex items-center gap-1">
          <span>CE</span>
          <input
            aria-label="CE share, per cent" inputMode="numeric" value={text} disabled={busy}
            onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className={cn(field, 'w-10 text-center tabular-nums')}
          />
          <span>% · PE {Math.max(0, 100 - (Number(text) || 0))}%</span>
        </label>
      )}
      <span aria-label="open now, of each side's share" className="tabular-nums">
        {pct === null ? `CE ${open.CE} · PE ${open.PE} open`
          : !caps ? 'no limit set: nothing to share'
            : <>
                <span className={cn(full!.CE && 'font-semibold')}>CE {open.CE} of {caps.CE}{full!.CE ? ' full' : ''}</span>
                {' · '}
                <span className={cn(full!.PE && 'font-semibold')}>PE {open.PE} of {caps.PE}{full!.PE ? ' full' : ''}</span>
              </>}
      </span>
    </span>
  );
}
