import type { Bar, Pool, PoolEvent, Setup, SmcState, Zone, ZoneEvent } from '@/lib/smc/types';

/**
 * What the chart draws, in *data* coordinates (bar index, price), built from
 * one engine state. Pure: no canvas, no chart -- `smc-primitive.ts` turns it
 * into pixels on every frame, so every shape stays pinned to its candles when
 * the chart is panned or zoomed.
 *
 * Clutter is decided here, not left to chance: each layer keeps only what is
 * near price and recent, and every label carries a priority so the renderer
 * drops the least important one when two would overlap.
 */

export type Layer = 'structure' | 'liquidity' | 'zones' | 'levels' | 'pd' | 'sessions' | 'vwap' | 'candles' | 'trade' | 'saved' | 'htf';

export const LAYERS: readonly { key: Layer; label: string }[] = [
  { key: 'htf', label: 'HTF: 1H zones, 15m structure' },
  { key: 'structure', label: 'Structure' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'zones', label: 'OB / FVG' },
  { key: 'levels', label: 'Levels' },
  { key: 'pd', label: 'Prem / Disc' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'vwap', label: 'VWAP' },
  { key: 'candles', label: 'Candles' },
  { key: 'trade', label: 'Trade' },
  { key: 'saved', label: 'Saved levels' },
];

export const DEFAULT_LAYERS: readonly Layer[] = ['htf', 'structure', 'liquidity', 'zones', 'levels', 'pd', 'trade', 'saved'];

/** 'right' runs to the chart's right edge: a level still in play. */
type XEnd = number | 'right';

export type SceneBox = {
  t: 'box'; layer: Layer; x1: number; x2: XEnd; y1: number; y2: number;
  fill: string; stroke?: string; dash?: boolean; label?: string; labelColor?: string; priority: number;
};
export type SceneLine = {
  t: 'line'; layer: Layer; x1: number; x2: XEnd; y: number; color: string; width?: number; dash?: 'dash' | 'dot';
  label?: string; labelAt?: 'mid' | 'end'; labelSide?: 'above' | 'below'; priority: number;
};
export type ScenePath = { t: 'path'; layer: Layer; points: [number, number][]; color: string; label?: string; priority: number };
export type SceneMark = {
  t: 'mark'; layer: Layer; x: number; y: number; text: string; color: string; side: 'above' | 'below';
  glyph?: '▲' | '▼' | '✕'; priority: number;
};
/** A vertical segment at one candle: the trade's spine. */
export type SceneVLine = { t: 'vline'; layer: Layer; x: number; y1: number; y2: number; color: string; priority: number };
export type SceneItem = SceneBox | SceneLine | ScenePath | SceneMark | SceneVLine;

export const C = {
  bull: '#26a17b', bear: '#e2504f',
  bullFill: 'rgba(38,161,123,0.16)', bearFill: 'rgba(226,80,79,0.16)',
  fvgBull: 'rgba(96,165,250,0.15)', fvgBear: 'rgba(245,158,11,0.15)', fvgBullLine: '#60a5fa', fvgBearLine: '#f59e0b',
  bsl: '#f59e0b', ssl: '#38bdf8', level: '#a78bfa', eq: '#94a3b8', ote: '#facc15',
  vwap: '#e879f9', text: '#e5e7eb', muted: '#94a3b8',
  premium: 'rgba(226,80,79,0.05)', discount: 'rgba(38,161,123,0.05)', oteFill: 'rgba(250,204,21,0.08)',
  profit: 'rgba(38,161,123,0.11)', risk: 'rgba(226,80,79,0.15)',
  session: { Asia: 'rgba(100,116,139,0.07)', London: 'rgba(59,130,246,0.07)', 'New York': 'rgba(249,115,22,0.07)' } as const,
} as const;

