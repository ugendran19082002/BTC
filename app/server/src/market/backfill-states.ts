import { candles, type Candle } from './delta.js';
import { atr } from './moves.js';
import { marketState } from '../domain/market-state.js';
import { levelUnder, LIVE_LEVEL_MODE } from '../domain/level-mode.js';
import { query, one } from '../db/pool.js';
import { gradeStates, EVAL_WINDOW_MIN } from './state-history.js';
import { STATE_TFS, STATE_TF_MINUTES, type StateTf } from './state-read.js';

/**
 * Replay the bars the journal missed and write the state changes it should have
 * recorded.
 *
 * Runs on boot. Before 27 Sep 2026 the journal only advanced while somebody had
 * the screen open, so every unwatched hour is a hole; this fills them from the
 * venue's own candles, using the same rules the live read uses.
 *
 * Safe to run repeatedly: it starts after the newest row for each timeframe,
 * skips a timeframe whose newest row is under ten minutes old, and repeats the
 * `(event, stage)` dedupe. The database enforces that dedupe as well
 * (`market-017-state-dedupe-at-db`), so a race between this and the live
 * recorder cannot double-count a call.
 */
export async function backfillStates(hours = 24): Promise<{ tf: string; inserted: number }[]> {
  const nowMs = Date.now();
  const endSec = Math.floor(nowMs / 1000);
  const results: { tf: string; inserted: number }[] = [];

  for (const tf of STATE_TFS) {
    const lastRow = await one<{ at: number; event: string; stage: string }>(
      'SELECT at, event, stage FROM market_states WHERE tf = $1 ORDER BY at DESC LIMIT 1',
      [tf],
    );

    const lastAtMs = lastRow ? Number(lastRow.at) : (nowMs - hours * 3600 * 1000);
    // If last row was recent (< 10 minutes), skip backfill for this tf
    if (nowMs - lastAtMs < 10 * 60_000) {
      results.push({ tf, inserted: 0 });
      continue;
    }

    // Fetch bars from Delta covering lookback
    const startSec = Math.floor(lastAtMs / 1000) - 25 * STATE_TF_MINUTES[tf] * 60;
    const bars = await candles('BTCUSD', startSec, endSec, tf).catch(() => [] as Candle[]);
    if (bars.length < 25) {
      results.push({ tf, inserted: 0 });
      continue;
    }

    let inserted = 0;
    let prevEvent = lastRow?.event ?? null;
    let prevStage = lastRow?.stage ?? null;

    for (let i = 25; i < bars.length; i++) {
      const bar = bars[i]!;
      const barMs = bar.time * 1000;
      if (barMs <= lastAtMs) continue;

      const window = bars.slice(0, i + 1);
      const a = atr(window, 14);
      /*
       * The same level definition the live read uses, not a hard-coded one.
       *
       * It called `levelsFrom` directly, which happens to equal the live mode
       * today -- and would silently stop matching the moment `LIVE_LEVEL_MODE`
       * changed, putting backfilled rows and live rows in one table under two
       * different definitions. That is the 27 Sep bug in miniature; see
       * `domain/level-mode.ts`.
       */
      const level = levelUnder(window, LIVE_LEVEL_MODE);
      const s = marketState({ bars: window, level, atr: a, tick: 0.5, tfLabel: tf });

      if (s.event === prevEvent && s.stage === prevStage) continue;

      prevEvent = s.event;
      prevStage = s.stage;

      await query(
        `INSERT INTO market_states
           (at, tf, event, stage, side, confirmed, confidence, close, resistance, support,
            trigger, target1, target2, invalidation,
            words, insight, volume_ratio, atr, parts, inputs, patterns, indicators,
            confirmed_at, eval_window_min, score, probability)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 $15,$16,$17,$18,$19,$20,$21,$22,
                 $23,$24,$25,$26)`,
        [
          barMs, tf, s.event, s.stage, s.side, s.confirmed, s.confidence, bar.close,
          s.level.resistance, s.level.support,
          s.plan?.trigger ?? null, s.plan?.target1 ?? null, s.plan?.target2 ?? null, s.plan?.invalidation ?? null,
          s.words, s.insight, s.volumeRatio, a,
          JSON.stringify(s.parts), JSON.stringify({ atr: a }),
          JSON.stringify([]), JSON.stringify([]),
          s.confirmed ? barMs : null,
          EVAL_WINDOW_MIN[tf] ?? 30,
          s.confidence,
          null,
        ],
      );
      inserted++;
    }

    results.push({ tf, inserted });
  }

  // Grade whatever can be graded
  await gradeStates(nowMs, 100);

  return results;
}

if (process.argv[1]?.endsWith('backfill-states.ts') || process.argv[1]?.endsWith('backfill-states.js')) {
  backfillStates().then((res) => {
    console.log('Backfill results:', res);
    process.exit(0);
  }).catch((e) => {
    console.error('Backfill error:', e);
    process.exit(1);
  });
}
