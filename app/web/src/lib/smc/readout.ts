import type { Bar, Confirmation, Pool, Setup, SmcState, Target } from './types';
import type { TfRead } from './context';

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
  /** Entry is the fill once there is one, else the planned zone edge; R is measured from it. `stopNote` says why the stop moved. */
  plan: { entry: number; stop: number; originalStop: number; stopNote: string | null; targets: (Target & { rNow: number })[]; risk: number; filled: boolean } | null;
  nearest: { buy: Pool | null; sell: Pool | null };
  record: TradeRecord | null;
  /** Why a setup the engine found is not a trade: the timeframes it runs against. */
  blocked: string[];
  /** The last plan that ended without a trade, with its checklist and the check that failed. */
  refused: Refused | null;
  /** Completed trades, newest first. */
  history: HistoryRow[];
};

export type Refused = { dir: 'bull' | 'bear'; at: number; time: number; checks: { name: string; ok: boolean }[]; reason: string };

export type HistoryRow = {
  id: string; dir: 'bull' | 'bear'; time: number;
  entry: number; stop: number; tp1: number; exit: number;
  resultR: number; mfeR: number; maeR: number; minutes: number;
  /** What happened, in order: "TP1 → BE → stopped". */
  path: string;
};

export type TradeRecord = {
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

/**
 * The timeframes whose read a setup must not run against: the 30M bias and
 * the 15M structure. A 1M or 5M signal against both of them is a counter-trend
 * scalp, and the desk does not call that a trade.
 */
const GATES = ['Bias', 'Structure'] as const;

export function readout(st: SmcState, bars: readonly Bar[], context: readonly TfRead[] = []): Readout {
  const last = bars[bars.length - 1]?.close ?? null;
  const nearest = nearestPools(st, last);
  const record = recordOf(st.setups);
  const live = liveSetup(st);
  const refused = refusedOf(st, bars);
  const history = historyOf(st, bars);

  if (!live) {
    const pct = (p: Pool | null) => (p && last ? ` (${(((p.price - last) / last) * 100).toFixed(2)}%)` : '');
    const between = nearest.sell || nearest.buy
      ? `Between ${nearest.sell ? `${nearest.sell.kind} ${fmt(nearest.sell.price)}${pct(nearest.sell)}` : '—'} and ${nearest.buy ? `${nearest.buy.kind} ${fmt(nearest.buy.price)}${pct(nearest.buy)}` : '—'}.`
      : 'No resting liquidity marked yet.';
    return {
      tone: 'flat',
      headline: 'NO TRADE — waiting for a sweep',
      detail: `${between} A long needs a sell-side sweep → bullish CHoCH/BOS → OB/FVG retest; a short the mirror.`,
      confirmations: [], plan: null, nearest, record, blocked: [], refused, history,
    };
  }

  const side = live.dir === 'bull' ? 'LONG' : 'SHORT';
  const tone = live.dir === 'bull' ? 'long' : 'short';
  const missingNames = live.confirmations.filter((c) => !c.ok).map((c) => c.name);
  const plan = live.entry !== null ? planOf(live) : null;
  const momentum = live.events.some((e) => e.state === 'ACTIVE' && e.note.includes('break'));
  const entered = momentum ? 'MOMENTUM ENTRY' : 'ENTRY CONFIRMED';
  const headline = live.state === 'FORMING' ? `${side} SETUP FORMING`
    : live.state === 'READY' ? `${side} RETEST READY`
      : live.state === 'ACTIVE' ? `${side} ${entered}`
        : `${side} ${entered} — ${live.state} reached`;
  const poi = live.poi ? `${live.poi.dir === 'bull' ? 'Bull' : 'Bear'} ${live.poi.kind} ${fmt(live.poi.low)}–${fmt(live.poi.high)}` : null;
  const detail = live.state === 'FORMING'
    ? `Waiting for: ${missingNames.join(' → ')}.`
    : live.state === 'READY'
      ? `${live.confirmations[4]!.ok ? `In ${poi}; waiting for a candle to close back out` : `Waiting for the retest of ${poi}`}.${live.htf && live.htf !== live.dir ? ' Against the 1H trend.' : ''}`
      : `Entered at ${fmt(live.fill!.price)}${poi ? ` from ${poi}` : ''}.${live.trail.length ? ` Stop: ${live.trail[live.trail.length - 1]!.note}.` : ''}`;
  const blocked = context
    .filter((c) => (GATES as readonly string[]).includes(c.role) && c.trend !== null && c.trend !== live.dir)
    .map((c) => `${c.tf} ${c.role.toLowerCase()} ${c.trend === 'bull' ? '▲' : '▼'}`);
  if (blocked.length && live.state !== 'FORMING') {
    const inTrade = plan?.filled ?? false;
    return {
      tone: inTrade ? tone : 'flat',
      headline: inTrade ? `${headline} — against ${blocked.join(', ')}` : `NO TRADE — ${side.toLowerCase()} setup against ${blocked.join(', ')}`,
      detail: inTrade ? detail : `The ${side.toLowerCase()} plan below is what the setup chart sees; the higher timeframes disagree, so it is not taken.`,
      confirmations: live.confirmations, plan, nearest, record, blocked, refused, history,
    };
  }
  return { tone, headline, detail, confirmations: live.confirmations, plan, nearest, record, blocked, refused, history };
}

/**
 * The setup the screen is about: the most advanced open one -- a trade in
 * progress, then a plan, then one still forming; the newest among equals.
 * The HUD and the chart both ask this, so they never describe different setups.
 */
export function liveSetup(st: SmcState): Setup | null {
  const STAGE: Record<string, number> = { TP2: 5, TP1: 4, ACTIVE: 3, READY: 2, FORMING: 1 };
  return st.setups.filter((s) => s.closedAt === null)
    .sort((a, b) => (STAGE[b.state] ?? 0) - (STAGE[a.state] ?? 0) || b.createdAt - a.createdAt)[0] ?? null;
}

function planOf(s: Setup): NonNullable<Readout['plan']> {
  const entry = s.fill?.price ?? s.entry!;
  const risk = s.fill?.risk ?? s.risk!;
  const rOf = (p: number) => (s.dir === 'bull' ? p - entry : entry - p) / risk;
  const last = s.trail[s.trail.length - 1];
  return {
    entry, risk, filled: s.fill !== null,
    stop: last?.price ?? s.stop!, originalStop: s.stop!, stopNote: last?.note ?? null,
    targets: s.targets.map((t) => ({ ...t, rNow: rOf(t.price) })),
  };
}

/**
 * The last setup that got as far as a structure shift and ended without a
 * trade, within the last hour of candles: its checklist, and the check that
 * failed, in the engine's own words and numbers.
 */
function refusedOf(st: SmcState, bars: readonly Bar[]): Refused | null {
  const n = bars.length;
  const s = [...st.setups].reverse().find((x) => !x.fill && x.closedAt !== null && x.closedAt >= n - 12 && x.confirmations[1]!.ok);
  if (!s) return null;
  const end = s.events[s.events.length - 1]!;
  const reason = end.note;
  // The check that failed, named for the checklist.
  const RULES: [RegExp, string][] = [
    [/retest|close back|too far from the zone/, 'Retest'],
    [/^TP1 .* pays|break entry: TP1/, 'Reward : risk'],
    [/fees/, 'Stop wide enough for the fees'],
    [/four ATR/, 'Stop within 4 ATR'],
    [/chase/, 'Not chasing'],
    [/OB or FVG/, 'OB / FVG from the move'],
    [/liquidity/, 'Liquidity to aim at'],
  ];
  const failed = RULES.find(([re]) => re.test(reason))?.[1] ?? 'Setup held';
  const checks = s.confirmations.filter((c) => c.ok).map((c) => ({ name: c.name, ok: true }));
  checks.push({ name: failed, ok: false });
  return { dir: s.dir, at: s.closedAt!, time: bars[s.closedAt!]!.time, checks, reason };
}

/** Completed trades, newest first, with the path each took. */
function historyOf(st: SmcState, bars: readonly Bar[]): HistoryRow[] {
  return st.setups.filter((s) => s.fill && s.resultR !== null).reverse().map((s) => {
    const steps: string[] = [];
    for (const e of s.events) {
      if (e.state === 'TP1' || e.state === 'TP2' || e.state === 'TP3') steps.push(e.state);
      if (e.state === 'STOPPED') steps.push('stopped');
      if (e.state === 'PROTECTED') steps.push('stopped at the protected stop');
      if (e.state === 'EXPIRED') steps.push(e.note.includes('opposite') ? 'closed by the opposite entry' : 'time exit');
    }
    for (const t of s.trail) steps.splice(steps.length - 1, 0, t.note.startsWith('break-even') ? 'BE' : 'trail');
    const exit = s.events[s.events.length - 1]!.price ?? s.fill!.price;
    return {
      id: s.id, dir: s.dir, time: bars[s.fill!.at]!.time,
      entry: s.fill!.price, stop: s.stop!, tp1: s.targets[0]!.price, exit,
      resultR: s.resultR!, mfeR: s.mfeR ?? 0, maeR: s.maeR ?? 0,
      minutes: Math.round((bars[s.closedAt!]!.time - bars[s.fill!.at]!.time) / 60),
      path: steps.join(' → '),
    };
  });
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
export function recordOf(setups: readonly Setup[]): TradeRecord | null {
  const done = setups.filter((s) => s.closedAt !== null && s.resultR !== null && s.fill !== null);
  if (!done.length) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: done.length,
    tp1Rate: done.filter((s) => s.events.some((e) => e.state === 'TP1' || e.state === 'TP3')).length / done.length,
    stopRate: done.filter((s) => s.state === 'STOPPED').length / done.length,
    avgR: mean(done.map((s) => s.resultR!)),
    avgMfeR: mean(done.map((s) => s.mfeR ?? 0)),
    avgMaeR: mean(done.map((s) => s.maeR ?? 0)),
    avgBars: mean(done.map((s) => s.closedAt! - s.fill!.at)),
  };
}
