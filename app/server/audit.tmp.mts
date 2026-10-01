import { readdirSync, readFileSync } from 'node:fs';
import type { Candle } from './src/market/delta.ts';
import { METHODS } from './src/entry/methods.ts';
import { MIN_BARS, readMethod, fillOf, rrOf, MAX_TP1_R, MIN_RR, TP1_FALLBACK_R, MAX_ZONE_ATR, ZONE_STOP_GAP_ATR, STOP_MIN_ATR, STOP_MAX_ATR, TP_STEP_ATR } from './src/entry/engine.ts';
import { gradeRow, type PaperRow } from './src/entry/paper.ts';
import { atr } from './src/entry/prims.ts';
import type { EntryContext, Tf } from './src/entry/types.ts';

const CACHE = '../../cache/candles/BTCUSD-5m';
const bars: Candle[] = readdirSync(CACHE).filter((f) => f >= '2026-05' && f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(readFileSync(`${CACHE}/${f}`, 'utf8')) as Candle[]).sort((a, b) => a.time - b.time)
  .filter((b, i, xs) => i === 0 || b.time !== xs[i - 1]!.time);
const fold = (src: readonly Candle[], sec: number) => {
  const out: Candle[] = []; let cur: Candle | null = null, n = 0; const per = sec / 300;
  for (const b of src) { const t = Math.floor(b.time / sec) * sec;
    if (!cur || cur.time !== t) { if (cur && n === per) out.push(cur); cur = { ...b, time: t }; n = 1; }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; n++; } }
  if (cur && n === per) out.push(cur); return out;
};
const F: Record<string, Candle[]> = { '5m': bars, '15m': fold(bars, 900), '1h': fold(bars, 3600), '4h': fold(bars, 14400) };
const closed = (xs: readonly Candle[], sec: number, now: number, n: number) => { let lo = 0, hi = xs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m]!.time + sec <= now) lo = m + 1; else hi = m; } return xs.slice(Math.max(0, lo - n), lo); };
const SEC: Record<string, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
const LIVE_OFF = ['rr', 'big-move', 'htf', 'em', 'spread', 'stop', 'mark'];
const start = bars.findIndex((b) => b.time >= Date.UTC(2026, 5, 1) / 1000);

