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
  breakout: 'bg-[#475569]',
  pullback: 'bg-[#7c3aed]',
  reversal: 'bg-[#db2777]',
  flow: 'bg-[#d97706]',
};

export const GROUP_NAME: Record<MethodRead['group'], string> = {
  breakout: 'Breakout', pullback: 'Pullback', reversal: 'Reversal', flow: 'Flow / derivatives',
};

export function NumberBadge({ read }: { read: Pick<MethodRead, 'n' | 'group'> & { code?: string } }) {
  return (
    <span aria-hidden className={cn('inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10.5px] font-bold text-white', BADGE[read.group])}>
      {read.code ?? read.n}
    </span>
  );
}

/**
 * Which methods a table shows: all of them, only those with a signal, or one
 * group -- always signals first (TRADE, then WAIT), then by number. With 74
 * methods a table is long; the signals are what is looked for.
 */
export type MethodView = 'all' | 'signals' | MethodRead['group'];
export const METHOD_VIEWS: readonly MethodView[] = ['all', 'signals', 'breakout', 'pullback', 'reversal', 'flow'];
const RANK: Record<MethodRead['state'], number> = { TRADE: 0, WAIT: 1, NO_TRADE: 2 };
export function viewReads<T extends Pick<MethodRead, 'state' | 'group' | 'n'>>(xs: readonly T[], view: MethodView, signalOf: (x: T) => MethodRead['state'] = (x) => x.state): T[] {
  return xs
    .filter((x) => (view === 'all' ? true : view === 'signals' ? signalOf(x) !== 'NO_TRADE' : x.group === view))
    .map((x, i) => ({ x, i }))
    .sort((p, q) => RANK[signalOf(p.x)] - RANK[signalOf(q.x)] || p.i - q.i)
    .map((p) => p.x);
}

export function ViewChips({ value, onChange, label, counts }: { value: MethodView; onChange: (v: MethodView) => void; label: string; counts: Partial<Record<MethodView, number>> }) {
  return (
    <div role="group" aria-label={label} className="flex max-w-full gap-1 overflow-x-auto text-[11px] [scrollbar-width:none]">
      {METHOD_VIEWS.map((v) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
                className={cn('shrink-0 rounded border px-2 py-0.5', value === v ? 'border-[var(--accent)] bg-primary font-semibold text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted')}>
          {v === 'all' ? 'All' : v === 'signals' ? 'Signals' : GROUP_NAME[v]}{counts[v] !== undefined ? ` · ${counts[v]}` : ''}
        </button>
      ))}
    </div>
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
  data: 'Data', plan: 'Plan', spread: 'Spread', stop: 'Stop', rr: 'R:R', htf: 'HTF', 'big-move': 'Big move', em: 'Exp. move', settle: 'Settle', method: 'Method',
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
/**
 * Where the drawn setup stands in the paper log, on the chart's label: the
 * levels are where the order rests, so a setup not yet filled -- or one price
 * ran away from -- must not look like a position.
 */
const paperTag = (status: string | undefined, why?: string | null) =>
  status === 'expired' && why === 'target' ? ' · EXPIRED (ran to TGT1 unfilled)' :
  ({ open: ' · waiting for fill', filled: ' · filled', expired: ' · expired unfilled',
    tp1: ' · TGT1 hit', stop: ' · stopped', timeout: ' · timed out' } as Record<string, string>)[status ?? ''] ?? '';

export function overlayOf(r: MethodRead | null, setupsOn: boolean): EntryOverlay | null {
  const p = r?.plan;
  if (!setupsOn || !r || !p || !r.dir) return null;
  return {
    dir: r.dir, entryLo: p.entryLo, entryHi: p.entryHi, stop: p.stop, tp1: p.tp1, tp2: p.tp2, tp3: p.tp3, rr: p.rr,
    label: `#${r.code ?? r.n} ${r.name}${r.mode === 'mtf' ? ' (with TF)' : ` (${r.tf})`}${paperTag(r.paper?.status, r.paper?.expireWhy)}`, triggerTime: r.triggerTime,
  };
}

export const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
export const signedR = (r: number, dp = 2) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(dp)}R`;
