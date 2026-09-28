import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedCandles } from './candle-cache.js';
import { add, carryStats, emptyTally, extractSignals, liveGrade, POLICIES, simulate, TF_BARS_OF_5M, type Policy, type Signal, type Tally, type Tf } from './momentum.js';
import { LEVEL_MODE_LABEL, type LevelMode } from '../domain/level-mode.js';

/** Every level definition, graded side by side. Neither may be the only one measured. */
const LEVEL_MODES: readonly LevelMode[] = ['rolling', 'swing'];

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
/**
 * Every reading `docs/New.md` asks for, as a filter on the call.
 *
 * Direction-aware where the reading has a direction: a breakout with RSI-like
 * momentum *with* it is a different proposition from one against it, and
 * testing "CCI > 100" without regard to side would mix the two into a number
 * that describes neither. `dir` is +1 for a breakout and −1 for a breakdown, so
 * `with` means the reading agrees with the call.
 *
 * A null reading **excludes** the signal rather than counting as neutral. A
 * filter whose sample is padded with calls it could not actually read is a
 * filter measuring something else.
 */
const READING_FILTERS: Filter[] = (() => {
  const out: Filter[] = [];
  const dirOf = (s: Signal) => (s.side === 'UP' ? 1 : -1);

  /** A reading that is directional: tested as "with the call" and "against it". */
  const signed = (name: string, get: (s: Signal) => number | null, dead = 0) => {
    out.push({
      name: `${name} with`,
      ok: (s) => { const v = get(s); return v !== null && Math.abs(v) > dead && Math.sign(v) === dirOf(s); },
    });
    out.push({
      name: `${name} against`,
      ok: (s) => { const v = get(s); return v !== null && Math.abs(v) > dead && Math.sign(v) !== dirOf(s); },
    });
  };

  /** A reading with a natural band: tested above and below a stated level. */
  const banded = (name: string, get: (s: Signal) => number | null, lo: number, hi: number) => {
    out.push({ name: `${name} > ${hi}`, ok: (s) => { const v = get(s); return v !== null && v > hi; } });
    out.push({ name: `${name} < ${lo}`, ok: (s) => { const v = get(s); return v !== null && v < lo; } });
  };

  const i = (s: Signal) => s.features.ind;

  signed('MACD histogram', (s) => i(s).macdHist);
  signed('OBV slope', (s) => i(s).obvSlope);
  signed('TRIX', (s) => i(s).trix);
  signed('Awesome osc', (s) => i(s).awesome);
  signed('CMF', (s) => i(s).cmf, 0.05);
  signed('ROC(10)', (s) => i(s).roc10);
  signed('SuperTrend', (s) => i(s).superTrend);
  signed('EMA 21/50 stack', (s) => i(s).emaStack);
  signed('Candle pattern', (s) => i(s).candleBias);
  signed('Structure pattern', (s) => i(s).structureBias);
  signed('CCI', (s) => i(s).cci, 100);

  banded('Stochastic', (s) => i(s).stoch, 20, 80);
  banded('MFI', (s) => i(s).mfi, 20, 80);
  banded('Williams %R', (s) => i(s).williamsR, -80, -20);
  banded('Bollinger %B', (s) => i(s).percentB, 0.2, 0.8);
  banded('Choppiness', (s) => i(s).choppiness, 38, 62);
  banded('Efficiency ratio', (s) => i(s).efficiency, 0.2, 0.4);
  banded('Vortex', (s) => i(s).vortex, 0.95, 1.05);
  banded('Relative volume', (s) => i(s).relVolume, 0.8, 1.5);
  banded('Band width', (s) => i(s).bandWidth, 0.15, 0.5);

  // The readings New.md leans on hardest, added 27 Sep 2026.
  signed('Aroon', (s) => i(s).aroon, 30);
  signed('HMA slope', (s) => i(s).hmaSlope);
  signed('Market structure', (s) => i(s).structureWay);
  signed('VWAP side', (s) => i(s).vwapDistPct, 0.1);
  signed('Z-score(50)', (s) => i(s).zScore, 1);

  banded('RSI(14)', (s) => i(s).rsi14, 35, 65);
  banded('ADX(14)', (s) => i(s).adx14, 20, 30);
  banded('Donchian position', (s) => i(s).donchianPos, 0.2, 0.8);
  banded('Realised vol', (s) => i(s).realisedVol, 30, 70);

  /*
   * RSI with the call is not the same question as RSI high: a breakdown into an
   * oversold RSI is a late entry, a breakout into an overbought one is a strong
   * one, and a band alone cannot tell them apart.
   */
  out.push({
    name: 'RSI momentum with the call',
    ok: (s) => { const v = i(s).rsi14; return v !== null && (s.side === 'UP' ? v > 55 : v < 45); },
  });
  out.push({
    name: 'RSI momentum against the call',
    ok: (s) => { const v = i(s).rsi14; return v !== null && (s.side === 'UP' ? v < 45 : v > 55); },
  });

  out.push({ name: 'Close at bar extreme (|CLV| > 0.6)', ok: (s) => { const v = i(s).clv; return v !== null && Math.abs(v) > 0.6; } });
  out.push({ name: 'No pattern named', ok: (s) => i(s).patternCount === 0 });
  out.push({ name: 'Three or more patterns named', ok: (s) => i(s).patternCount >= 3 });

  return out;
})();

