import type { Bar, Confirmation, Pool, Setup, SmcState, Target } from './types';

/**
 * What the chart says in words: the one live setup, or what the next one is
 * waiting for, and how this chart's own completed setups have done.
 *
 * It never names a time or a price the market "will" reach. A setup that has
 * not formed is described by the conditions still missing, and the record is
 * counted from setups the engine made without seeing their future.
 */

export type Readout = {
  tone: 'long' | 'short' | 'flat';
  headline: string;
  detail: string;
  confirmations: Confirmation[];
  plan: { entry: number; stop: number; targets: Target[]; risk: number; filled: boolean; breakEven: boolean } | null;
  nearest: { buy: Pool | null; sell: Pool | null };
  record: Record | null;
};

export type Record = {
  n: number;
  tp1Rate: number;
  stopRate: number;
  avgR: number;
  avgMfeR: number;
  avgMaeR: number;
  avgBars: number;
};

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
const SWING: readonly Pool['kind'][] = ['BSL', 'SSL', 'EQH', 'EQL'];

export function readout(st: SmcState, bars: readonly Bar[]): Readout {
  const last = bars[bars.length - 1]?.close ?? null;
  const nearest = nearestPools(st, last);
  const record = recordOf(st.setups);
  const live = [...st.setups].reverse().find((s) => s.closedAt === null) ?? null;

  if (!live) {
    const pct = (p: Pool | null) => (p && last ? ` (${(((p.price - last) / last) * 100).toFixed(2)}%)` : '');
    const between = nearest.sell || nearest.buy
      ? `Between ${nearest.sell ? `${nearest.sell.kind} ${fmt(nearest.sell.price)}${pct(nearest.sell)}` : '—'} and ${nearest.buy ? `${nearest.buy.kind} ${fmt(nearest.buy.price)}${pct(nearest.buy)}` : '—'}.`
      : 'No resting liquidity marked yet.';
    return {
      tone: 'flat',
      headline: 'NO TRADE — waiting for a sweep',
      detail: `${between} A long needs a sell-side sweep → bullish CHoCH/BOS → OB/FVG retest; a short the mirror.`,
      confirmations: [], plan: null, nearest, record,
    };
  }

  const side = live.dir === 'bull' ? 'LONG' : 'SHORT';
  const tone = live.dir === 'bull' ? 'long' : 'short';
  const missingNames = live.confirmations.filter((c) => !c.ok).map((c) => c.name);
  const plan = live.entry !== null
    ? {
      entry: live.entry, stop: live.stop!, targets: live.targets, risk: live.risk!,
      filled: live.events.some((e) => e.state === 'ACTIVE'),
      breakEven: live.state === 'TP1' || live.state === 'TP2',
    }
    : null;
  const headline = live.state === 'FORMING' ? `${side} FORMING`
    : live.state === 'READY' ? `${side} READY — limit at the POI`
      : live.state === 'ACTIVE' ? `${side} ACTIVE`
        : `${side} ACTIVE — ${live.state} reached, stop at break-even`;
  const poi = live.poi ? `${live.poi.dir === 'bull' ? 'Bull' : 'Bear'} ${live.poi.kind} ${fmt(live.poi.low)}–${fmt(live.poi.high)}` : null;
  const detail = live.state === 'FORMING'
    ? `Waiting for: ${missingNames.join(' → ')}.`
    : live.state === 'READY'
      ? `Waiting for the retest of ${poi}.${live.htf && live.htf !== live.dir ? ' Against the higher-timeframe trend.' : ''}`
      : `Filled at ${fmt(live.entry!)}${poi ? ` from ${poi}` : ''}.`;
  return { tone, headline, detail, confirmations: live.confirmations, plan, nearest, record };
}

function nearestPools(st: SmcState, last: number | null): Readout['nearest'] {
  if (last === null) return { buy: null, sell: null };
  const ended = new Set(st.poolEvents.map((e) => e.pool));
  const live = st.pools.filter((p) => SWING.includes(p.kind) && !ended.has(p.id));
  const buy = live.filter((p) => p.side === 'buy' && p.price >= last).sort((a, b) => a.price - b.price)[0] ?? null;
  const sell = live.filter((p) => p.side === 'sell' && p.price <= last).sort((a, b) => b.price - a.price)[0] ?? null;
  return { buy, sell };
}

/** Completed trades only -- a setup that never filled has no result to count. */
export function recordOf(setups: readonly Setup[]): Record | null {
  const done = setups.filter((s) => s.closedAt !== null && s.resultR !== null && s.events.some((e) => e.state === 'ACTIVE'));
  if (!done.length) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const fillAt = (s: Setup) => s.events.find((e) => e.state === 'ACTIVE')!.at;
  return {
    n: done.length,
    tp1Rate: done.filter((s) => s.events.some((e) => e.state === 'TP1' || e.state === 'TP3')).length / done.length,
    stopRate: done.filter((s) => s.state === 'STOPPED').length / done.length,
    avgR: mean(done.map((s) => s.resultR!)),
    avgMfeR: mean(done.map((s) => s.mfeR ?? 0)),
    avgMaeR: mean(done.map((s) => s.maeR ?? 0)),
    avgBars: mean(done.map((s) => s.closedAt! - fillAt(s))),
  };
}
