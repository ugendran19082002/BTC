import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedCandles } from './candle-cache.js';
import {
  add, carryStats, emptyTally, extractSignals, liveGrade, POLICIES, REACH_STEPS_ATR, simulate, TF_BARS_OF_5M,
  type CarryStats, type Policy, type Signal, type Tally, type Tf,
} from './momentum.js';

/**
 * How good is the momentum call, measured rather than claimed.
 *
 *   npx tsx src/backtest/momentum-study.ts        → research/MOMENTUM-MEASURED.txt
 *
 * The rules of the measurement were fixed before any result was seen:
 *
 *  - From April 2024. Delta India's BTCUSD was flat, near-zero-volume bars
 *    before that; a volume rule on those bars measures nothing.
 *  - Chosen on 2024 and 2025, tested on 2026. Trying many filters finds some
 *    that look good by luck; only a year nobody chose on says which were real.
 *  - After fees: 0.05% taker, both sides. On a five-minute ATR of $100-200 a
 *    round trip costs a large part of the risk, and a rule that only works
 *    before fees does not work.
 *  - In R, not just hit rate. The hit rate is printed, but a rule is judged by
 *    what it paid per unit it risked.
 */

const HORIZON: Record<Tf, number> = { '5m': 12, '15m': 8, '30m': 8, '1h': 8 };
const LIVE_WINDOW_BARS: Record<Tf, number> = { '5m': 6, '15m': 6, '30m': 4, '1h': 4 };
const TFS: Tf[] = ['5m', '15m', '30m', '1h'];
const IN_SAMPLE = new Set([2024, 2025]);
const OUT_SAMPLE = 2026;
const MIN_IN_SAMPLE = 100;

type Filter = { name: string; ok: (s: Signal) => boolean };
const BASE_FILTERS: Filter[] = [
  { name: '1h trend with', ok: (s) => s.features.h1 === 1 },
  { name: '1h trend against', ok: (s) => s.features.h1 === -1 },
  { name: '4h trend with', ok: (s) => s.features.h4 === 1 },
  { name: '4h trend against', ok: (s) => s.features.h4 === -1 },
  { name: 'compressed before (ATR < 0.8x)', ok: (s) => (s.features.compression ?? 9) < 0.8 },
  { name: 'expanded before (ATR > 1.2x)', ok: (s) => (s.features.compression ?? 0) > 1.2 },
  { name: 'volume > 2.5x', ok: (s) => (s.features.volumeRatio ?? 0) > 2.5 },
  { name: 'volume > 4x', ok: (s) => (s.features.volumeRatio ?? 0) > 4 },
  { name: 'early entry (< 0.5 ATR past level)', ok: (s) => s.features.overshootAtr < 0.5 },
  { name: 'late entry (> 1 ATR past level)', ok: (s) => s.features.overshootAtr > 1 },
  { name: 'IST 05:30-11:30', ok: (s) => inHours(s, 5.5, 11.5) },
  { name: 'IST 11:30-17:30', ok: (s) => inHours(s, 11.5, 17.5) },
  { name: 'IST 17:30-23:30 (EU/US)', ok: (s) => inHours(s, 17.5, 23.5) },
  { name: 'IST 23:30-05:30', ok: (s) => !inHours(s, 5.5, 23.5) },
];
function inHours(s: Signal, from: number, to: number) {
  const h = s.features.hourIst + 0.5;
  return h >= from && h < to;
}
// Every filter alone and every pair of compatible filters.
const FILTERS: Filter[] = [
  { name: 'all', ok: () => true },
  ...BASE_FILTERS,
  ...BASE_FILTERS.flatMap((a, i) => BASE_FILTERS.slice(i + 1)
    .filter((b) => a.name.split(' ')[0] !== b.name.split(' ')[0])
    .map((b) => ({ name: `${a.name} + ${b.name}`, ok: (s: Signal) => a.ok(s) && b.ok(s) }))),
];

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
const avg = (t: Tally, net = true) => (t.n ? (net ? t.rNet : t.r) / t.n : 0);
const fr = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;
const pad = (s: string, n: number) => s.padEnd(n);