// Every filter alone and every pair of compatible filters.
const FILTERS: Filter[] = [
  { name: 'all', ok: () => true },
  ...BASE_FILTERS,
  ...READING_FILTERS,
  /*
   * Pairs, but only of the original fourteen.
   *
   * Pairing the readings too would take the count from a few hundred to several
   * thousand, and at that width the winners are chosen by luck rather than
   * found: twenty filters tested at a one-in-twenty threshold produce one
   * "discovery" from noise alone. The readings get one clean pass each; if one
   * of them survives 2026 on its own, *then* it has earned a pair search.
   */
  ...BASE_FILTERS.flatMap((a, i) => BASE_FILTERS.slice(i + 1)
    .filter((b) => a.name.split(' ')[0] !== b.name.split(' ')[0])
    .map((b) => ({ name: `${a.name} + ${b.name}`, ok: (s: Signal) => a.ok(s) && b.ok(s) }))),
];

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
const avg = (t: Tally, net = true) => (t.n ? (net ? t.rNet : t.r) / t.n : 0);
const fr = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}R`;
const pad = (s: string, n: number) => s.padEnd(n);

/** One measured row per (timeframe, stop/target policy), emitted for the live card. */
type ScoreRow = {
  tf: Tf;
  /**
   * Which level definition found these breaks. The live card looks its own mode
   * up here; a mode with no row returns null and the card says "never graded"
   * rather than borrowing the other one's number. See `domain/level-mode.ts`.
   */
  mode: LevelMode;
  policy: string;
  n: number;
  noRoom: number;
  hitRate: number;
  avgR: number;
  netR: number;
  byYear: Record<string, { n: number; hitRate: number; netR: number }>;
};

async function main() {
  const out: string[] = [];
  const scorecard: ScoreRow[] = [];
  const say = (s = '') => { out.push(s); console.log(s); };
  const bars5m = await cachedCandles('BTCUSD', '5m', new Date('2024-04-01T00:00:00Z'), new Date(), (m) => console.error(m));
  const first = new Date(bars5m[0]!.time * 1000).toISOString().slice(0, 10);
  const last = new Date(bars5m[bars5m.length - 1]!.time * 1000).toISOString().slice(0, 10);

  say('Momentum call, replayed: every BREAKOUT/BREAKDOWN CONFIRMED the live card would have called.');
  say(`BTCUSD 5m bars ${first} → ${last} (${bars5m.length.toLocaleString()} bars). Same marketState(), same grader.`);
  say('Entry at the signal bar\'s close. A bar touching both stop and target counts as the stop.');
  say('Net = after 0.05% taker fee each side. R = profit ÷ risk. Chosen on 2024+2025; 2026 is out of sample.');
  say('Every reading docs/New.md asks for is swept as a filter, taken at the signal bar with no lookahead.');
  say('A null reading excludes the call rather than counting as neutral, so no filter is padded with calls it could not read.');
  say('Read the "by chance" line under each table before the table: at this many filters, some survive on luck.');
  say();

  for (const mode of LEVEL_MODES) {
  say('#'.repeat(96));
  say(`## LEVEL MODE: ${mode} — ${LEVEL_MODE_LABEL[mode]}`);
  say('   Both modes are graded because the live card and this study disagreed about the level until');
  say('   27 Sep 2026: live judged against swings, this judged against the rolling range, and the');
  say('   screen printed the rolling record beside a swing call. See docs/TODO.md.');
  say();
  for (const tf of TFS) {
    const { signals, bars } = extractSignals(bars5m, tf, mode);
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
      /*
       * The same row again, for the screen rather than for reading.
       *
       * The live momentum card has to print what this exact (timeframe,
       * stop/target policy) pair actually did, beside the call it is making.
       * Without it the card shows a hit rate and no cost, which is the number
       * that gets traded -- docs/FULL-STUDY.md §7.5.
       */
      scorecard.push({
        tf,
        mode,
        policy: p.name,
        n: all.n,
        noRoom: all.noRoom,
        hitRate: all.n ? all.hits / all.n : 0,
        avgR: avg(all, false),
        netR: avg(all),
        byYear: Object.fromEntries([...byYear].sort((a, b) => a[0] - b[0])
          .map(([y, t]) => [y, { n: t.n, hitRate: t.n ? t.hits / t.n : 0, netR: avg(t) }])),
      });
    }
    say();

    // Filters, chosen in sample and then tested out of sample.
    type Row = { policy: string; filter: string; ins: Tally; y: Record<number, Tally>; oos: Tally };
    const rows: Row[] = [];
    /*
     * Which signals each filter admits, worked out once.
     *
     * `f.ok(s)` does not depend on the stop/target policy, so evaluating it
     * inside the policy loop asked the same question six times over — about a
     * hundred million redundant calls per timeframe, on a sweep that had already
     * been killed once for taking too long. The membership is the same for every
     * policy; only the results differ.
     */
    const admits = new Map<string, boolean[]>();
    {
      const anyRs = [...results.values()][0] ?? [];
      /*
       * The mask is indexed, so every policy's array must be the same signals in
       * the same order. They are — each is `signals.map(...)` — but a silent
       * mis-alignment would quietly attribute one signal's result to another
       * filter's sample, and the whole sweep would still print a tidy table. So
       * it is checked rather than assumed.
       */
      for (const rs of results.values()) {
        if (rs.length !== anyRs.length) throw new Error('policy result arrays differ in length; the filter mask cannot be shared');
        for (let i = 0; i < rs.length; i++) {
          if (rs[i]!.s !== anyRs[i]!.s) throw new Error(`policy result arrays are not aligned at ${i}; the filter mask cannot be shared`);
        }
      }
      for (const f of FILTERS) admits.set(f.name, anyRs.map(({ s }) => f.ok(s)));
    }

    for (const [p, rs] of results) {
      for (const f of FILTERS) {
        const row: Row = { policy: p.name, filter: f.name, ins: emptyTally(), y: {}, oos: emptyTally() };
        const mask = admits.get(f.name)!;
        for (let idx = 0; idx < rs.length; idx++) {
          const { s, r } = rs[idx]!;
          if (!mask[idx]) continue;
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
    /*
     * What luck alone would produce.
     *
     * A filter has to be positive in two independent years to be eligible. If
     * every filter were pure noise, each year is a coin flip, so about a quarter
     * clear both — that is the number `eligible` has to beat before any of it
     * means anything. Printed every run, beside the count, because a table of
     * survivors with no null hypothesis beside it is how a sweep talks somebody
     * into a rule.
     */
    const byChance = Math.round(rows.length * 0.25);
    say(`   If every one of them were noise, about ${byChance} would clear that bar anyway (two coin-flip years).`);
    say(`   ${eligible.length >= byChance ? 'This run is at or below what chance alone gives' : 'This run is below what chance alone gives'} — treat the list as candidates, not findings.`);
    say('   Best ten by in-sample net R, and what they then did in 2026 without being re-chosen:');
    for (const r of eligible.slice(0, 10)) {
      const holds = r.oos.n >= 20 && avg(r.oos) > 0;
      say(`   ${holds ? 'HOLDS ' : 'fails '} ${pad(r.policy, 24)} ${pad(r.filter, 58)} in ${fr(avg(r.ins))} (${r.ins.n}, hit ${pct(r.ins.hits, r.ins.n)})` +
        `  2026 ${fr(avg(r.oos))} (${r.oos.n}, hit ${pct(r.oos.hits, r.oos.n)})`);
    }
    say();
  }
  }
  // How big the hour after a break is, not which way it goes. Research output only since
  // 28 Sep 2026, when the live risk card that read it was removed.
  say('='.repeat(96));
  say('== The hour after a break: how far, either way (in the break timeframe\'s ATR at the break)');
  say('   A break predicts a bigger hour, not a direction.');
  for (const tf of TFS) {
    const c = carryStats(bars5m, tf);
    const years = Object.entries(c.keptGoingByYear).map(([y, v]) => `${y} ${(v.keptGoing * 100).toFixed(1)}% of ${v.n}`).join(' · ');
    say(`   ${pad(tf, 4)} n ${pad(String(c.n), 5)} kept going after 1h ${(c.keptGoing * 100).toFixed(1)}% (${years})`);
    say(`        with the break  p50 ${c.withAtr[0]} p75 ${c.withAtr[1]} p90 ${c.withAtr[2]} p95 ${c.withAtr[3]} ATR` +
      `   against  p50 ${c.againstAtr[0]} p75 ${c.againstAtr[1]} p90 ${c.againstAtr[2]} p95 ${c.againstAtr[3]} ATR`);
    say(`        either way  p50 ${c.eitherAtr[0]} p90 ${c.eitherAtr[1]} ATR   vs any hour  p50 ${c.baselineEitherAtr[0]} p90 ${c.baselineEitherAtr[1]} ATR` +
      `   → ${((c.eitherAtr[0] / c.baselineEitherAtr[0] - 1) * 100).toFixed(0)}% bigger at the median`);
  }
  say();
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../research/MOMENTUM-MEASURED.txt'), out.join('\n') + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
