import type { Candle } from '../market/delta.js';
import { levelsFrom, LEVEL_BARS } from './market-state.js';
import { swingLevels } from '../market/moves.js';

/**
 * Which level the state machine judges against — named, shared, and measured.
 *
 * ## The bug this file exists to make impossible
 *
 * Until 27 September 2026 the live path and the measured path used **different
 * levels**, and nothing said so:
 *
 * ```
 * live      market/state-read.ts   levelFor()  -> nearest fractal SWING high/low  (removed 28 Sep 2026)
 * measured  domain/break-risk.ts   level: null -> levelsFrom(): the 20-bar high/low
 * ```
 *
 * Measured at one instant on the same sixty 5-minute bars: the swing resistance
 * was **84,546**, the rolling one **84,503**. A swing high is a local peak with
 * two bars either side, so it sits further away — the live card needed a bigger
 * move to reach WATCH and a bigger one again to CONFIRM than anything the study
 * had ever graded. Replaying 17.5 hours through the *rolling* level produced 80
 * state changes including seven confirmed breaks; the live journal, on swing
 * levels, recorded none of them.
 *
 * The screen meanwhile printed the rolling level's record — "23% hit, −0.612R
 * net over 9,981" — beside a swing-level call. Honest about its own sample, and
 * describing a different signal. The sibling project states the rule this
 * violates: *the training grid and the signal grid must match; a mismatch is
 * silent.*
 *
 * ## The fix
 *
 * One function, an explicit mode, and the mode travels with every measurement.
 * `momentum-study.ts` grades **both** modes, `momentum-measured.data.ts` keys
 * its rows by mode, and the card looks up the mode the live read actually used.
 * A mode with no graded row returns null and the card says "never graded" rather
 * than borrowing the other one's number.
 *
 * Adding a third definition means adding it here and re-running the study. It
 * cannot be added to only one side.
 */

export type LevelMode = 'rolling' | 'swing';

/** What each mode means, for the screen and for anyone reading a measured table. */
export const LEVEL_MODE_LABEL: Record<LevelMode, string> = {
  rolling: `the last ${LEVEL_BARS} bars' high and low`,
  swing: 'the nearest fractal swing high and low',
};

/**
 * The default, and it is `rolling` on purpose: it is the only mode with a
 * measured record behind it as of 27 Sep 2026. A mode becomes eligible to be the
 * default by being measured, not by being reasoned about.
 */
export const DEFAULT_LEVEL_MODE: LevelMode = 'rolling';

/**
 * The mode the live desk judges against — one constant, read by both the live
 * state read and the measured lookup.
 *
 * It lives here rather than in either consumer on purpose: while it lived in the
 * momentum module the live path had to import from it to stay in step, which is
 * the wrong direction and would have let the two drift again the moment somebody
 * tidied that import away.
 *
 * Changing it without re-running `momentum-study.ts` for that mode puts the card
 * back where it was on 27 Sep 2026: a measured figure beside a signal it does not
 * describe.
 */
export const LIVE_LEVEL_MODE: LevelMode = DEFAULT_LEVEL_MODE;

/**
 * The level to judge `bars` against, under `mode`.
 *
 * Both modes fall back to the rolling range when their own definition finds
 * nothing — a timeframe with no fractal swing in its window still has a high and
 * a low, and refusing to judge it at all would silently drop that timeframe from
 * the journal. The fallback is the same one `marketState` uses internally, so a
 * frame that falls back is judged identically under either mode.
 */
export function levelUnder(
  bars: readonly Candle[],
  mode: LevelMode,
): { resistance: number | null; support: number | null } {
  const rolling = levelsFrom(bars, LEVEL_BARS);
  if (mode === 'rolling') return rolling;

  const close = bars[bars.length - 1]?.close;
  if (close === undefined) return rolling;
  // The bar being formed is excluded, the same way `levelsFrom` excludes it: a
  // swing needs two bars either side, and the newest bar has none after it.
  const past = bars.slice(0, -1);
  const { resistance, support } = swingLevels(past, close);
  return {
    resistance: resistance[0] ?? rolling.resistance,
    support: support[0] ?? rolling.support,
  };
}

/**
 * How far apart the two modes are right now, in dollars.
 *
 * For the screen and for the study's own report: a day where they agree is a day
 * the mismatch would not have mattered, and knowing which kind of day it is
 * matters more than the average.
 */
export function modeGap(bars: readonly Candle[]): { resistance: number | null; support: number | null } {
  const a = levelUnder(bars, 'rolling');
  const b = levelUnder(bars, 'swing');
  return {
    resistance: a.resistance !== null && b.resistance !== null ? Math.round((b.resistance - a.resistance) * 10) / 10 : null,
    support: a.support !== null && b.support !== null ? Math.round((b.support - a.support) * 10) / 10 : null,
  };
}