const fmt = (p: number) => Math.round(p).toLocaleString('en-US');
const R = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}R`;

const SWING_POOLS: readonly Pool['kind'][] = ['BSL', 'SSL', 'EQH', 'EQL'];
const LIVE_SETUP: readonly Setup['state'][] = ['READY', 'ACTIVE', 'TP1', 'TP2'];

/** `blocked`: the timeframes the live setup runs against; it is then drawn faded and labelled as no trade. */
export function buildScene(st: SmcState, bars: readonly Bar[], layers: ReadonlySet<Layer>, blocked: readonly string[] = []): SceneItem[] {
  const n = bars.length;
  if (!n) return [];
  const last = bars[n - 1]!.close;
  const out: SceneItem[] = [];
  const on = (l: Layer) => layers.has(l);
  const recent = (at: number, span: number) => at >= n - span;
  const near = (p: number) => Math.abs(p - last);

  if (on('sessions')) sessions(st, n, out);
  if (on('pd')) premiumDiscount(st, out);
  if (on('zones')) zones(st, n, last, out);
  if (on('structure')) {
    for (const s of st.swings.filter((x) => x.label && recent(x.at, 120)).slice(-40)) {
      const good = s.label === 'HH' || s.label === 'HL';
      const eq = s.label === 'EQH' || s.label === 'EQL';
      out.push({ t: 'mark', layer: 'structure', x: s.at, y: s.price, text: s.label!, color: eq ? C.bsl : good ? C.bull : C.bear, side: s.side === 'high' ? 'above' : 'below', priority: 50 });
    }
    for (const b of st.breaks.filter((x) => recent(x.at, 200)).slice(-12)) {
      out.push({
        t: 'line', layer: 'structure', x1: b.from, x2: b.at, y: b.level, color: b.dir === 'bull' ? C.bull : C.bear,
        dash: b.kind === 'CHoCH' ? 'dash' : undefined, width: 1.2,
        label: b.mss ? 'MSS' : b.kind, labelAt: 'mid', labelSide: b.dir === 'bull' ? 'above' : 'below', priority: b.kind === 'CHoCH' ? 92 : 90,
      });
    }
  }
  if (on('liquidity') || on('levels')) liquidity(st, n, last, near, layers, out);
  if (on('vwap')) vwap(st, bars, out);
  if (on('candles')) {
    const NAME: Record<string, string> = { 'Displacement': 'Disp', 'Bull engulfing': 'Eng', 'Bear engulfing': 'Eng', 'Pin bar': 'Pin', 'Inside bar': 'IB', 'Doji': 'Doji', 'Volume spike': 'Vol↑', 'Volume dry-up': 'Vol↓' };
    for (const t of st.tags.filter((x) => recent(x.at, 60))) {
      const b = bars[t.at]!;
      const up = t.dir === 'bull';
      const vol = t.name.startsWith('Volume');
      out.push({
        t: 'mark', layer: 'candles', x: t.at, y: vol || up ? b.low : b.high, text: NAME[t.name]!,
        color: t.dir === 'bull' ? C.bull : t.dir === 'bear' ? C.bear : C.muted, side: vol || up ? 'below' : 'above',
        priority: t.name === 'Displacement' ? 30 : vol ? 15 : 22,
      });
    }
  }
  if (on('trade')) trade(st, n, out, blocked);
  return out;
}

// ------------------------------------------------------------------ layers

function sessions(st: SmcState, n: number, out: SceneItem[]) {
  for (const s of st.sessions.filter((x) => x.to >= n - 300).slice(-6)) {
    out.push({ t: 'box', layer: 'sessions', x1: s.from, x2: s.to, y1: s.low, y2: s.high, fill: C.session[s.session], label: s.session === 'New York' ? 'NY' : s.session, labelColor: C.muted, priority: 35 });
  }
}

function premiumDiscount(st: SmcState, out: SceneItem[]) {
  const r = st.range;
  if (!r) return;
  const x1 = Math.max(r.highAt, r.lowAt);
  out.push({ t: 'box', layer: 'pd', x1, x2: 'right', y1: r.equilibrium, y2: r.high, fill: C.premium, label: 'Premium', labelColor: C.bear, priority: 40 });
  out.push({ t: 'box', layer: 'pd', x1, x2: 'right', y1: r.low, y2: r.equilibrium, fill: C.discount, label: 'Discount', labelColor: C.bull, priority: 40 });
  out.push({ t: 'line', layer: 'pd', x1, x2: 'right', y: r.equilibrium, color: C.eq, dash: 'dash', label: 'EQ 50%', labelAt: 'end', labelSide: 'above', priority: 42 });
  if (r.ote) out.push({ t: 'box', layer: 'pd', x1, x2: 'right', y1: r.ote.low, y2: r.ote.high, fill: C.oteFill, stroke: C.ote, dash: true, label: 'OTE', labelColor: C.ote, priority: 44 });
}

function eventsBy<E extends { at: number }>(events: readonly E[], key: (e: E) => string) {
  const m = new Map<string, E[]>();
  for (const e of events) { const k = key(e); const a = m.get(k); if (a) a.push(e); else m.set(k, [e]); }
  return m;
}

function zones(st: SmcState, n: number, last: number, out: SceneItem[]) {
  const ev = eventsBy<ZoneEvent>(st.zoneEvents, (e) => e.zone);
  const mid = (z: Zone) => (z.low + z.high) / 2;
  const byDistance = (a: Zone, b: Zone) => Math.abs(mid(a) - last) - Math.abs(mid(b) - last);
  const live: Zone[] = [];
  const breakers: { z: Zone; at: number }[] = [];
  const filled: { z: Zone; at: number }[] = [];
  for (const z of st.zones) {
    if (z.at < n - 250) continue;
    const e = ev.get(z.id) ?? [];
    const broken = e.find((x) => x.type === 'broken');
    const fill = e.find((x) => x.type === 'filled');
    if (broken) { if (broken.at >= n - 120) breakers.push({ z, at: broken.at }); continue; }
    if (z.kind === 'FVG' && fill) { if (fill.at >= n - 60) filled.push({ z, at: fill.at }); continue; }
    live.push(z);
  }
  const tested = (z: Zone) => (ev.get(z.id) ?? []).some((x) => x.type === 'touched');
  const pick = (kind: Zone['kind'], dir: Zone['dir'], k: number) => live.filter((z) => z.kind === kind && z.dir === dir).sort(byDistance).slice(0, k);

  for (const z of [...pick('OB', 'bull', 3), ...pick('OB', 'bear', 3)]) {
    const bull = z.dir === 'bull';
    out.push({
      t: 'box', layer: 'zones', x1: z.at, x2: 'right', y1: z.low, y2: z.high, fill: bull ? C.bullFill : C.bearFill, stroke: bull ? C.bull : C.bear,
      label: `${bull ? 'Bull' : 'Bear'} OB · ${tested(z) ? 'tested' : 'fresh'}`, labelColor: bull ? C.bull : C.bear, priority: 72,
    });
  }
  for (const z of [...pick('FVG', 'bull', 3), ...pick('FVG', 'bear', 3)]) {
    const bull = z.dir === 'bull';
    out.push({ t: 'box', layer: 'zones', x1: z.at, x2: 'right', y1: z.low, y2: z.high, fill: bull ? C.fvgBull : C.fvgBear, label: 'FVG', labelColor: bull ? C.fvgBullLine : C.fvgBearLine, priority: 68 });
  }
  for (const { z, at } of filled.slice(-5)) {
    out.push({ t: 'box', layer: 'zones', x1: z.at, x2: at, y1: z.low, y2: z.high, fill: z.dir === 'bull' ? 'rgba(96,165,250,0.06)' : 'rgba(245,158,11,0.06)', priority: 10 });
  }
  // A broken OB is a breaker and a broken gap an inverse FVG: the same zone, now facing the other way.
  for (const { z, at } of breakers.sort((a, b) => byDistance(a.z, b.z)).slice(0, 3)) {
    const nowBull = z.dir === 'bear';
    out.push({
      t: 'box', layer: 'zones', x1: at, x2: 'right', y1: z.low, y2: z.high, fill: nowBull ? 'rgba(38,161,123,0.08)' : 'rgba(226,80,79,0.08)',
      stroke: nowBull ? C.bull : C.bear, dash: true, label: z.kind === 'OB' ? 'Breaker' : 'IFVG', labelColor: nowBull ? C.bull : C.bear, priority: 66,
    });
  }
}

function liquidity(st: SmcState, n: number, last: number, near: (p: number) => number, layers: ReadonlySet<Layer>, out: SceneItem[]) {
  const ended = new Map<string, PoolEvent>();
  for (const e of st.poolEvents) if (!ended.has(e.pool)) ended.set(e.pool, e);
  const swing = st.pools.filter((p) => SWING_POOLS.includes(p.kind));
  const refs = st.pools.filter((p) => !SWING_POOLS.includes(p.kind));

  if (layers.has('liquidity')) {
    for (const side of ['buy', 'sell'] as const) {
      const live = swing.filter((p) => p.side === side && !ended.has(p.id) && (side === 'buy' ? p.price >= last : p.price <= last))
        .sort((a, b) => near(a.price) - near(b.price)).slice(0, 3);
      for (const p of live) {
        out.push({
          t: 'line', layer: 'liquidity', x1: p.at, x2: 'right', y: p.price, color: side === 'buy' ? C.bsl : C.ssl, dash: 'dash',
          label: `${p.kind} ${fmt(p.price)}`, labelAt: 'end', labelSide: side === 'buy' ? 'above' : 'below', priority: 80,
        });
      }
    }
    // The latest sweeps only, one a candle and side: a sweep is an event, and old ones are noise.
    const seen = new Set<string>();
    const sweeps = swing
      .map((p) => ({ p, e: ended.get(p.id) }))
      .filter((x): x is { p: Pool; e: PoolEvent } => !!x.e && x.e.type === 'swept' && x.e.at >= n - 80)
      .sort((a, b) => b.e.at - a.e.at)
      .filter(({ p, e }) => { const k = `${e.at}:${p.side}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 6);
    for (const { p, e } of sweeps) {
      const buy = p.side === 'buy';
      out.push({ t: 'line', layer: 'liquidity', x1: p.at, x2: e.at, y: p.price, color: buy ? C.bsl : C.ssl, dash: 'dot', priority: 5 });
      out.push({
        t: 'mark', layer: 'liquidity', x: e.at, y: p.price, glyph: '✕', color: buy ? C.bsl : C.ssl, side: buy ? 'above' : 'below',
        text: `${e.session === 'London' || e.session === 'New York' ? `${e.session === 'London' ? 'London' : 'NY'} ` : ''}${buy ? 'BSL' : 'SSL'} sweep`, priority: 85,
      });
    }
  }

  if (layers.has('levels')) {
    // The latest of each reference level; an older one of the same kind is history.
    const latest = new Map<string, Pool>();
    for (const p of refs) latest.set(p.kind, p);
    for (const p of latest.values()) {
      const e = ended.get(p.id);
      const buy = p.side === 'buy';
      const session = ['ASH', 'ASL', 'LSH', 'LSL'].includes(p.kind);
      const name = session ? `${p.kind.startsWith('A') ? 'Asia' : 'London'} ${buy ? 'high' : 'low'}` : p.kind;
      if (e && e.at < n - 80) continue;
      out.push({
        t: 'line', layer: 'levels', x1: p.at, x2: e ? e.at : 'right', y: p.price, color: C.level, dash: 'dot',
        label: e ? undefined : `${name} ${fmt(p.price)}`, labelAt: 'end', labelSide: buy ? 'above' : 'below', priority: session ? 55 : 65,
      });
      if (e?.type === 'swept') out.push({ t: 'mark', layer: 'levels', x: e.at, y: p.price, glyph: '✕', color: C.level, side: buy ? 'above' : 'below', text: `${name} swept`, priority: 84 });
    }
    // The UTC day's open, from its first candle.
    const open = st.dayOpen[n - 1];
    if (open != null) {
      let start = n - 1;
      while (start > 0 && st.dayOpen[start - 1] === open) start--;
      out.push({ t: 'line', layer: 'levels', x1: start, x2: 'right', y: open, color: C.eq, dash: 'dot', label: 'Day open', labelAt: 'end', labelSide: 'above', priority: 45 });
    }
  }
}

