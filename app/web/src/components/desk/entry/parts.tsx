import { cn } from '@/lib/utils';
import type { EntryGate, EntryOverlay, EntryRecord, EntryTf, MethodRead } from '@/types/entry';

/**
 * The entry section's small pieces, shared by the panels, the grid and the
 * comparison: the signal chip, the method's number badge, the per-timeframe
 * tick, and how a record and a number are written.
 */

/** BUY / SELL for a TRADE, WAIT, NO -- the reference's words for the three states. */
export function signalOf(r: Pick<MethodRead, 'state' | 'dir'>): 'BUY' | 'SELL' | 'WAIT' | 'NO' {
  if (r.state === 'TRADE') return r.dir === 'short' ? 'SELL' : 'BUY';
  return r.state === 'WAIT' ? 'WAIT' : 'NO';
}

const CHIP: Record<ReturnType<typeof signalOf>, string> = {
  BUY: 'bg-[#26a17b] text-white',
  SELL: 'bg-[#e2504f] text-white',
  WAIT: 'bg-[#b7791f] text-white',
  NO: 'bg-muted text-muted-foreground',
};

export function SignalChip({ read }: { read: Pick<MethodRead, 'state' | 'dir' | 'reason'> }) {
  const s = signalOf(read);
  return (
    <span title={read.reason} className={cn('inline-block min-w-[44px] rounded px-1.5 py-px text-center text-[10.5px] font-bold', CHIP[s])}>
      {s}
    </span>
  );
}

const BADGE: Record<MethodRead['group'], string> = {
  breakout: 'bg-[#2563eb]',
  pullback: 'bg-[#7c3aed]',
  reversal: 'bg-[#db2777]',
  flow: 'bg-[#d97706]',
};

export const GROUP_NAME: Record<MethodRead['group'], string> = {
  breakout: 'Breakout', pullback: 'Pullback', reversal: 'Reversal', flow: 'Flow / derivatives',
};

export function NumberBadge({ read }: { read: Pick<MethodRead, 'n' | 'group'> }) {
  return (
    <span aria-hidden className={cn('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white', BADGE[read.group])}>
      {read.n}
    </span>
  );
}

/** ✓ all of that timeframe's checks passed, ✗ one failed, ? could not be read, · not part of this read. */
export function tickOf(read: MethodRead, tf: EntryTf): '✓' | '✗' | '?' | '·' {
  const steps = read.steps.filter((s) => s.tf === tf);
  if (!steps.length) return '·';
  if (steps.some((s) => s.ok === false)) return '✗';
  if (steps.some((s) => s.ok === null)) return '?';
  return '✓';
}

export const TICK_CLASS: Record<ReturnType<typeof tickOf>, string> = {
  '✓': 'text-[var(--up)]', '✗': 'text-[var(--down)]', '?': 'text-[var(--warn)]', '·': 'text-muted-foreground',
};

/** "12 trades · 42% · −0.08R", or how many are still working. */
export function recordText(r: EntryRecord | null): string {
  if (!r || r.setups === 0) return 'no record yet';
  if (r.trades === 0) return `${r.setups} logged, none closed`;
  const avg = r.avgR === null ? '' : ` · ${signedR(r.avgR)}`;
  return `${r.trades} trade${r.trades === 1 ? '' : 's'} · ${Math.round((100 * r.wins) / r.trades)}%${avg}`;
}

const GATE_SHORT: Record<string, string> = {
  data: 'Data', spread: 'Spread', stop: 'Stop', rr: 'R:R', htf: 'HTF', 'big-move': 'Big move', em: 'Exp. move', settle: 'Settle', method: 'Method',
};
/** A gate's verdict as a tick: ✓ passed, ✗ refused, – not read / not part of this mode. */
export const gateTick = (g: Pick<EntryGate, 'ok'>) => (g.ok === true ? '✓' : g.ok === false ? '✗' : '–');

/**
 * The hard gates in one chip: "✓ 7/7" when none refuses (of those read), or
 * the first that refuses, "✗ R:R". Hover for the whole checklist.
 */
export function GateChip({ read }: { read: Pick<MethodRead, 'gates' | 'dir'> | null }) {
  if (!read || read.dir === null || !read.gates.length) {
    return <span className="text-[11px] text-muted-foreground" title="Hard gates are read once a setup forms">–</span>;
  }
  // Only a gate that is on can refuse; one switched off is listed in the hover, marked off.
  const on = read.gates.filter((g) => g.enabled !== false);
  const failed = on.find((g) => g.ok === false);
  const readCount = on.filter((g) => g.ok !== null).length;
  const title = read.gates.map((g) => `${gateTick(g)} ${g.label}${g.enabled === false ? ' (off)' : ''}: ${g.value ?? 'not read'} (${g.rule})`).join('\n');
  return (
    <span title={title}
          className={cn('inline-block whitespace-nowrap rounded px-1.5 py-px text-[10.5px] font-semibold',
            failed ? 'bg-[rgba(226,80,79,0.15)] text-[var(--down)]' : 'bg-[rgba(38,161,123,0.15)] text-[var(--up)]')}>
      {failed ? `✗ ${GATE_SHORT[failed.key] ?? failed.label}` : `✓ ${readCount}/${readCount}`}
    </span>
  );
}

/** A TRADE's levels, for the price chart to draw; null for WAIT / NO TRADE, or with Setups off. */
export function overlayOf(r: MethodRead | null, setupsOn: boolean): EntryOverlay | null {
  const p = r?.plan;
  if (!setupsOn || !r || !p || !r.dir) return null;
  return {
    dir: r.dir, entryLo: p.entryLo, entryHi: p.entryHi, stop: p.stop, tp1: p.tp1, tp2: p.tp2, tp3: p.tp3, rr: p.rr,
    label: `#${r.n} ${r.name}${r.mode === 'mtf' ? ' (with TF)' : ` (${r.tf})`}`, triggerTime: r.triggerTime,
  };
}

export const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
export const signedR = (r: number, dp = 2) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(dp)}R`;