type Bad = Record<string, number>;
const per: Record<string, { plans: number; bad: Bad; ex: string[]; rr: number[]; graded: Record<string, number> }> = {};
const note = (id: string, k: string, ex: string) => { const p = per[id]!; p.bad[k] = (p.bad[k] ?? 0) + 1; if (p.ex.length < 4) p.ex.push(`${k}: ${ex}`); };
const seen = new Set<string>();
for (const live of [true, false]) for (const tf of ['5m', '15m', '1h'] as Tf[]) {
  const step = SEC[tf]! / 300;
  for (let i = start; i < bars.length - 1; i += step) {
    const now = bars[i]!.time + 300;
    if (now % SEC[tf]! !== 0) continue;
    const frames: Record<string, Candle[]> = { '5m': closed(F['5m']!, 300, now, 600), '15m': closed(F['15m']!, 900, now, 400), '1h': closed(F['1h']!, 3600, now, 400), '4h': closed(F['4h']!, 14400, now, 400) };
    const ctx: EntryContext = { now: now * 1000, frames, flow: [], walls: [], spreadPct: null, options: null, bigMove: null, gatesOff: live ? LIVE_OFF : [] } as EntryContext;
    const tb = frames[tf]!; if (tb.length < MIN_BARS) continue;
    const a = atr(tb)!;
    for (const m of METHODS) {
      const r = readMethod(m, 'single', tf, ctx);
      per[m.id] ??= { plans: 0, bad: {}, ex: [], rr: [], graded: {} };
      if (r.state !== 'TRADE' || !r.plan || !r.dir || r.triggerTime === null) continue;
      const key = `${live}:${m.id}:${tf}:${r.dir}:${r.triggerTime}`; if (seen.has(key)) continue; seen.add(key);
      const p = r.plan, d = r.dir === 'long' ? 1 : -1, fill = fillOf(p, d), risk = Math.abs(fill - p.stop);
      const id = m.id; per[id]!.plans++; per[id]!.rr.push(p.rr);
      const ex = `${tf} ${r.dir} t=${new Date(r.triggerTime * 1000).toISOString().slice(0, 16)} zone ${p.entryLo.toFixed(0)}-${p.entryHi.toFixed(0)} sl ${p.stop.toFixed(0)} tp ${p.tp1.toFixed(0)}/${p.tp2?.toFixed(0)}/${p.tp3?.toFixed(0)} rr ${p.rr.toFixed(2)}`;
      const nums = [p.entryLo, p.entryHi, p.stop, p.tp1, p.tp2 ?? 0, p.tp3 ?? 0, p.rr];
      if (!nums.every(Number.isFinite)) note(id, 'not-finite', ex);
      if (p.entryLo > p.entryHi) note(id, 'zone-inverted', ex);
      if (d * (fill - p.stop) <= 0) note(id, 'stop-wrong-side', ex);
      if (d * (p.tp1 - fill) <= 0) note(id, 'tp1-wrong-side', ex);
      if (p.tp2 !== null && d * (p.tp2 - p.tp1) < TP_STEP_ATR * a - 1e-6) note(id, 'tp2-not-past-tp1', ex);
      if (p.tp3 !== null && d * (p.tp3 - (p.tp2 ?? p.tp1)) <= 0) note(id, 'tp3-not-past', ex);
      if (p.entryHi - p.entryLo > MAX_ZONE_ATR * a + 1e-6) note(id, 'zone-too-wide', ex);
      if (d * ((d === 1 ? p.entryLo : p.entryHi) - p.stop) < ZONE_STOP_GAP_ATR * a - 1e-6) note(id, 'zone-touches-stop', ex);
      if (Math.abs(rrOf(fill, p.stop, p.tp1) - p.rr) > 1e-9) note(id, 'rr-mismatch', ex);
      const own = m.targets.tp1 === 'own';
      if (!live && p.rr < MIN_RR - 1e-9) note(id, 'gates-on-rr<1-traded', ex);
      if (!live && (risk / a < STOP_MIN_ATR - 1e-9 || risk / a > STOP_MAX_ATR + 1e-9)) note(id, 'gates-on-stopband-traded', ex);
      if (!own && p.rr > MAX_TP1_R + 1e-9) note(id, 'tp1>2R', ex);
      if (live && p.rr < MIN_RR - 1e-9) note(id, 'live-rr<1', ex);
      if (live && (risk / a < STOP_MIN_ATR || risk / a > STOP_MAX_ATR)) note(id, 'live-stop-out-of-band', ex);
      // Grade it on the next 5m bars (the live grader uses 1m) and check the exit is the level.
      if (!live) continue;
      const j = bars.findIndex((b) => b.time === now);
      let row: PaperRow = { dir: d, tf, triggerAt: r.triggerTime, firstSeen: now * 1000, entryLo: p.entryLo, entryHi: p.entryHi, stop: p.stop, tp1: p.tp1,
        status: 'open', filledAt: null, fillPrice: null, exitAt: null, exitPrice: null, rNet: null, gradedTo: now - 300 } as PaperRow;
      row = gradeRow(row, bars.slice(j, j + 400));
      per[id]!.graded[row.status] = (per[id]!.graded[row.status] ?? 0) + 1;
      if (row.fillPrice !== null) {
        const f = row.fillPrice;
        if (d === 1 ? f > p.entryHi + 1e-6 : f < p.entryLo - 1e-6) note(id, 'fill-worse-than-zone', ex);
        if (row.status === 'tp1' && d * (row.exitPrice! - p.tp1) < -1e-6) note(id, 'tp1-exit-short-of-tp1', ex);
        if (row.status === 'stop' && d * (row.exitPrice! - p.stop) > 1e-6) note(id, 'stop-exit-better-than-stop', ex);
        if (row.rNet !== null && Math.abs(row.rNet - d * (row.exitPrice! - f) / Math.abs(f - p.stop)) > 0.011) note(id, 'r-mismatch', `${ex} r ${row.rNet} fill ${f} exit ${row.exitPrice}`);
        if (row.filledAt !== null && row.filledAt < now * 1000) note(id, 'filled-before-seen', ex);
        if (row.exitAt !== null && row.filledAt !== null && row.exitAt < row.filledAt) note(id, 'exit-before-fill', ex);
      }
    }
  }
}
let total = 0, bad = 0;
const rows = Object.entries(per).map(([id, p]) => {
  total += p.plans; const nb = Object.entries(p.bad).filter(([k]) => !k.startsWith('live-')).reduce((s, [, v]) => s + v, 0); bad += nb;
  const rr = [...p.rr].sort((x, y) => x - y);
  return { id, plans: p.plans, hard: nb, bad: p.bad, rrMed: rr.length ? +rr[rr.length >> 1]!.toFixed(2) : null, rrMin: rr.length ? +rr[0]!.toFixed(2) : null, graded: p.graded, ex: p.ex };
});
console.log(JSON.stringify({ months: '2026-06..08', total, hardProblems: bad, noPlans: rows.filter((r) => !r.plans).map((r) => r.id) }));
for (const r of rows.filter((r) => r.plans)) console.log(JSON.stringify(r));