function vwap(st: SmcState, bars: readonly Bar[], out: SceneItem[]) {
  const n = bars.length;
  let pts: [number, number][] = [];
  const flush = () => { if (pts.length > 1) out.push({ t: 'path', layer: 'vwap', points: pts, color: C.vwap, priority: 48 }); pts = []; };
  for (let i = Math.max(0, n - 300); i < n; i++) {
    const v = st.vwap[i];
    if (i > 0 && st.dayOpen[i] !== st.dayOpen[i - 1]) flush();
    if (v != null) pts.push([i, v]);
  }
  if (pts.length > 1) out.push({ t: 'path', layer: 'vwap', points: pts, color: C.vwap, label: 'VWAP', priority: 48 });
}

/**
 * The trade, drawn the way a position tool draws it: one bounded box from the
 * entry candle, green from the entry to the last target and red from the entry
 * to the stop, with the entry, stop and targets as lines across that box only
 * and their prices, R and reasons at its right edge. The two halves share the
 * entry line, so risk and reward read as one thing.
 */
function trade(st: SmcState, n: number, out: SceneItem[], blocked: readonly string[]) {
  const long = (s: Setup) => s.dir === 'bull';
  // Box width: to a little past the last candle, and never narrower than 24 candles.
  const endOf = (x1: number) => Math.max(n - 1 + 14, x1 + 24);

  for (const s of st.setups) {
    if (!s.fill || s.closedAt === null || s.closedAt < n - 150) continue;
    // A finished trade is drawn as what happened: entry to exit, green or red.
    const x1 = s.fill.at;
    const x2 = Math.max(s.closedAt, x1 + 2);
    const bull = long(s);
    const exit = s.events[s.events.length - 1]!.price ?? s.fill.price;
    const r = s.resultR;
    const won = r !== null && r > 0.05;
    const flat = r !== null && Math.abs(r) <= 0.05;
    out.push({
      t: 'box', layer: 'trade', x1, x2, y1: Math.min(s.fill.price, exit), y2: Math.max(s.fill.price, exit) + (exit === s.fill.price ? 1 : 0),
      fill: won ? 'rgba(38,161,123,0.12)' : flat ? 'rgba(148,163,184,0.10)' : 'rgba(226,80,79,0.12)', stroke: won ? C.bull : flat ? C.muted : C.bear, priority: 8,
    });
    out.push({ t: 'line', layer: 'trade', x1, x2, y: s.fill.price, color: C.muted, width: 1, priority: 7 });
    const word = s.state === 'TP3' ? 'TP3' : s.state === 'STOPPED' ? 'SL' : s.state === 'PROTECTED' ? (s.events.some((e) => e.state === 'TP2') ? 'TP2 · trail' : 'TP1 · BE') : 'Exit';
    out.push({
      t: 'mark', layer: 'trade', x: s.closedAt, y: exit, color: won ? C.bull : flat ? C.muted : C.bear,
      side: bull ? 'above' : 'below', text: `${word} ${r === null ? '' : R(r)}`.trim(), priority: 75,
    });
    out.push({ t: 'mark', layer: 'trade', x: x1, y: s.fill.price, glyph: bull ? '▲' : '▼', color: bull ? C.bull : C.bear, side: bull ? 'below' : 'above', text: bull ? 'Long' : 'Short', priority: 74 });
  }

  // Setups that got as far as a structure shift and ended without a trade: a quiet note of why, on the candle it ended.
  const SHORT: [RegExp, string][] = [
    [/^TP1 .* pays ([\d.]+R)/, 'TP1 only $1'], [/ran to TP1 without a retest/, 'ran, no retest'], [/no retest/, 'no retest'],
    [/closed through the stop/, 'stop broken first'], [/confirmed too far/, 'entry too late'], [/no liquidity/, 'no target'],
    [/wider than four ATR/, 'stop too wide'], [/left no OB or FVG/, 'no OB / FVG'], [/retest never closed/, 'no close back'],
  ];
  for (const s of st.setups) {
    if (s.fill || s.closedAt === null || s.closedAt < n - 150 || !s.confirmations[1]!.ok) continue;
    const note = s.events[s.events.length - 1]!.note;
    const hit = SHORT.find(([re]) => re.test(note));
    if (!hit) continue;
    const bar = s.closedAt;
    const y = s.entry ?? s.poi?.high ?? null;
    if (y === null) continue;
    out.push({
      t: 'mark', layer: 'trade', x: bar, y, color: C.muted, side: long(s) ? 'below' : 'above',
      text: `No ${long(s) ? 'long' : 'short'}: ${hit[1].replace('$1', note.match(hit[0])?.[1] ?? '')}`, priority: 45,
    });
  }

  const live = [...st.setups].reverse().find((s) => s.closedAt === null && LIVE_SETUP.includes(s.state));
  if (!live) return;
  const ready = live.events.find((e) => e.state === 'READY')!.at;
  const bull = long(live);
  const fill = live.fill;
  const entry = fill?.price ?? live.entry!;
  const risk = fill?.risk ?? live.risk!;
  const stopNow = live.trail[live.trail.length - 1]?.price ?? live.stop!;
  const tp3 = live.targets[2]!.price;
  const x1 = fill?.at ?? ready;
  const x2 = endOf(x1);
  const side = bull ? 'LONG' : 'SHORT';
  const rOf = (p: number) => (bull ? p - entry : entry - p) / risk;
  // Against the 30M / 15M read the plan is still shown -- it is what the setup chart sees -- but faded and called what it is.
  const no = blocked.length > 0 && !fill;

  out.push({ t: 'box', layer: 'trade', x1, x2, y1: Math.min(entry, tp3), y2: Math.max(entry, tp3), fill: no ? 'rgba(38,161,123,0.05)' : C.profit, stroke: C.bull, dash: no, priority: 9 });
  out.push({ t: 'box', layer: 'trade', x1, x2, y1: Math.min(entry, live.stop!), y2: Math.max(entry, live.stop!), fill: no ? 'rgba(226,80,79,0.05)' : C.risk, stroke: C.bear, dash: no, priority: 9 });
  if (!fill && live.poi) {
    out.push({ t: 'box', layer: 'trade', x1: live.poi.at, x2, y1: live.poi.low, y2: live.poi.high, fill: 'rgba(229,231,235,0.06)', stroke: C.text, dash: true, label: `Entry zone · ${live.poi.dir === 'bull' ? 'Bull' : 'Bear'} ${live.poi.kind}`, labelColor: C.text, priority: 96 });
  }
  // The spine: one line from the stop through the entry to the last target, at the box's left edge.
  out.push({ t: 'vline', layer: 'trade', x: x1, y1: live.stop!, y2: tp3, color: C.text, priority: 9 });
  out.push({
    t: 'line', layer: 'trade', x1, x2, y: entry, color: C.text, width: 2,
    label: `${no ? `NO TRADE (against ${blocked.join(', ')}) · ` : ''}${side} ${fill ? `entry ${fmt(entry)}` : `plan ${fmt(entry)} · waiting for a close back out`}`,
    labelAt: 'end', labelSide: bull ? 'below' : 'above', priority: 100,
  });
  const moved = live.trail.length > 0;
  out.push({
    t: 'line', layer: 'trade', x1, x2, y: stopNow, color: C.bear, width: 1.6, dash: moved ? 'dash' : undefined,
    label: moved ? `SL ${fmt(stopNow)} · ${live.trail[live.trail.length - 1]!.note.startsWith('break-even') ? 'break-even' : `locks ${R(rOf(stopNow))}`}` : `SL ${fmt(stopNow)} · risk ${fmt(risk)} pts`,
    labelAt: 'end', labelSide: bull ? 'below' : 'above', priority: 99,
  });
  if (moved) out.push({ t: 'line', layer: 'trade', x1, x2, y: live.stop!, color: C.bear, width: 1, dash: 'dot', priority: 6 });
  live.targets.forEach((t, k) => {
    const hit = live.events.some((e) => e.state === `TP${k + 1}`);
    out.push({
      t: 'line', layer: 'trade', x1, x2, y: t.price, color: C.bull, width: k === 2 ? 1.6 : 1.2, dash: k === 2 ? undefined : 'dash',
      label: `TP${k + 1} ${fmt(t.price)} · ${R(rOf(t.price))} · ${t.reason}${hit ? ' ✓' : ''}`,
      labelAt: 'end', labelSide: bull ? 'above' : 'below', priority: 98 - k,
    });
  });
  if (fill) out.push({ t: 'mark', layer: 'trade', x: fill.at, y: entry, glyph: bull ? '▲' : '▼', color: bull ? C.bull : C.bear, side: bull ? 'below' : 'above', text: side, priority: 97 });
}