async function main() {
  const out: string[] = [];
  const say = (s = '') => { out.push(s); console.log(s); };
  const bars5m = await cachedCandles('BTCUSD', '5m', new Date('2024-04-01T00:00:00Z'), new Date(), (m) => console.error(m));
  const first = new Date(bars5m[0]!.time * 1000).toISOString().slice(0, 10);
  const last = new Date(bars5m[bars5m.length - 1]!.time * 1000).toISOString().slice(0, 10);

  say('Momentum call, replayed: every BREAKOUT/BREAKDOWN CONFIRMED the live card would have called.');
  say(`BTCUSD 5m bars ${first} → ${last} (${bars5m.length.toLocaleString()} bars). Same marketState(), same grader.`);
  say('Entry at the signal bar\'s close. A bar touching both stop and target counts as the stop.');
  say('Net = after 0.05% taker fee each side. R = profit ÷ risk. Chosen on 2024+2025; 2026 is out of sample.');
  say();

  for (const tf of TFS) {
    const { signals, bars } = extractSignals(bars5m, tf);
    const spanSec = TF_BARS_OF_5M[tf] * 300;
    const indexOf = new Map(bars.map((b, i) => [b.time, i]));
    const afterOf = (s: Signal) => bars.slice(indexOf.get(s.time)! + 1);
    say('='.repeat(96));
    say(`== ${tf}   ${signals.length} signals   horizon ${HORIZON[tf]} bars (${(HORIZON[tf] * spanSec) / 60} min)`);

    // The journal's own question, on history.
    const grades = new Map<string, number>();
    // The live plan's target is level + 1 ATR; a close already past it makes the call a "hit" before it starts.
    const passed = signals.filter((s) => (s.side === 'UP' ? s.entry >= s.plan.target1 : s.entry <= s.plan.target1));
    let passedHit = 0;
    for (const s of passed) if (liveGrade(s, afterOf(s), LIVE_WINDOW_BARS[tf], spanSec) === 'TARGET_HIT') passedHit++;
    for (const s of signals) {
      const g = liveGrade(s, afterOf(s), LIVE_WINDOW_BARS[tf], spanSec);
      grades.set(g, (grades.get(g) ?? 0) + 1);
    }
    const hit = grades.get('TARGET_HIT') ?? 0;
    const inv = grades.get('INVALIDATED') ?? 0;
    say(`   live grader, live plan, live window (${LIVE_WINDOW_BARS[tf]} bars): target ${hit} · stop ${inv} · expired ${grades.get('EXPIRED') ?? 0}` +
      `   → target first in ${pct(hit, hit + inv)} of the ones that finished`);
    say(`   of which the target was ALREADY passed at the call: ${passed.length} calls (${pct(passed.length, signals.length)}), ${passedHit} graded "target hit".` +
      `   Without them: target first in ${pct(hit - passedHit, hit - passedHit + inv)}`);
    say();

    // Every stop/target policy, no filter.
    say(`   ${pad('policy', 26)} ${pad('n', 6)} ${pad('hit', 7)} ${pad('avg R', 9)} ${pad('net R', 9)}  net R by year   (no room = target already behind the entry, not traded)`);
    const results = new Map<Policy, { s: Signal; r: ReturnType<typeof simulate> }[]>();
    for (const p of POLICIES) {
      const rs = signals.map((s) => ({ s, r: simulate(s, afterOf(s), p, HORIZON[tf]) }));
      results.set(p, rs);
      const all = emptyTally();
      const byYear = new Map<number, Tally>();
      for (const { s, r } of rs) {
        add(all, r);
        const y = byYear.get(s.features.year) ?? byYear.set(s.features.year, emptyTally()).get(s.features.year)!;
        add(y, r);
      }
      say(`   ${pad(p.name, 26)} ${pad(String(all.n) + (all.noRoom ? `+${all.noRoom}nr` : ''), 6)} ${pad(pct(all.hits, all.n), 7)} ${pad(fr(avg(all, false)), 9)} ${pad(fr(avg(all)), 9)}  ` +
        [...byYear].sort((a, b) => a[0] - b[0]).map(([y, t]) => `${y}: ${fr(avg(t))} (${t.n}, hit ${pct(t.hits, t.n)})`).join('  '));
    }
    say();

    // Filters, chosen in sample and then tested out of sample.
    type Row = { policy: string; filter: string; ins: Tally; y: Record<number, Tally>; oos: Tally };
    const rows: Row[] = [];
    for (const [p, rs] of results) {
      for (const f of FILTERS) {
        const row: Row = { policy: p.name, filter: f.name, ins: emptyTally(), y: {}, oos: emptyTally() };
        for (const { s, r } of rs) {
          if (!f.ok(s)) continue;
          const yr = s.features.year;
          (row.y[yr] ??= emptyTally());
          add(row.y[yr]!, r);
          if (IN_SAMPLE.has(yr)) add(row.ins, r);
          else if (yr === OUT_SAMPLE) add(row.oos, r);
        }
        rows.push(row);
      }
    }
    const eligible = rows.filter((r) => r.ins.n >= MIN_IN_SAMPLE && [...IN_SAMPLE].every((y) => (r.y[y]?.n ?? 0) >= 30 && avg(r.y[y]!) > 0));
    eligible.sort((a, b) => avg(b.ins) - avg(a.ins));
    say(`   Filters positive after fees in BOTH 2024 and 2025 (≥30 each, ≥${MIN_IN_SAMPLE} together): ${eligible.length} of ${rows.length} tried.`);
    say('   Best ten by in-sample net R, and what they then did in 2026 without being re-chosen:');
    for (const r of eligible.slice(0, 10)) {
      const holds = r.oos.n >= 20 && avg(r.oos) > 0;
      say(`   ${holds ? 'HOLDS ' : 'fails '} ${pad(r.policy, 24)} ${pad(r.filter, 58)} in ${fr(avg(r.ins))} (${r.ins.n}, hit ${pct(r.ins.hits, r.ins.n)})` +
        `  2026 ${fr(avg(r.oos))} (${r.oos.n}, hit ${pct(r.oos.hits, r.oos.n)})`);
    }
    say();
  }
  // What the live risk card reads: how big the hour after a break is, not which way it goes.
  say('='.repeat(96));
  say('== The hour after a break: how far, either way (in the break timeframe\'s ATR at the break)');
  say('   A break predicts a bigger hour, not a direction. This is the table the live risk card reads.');
  const carry: CarryStats[] = [];
  for (const tf of TFS) {
    const c = carryStats(bars5m, tf);
    carry.push(c);
    const years = Object.entries(c.keptGoingByYear).map(([y, v]) => `${y} ${(v.keptGoing * 100).toFixed(1)}% of ${v.n}`).join(' · ');
    say(`   ${pad(tf, 4)} n ${pad(String(c.n), 5)} kept going after 1h ${(c.keptGoing * 100).toFixed(1)}% (${years})`);
    say(`        with the break  p50 ${c.withAtr[0]} p75 ${c.withAtr[1]} p90 ${c.withAtr[2]} p95 ${c.withAtr[3]} ATR` +
      `   against  p50 ${c.againstAtr[0]} p75 ${c.againstAtr[1]} p90 ${c.againstAtr[2]} p95 ${c.againstAtr[3]} ATR`);
    say(`        either way  p50 ${c.eitherAtr[0]} p90 ${c.eitherAtr[1]} ATR   vs any hour  p50 ${c.baselineEitherAtr[0]} p90 ${c.baselineEitherAtr[1]} ATR` +
      `   → ${((c.eitherAtr[0] / c.baselineEitherAtr[0] - 1) * 100).toFixed(0)}% bigger at the median`);
  }
  say();
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../research/MOMENTUM-MEASURED.txt'), out.join('\n') + '\n');
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '../domain/break-carry.data.ts'), [
    '// GENERATED by src/backtest/momentum-study.ts -- do not edit; rerun the study instead.',
    '// See research/MOMENTUM-MEASURED.txt for what these numbers are and how they were measured.',
    "import type { CarryStats } from './break-risk.js';",
    '',
    `export const REACH_STEPS_ATR: readonly number[] = ${JSON.stringify(REACH_STEPS_ATR)};`,
    '',
    `export const BREAK_CARRY: readonly CarryStats[] = ${JSON.stringify(carry, null, 2)};`,
    '',
  ].join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