// ------------------------------------------------------------------ higher timeframes

/** A higher timeframe's engine state, to be drawn on the main chart's candles. */
export type HtfOverlay = {
  tf: string;
  tfSec: number;
  state: SmcState;
  bars: readonly Bar[];
  /** Which of its objects the main chart shows: 1H its order blocks, 15m its breaks. */
  show: 'zones' | 'structure';
};

/**
 * A higher timeframe's order blocks or structure breaks, placed on the main
 * chart by time and named with their timeframe ("1H Bull OB", "15m CHoCH").
 * The objects come from that timeframe's closed candles only.
 */
export function htfScene(overlays: readonly HtfOverlay[], main: readonly Bar[]): SceneItem[] {
  if (!main.length) return [];
  const indexAt = (t: number) => {
    if (t <= main[0]!.time) return 0;
    let lo = 0;
    let hi = main.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (main[mid]!.time <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const last = main[main.length - 1]!.close;
  const out: SceneItem[] = [];
  for (const o of overlays) {
    if (o.show === 'zones') {
      const broken = new Set(o.state.zoneEvents.filter((e) => e.type === 'broken').map((e) => e.zone));
      const live = o.state.zones.filter((z) => z.kind === 'OB' && !broken.has(z.id));
      const dist = (z: Zone) => Math.abs((z.low + z.high) / 2 - last);
      for (const dir of ['bull', 'bear'] as const) {
        for (const z of live.filter((x) => x.dir === dir).sort((a, b) => dist(a) - dist(b)).slice(0, 2)) {
          const bull = dir === 'bull';
          out.push({
            t: 'box', layer: 'htf', x1: indexAt(o.bars[z.at]!.time), x2: 'right', y1: z.low, y2: z.high,
            fill: bull ? 'rgba(38,161,123,0.07)' : 'rgba(226,80,79,0.07)', stroke: bull ? C.bull : C.bear, dash: true,
            label: `${o.tf} ${bull ? 'Bull' : 'Bear'} OB`, labelColor: bull ? C.bull : C.bear, priority: 76,
          });
        }
      }
    } else {
      for (const b of o.state.breaks.slice(-3)) {
        const x1 = indexAt(o.bars[b.from]!.time);
        const x2 = indexAt(o.bars[b.at]!.time + o.tfSec - 1);
        out.push({
          t: 'line', layer: 'htf', x1, x2: Math.max(x2, x1 + 1), y: b.level, color: b.dir === 'bull' ? C.bull : C.bear, width: 1.8,
          dash: b.kind === 'CHoCH' ? 'dash' : undefined, label: `${o.tf} ${b.mss ? 'MSS' : b.kind}`, labelAt: 'mid',
          labelSide: b.dir === 'bull' ? 'above' : 'below', priority: 89,
        });
      }
    }
  }
  return out;
}
