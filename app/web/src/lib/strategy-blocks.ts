import { MAX_STRIKE_BLOCKS, MAX_STRIKE_STEP, elseOtmOf, strikeLabel, type StrategyConfig, type StrikeBlock } from '@/types/strategy';
import { hhmmOf, isHhmm, minutesForward, minutesOf, time12 } from '@/lib/time';
import { minOtmProblems, premiumFallbackProblem } from '@/lib/strategy-exits';

/**
 * A signal strategy's strike rule over its window, as the form works with it.
 *
 * The window is cut into blocks -- every four hours unless said otherwise --
 * and each block picks its strike by its own rule. Block 1 is the strategy's
 * own rule, from the entry; the rest are `strikeBlocks`, each from its time
 * until the next. Pure, so the split, the ranges and the words can be tested
 * without a form.
 */

/** How a strike is picked: the three fields that say it, on the strategy or on a block. */
export type StrikePick = Pick<StrategyConfig, 'strikeRule' | 'strikeStep' | 'premium'>;

/** The split the form offers first. */
export const DEFAULT_BLOCK_HOURS = 4;

/**
 * The length the window is cut at, read back from the blocks themselves: how
 * far block 2 starts after the window does. A strategy split every 3 hours and
 * saved opens showing 3, not the form's 4 -- the length is not stored, the
 * blocks are, so the blocks are where it is read from. No blocks, or a first
 * block with no usable time or outside the window: the default.
 */
export function blockHoursOf(c: StrategyConfig): number {
  const first = c.strikeBlocks?.[0];
  if (!first || !isHhmm(first.at) || !isHhmm(c.entryTime) || !isHhmm(c.exitTime)) return DEFAULT_BLOCK_HOURS;
  const entry = minutesOf(c.entryTime);
  const gap = minutesForward(entry, minutesOf(first.at));
  // A first block outside the window -- the window was moved from under it -- says nothing about a length.
  if (gap === 0 || gap >= minutesForward(entry, minutesOf(c.exitTime))) return DEFAULT_BLOCK_HOURS;
  return Math.round((gap / 60) * 100) / 100;
}

/** The strategy's own rule as a block would carry it; the wall, which a block cannot be, reads as premium. */
export function ownPick(c: StrategyConfig): Omit<StrikeBlock, 'at'> {
  return { strikeRule: c.strikeRule === 'strict' ? 'strict' : 'premium', strikeStep: c.strikeStep, premium: { ...c.premium } };
}

/**
 * Cut the window every `everyMin` from the entry: 5:35 PM to 5:29 PM every
 * four hours is 4, 4, 4, 4, 4 and the 3 h 54 min that is left -- five blocks
 * after the strategy's own.
 *
 * Each new block starts as a copy of the rule in force at its time -- the
 * block already there, else the strategy's own -- so splitting again at
 * another length keeps what was typed rather than wiping it.
 */
export function splitBlocks(c: StrategyConfig, everyMin: number): StrikeBlock[] {
  if (!isHhmm(c.entryTime) || !isHhmm(c.exitTime) || !(everyMin >= 1)) return [];
  const entry = minutesOf(c.entryTime);
  const span = minutesForward(entry, minutesOf(c.exitTime));
  const out: StrikeBlock[] = [];
  for (let at = Math.round(everyMin); at < span && out.length < MAX_STRIKE_BLOCKS; at += Math.round(everyMin)) {
    const { strikeRule, strikeStep, premium } = pickAt(c, at);
    out.push({ at: hhmmOf(entry + at), strikeRule: strikeRule === 'strict' ? 'strict' : 'premium', strikeStep, premium: { ...premium } });
  }
  return out;
}

/** The rule in force `since` minutes into the window: the last block started by then, else the strategy's own. */
function pickAt(c: StrategyConfig, since: number): StrikePick {
  const entry = minutesOf(c.entryTime);
  let pick: StrikePick = ownPick(c);
  for (const b of c.strikeBlocks ?? []) {
    if (isHhmm(b.at) && minutesForward(entry, minutesOf(b.at)) <= since) pick = b;
  }
  return pick;
}

/** One block as the screen lists it: when it runs, and for how long. */
export type BlockRange = { from: string; until: string; minutes: number };

/**
 * Every block's hours, the strategy's own rule first: each from its time to the
 * next block's, the last to the exit. A block with no time yet has no range.
 */
export function blockRanges(c: StrategyConfig): (BlockRange | null)[] {
  if (!isHhmm(c.entryTime) || !isHhmm(c.exitTime)) return [null, ...(c.strikeBlocks ?? []).map(() => null)];
  const starts = [c.entryTime, ...(c.strikeBlocks ?? []).map((b) => b.at)];
  return starts.map((from, i) => {
    const until = starts[i + 1] ?? c.exitTime;
    if (!isHhmm(from) || !isHhmm(until)) return null;
    return { from, until, minutes: minutesForward(minutesOf(from), minutesOf(until)) };
  });
}

/** "4 h", "3 h 54 min", "45 min". */
export function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * A block's rule in a few words: "≤ $40", "≥ $15 (if none, ≥ $10)",
 * "≤ $50 at OTM 6 or further, else OTM 8", "OTM 2". The signs are the form's
 * own, and "else" is kept for the else strike alone -- the premium's second
 * number is "if none".
 */
export function pickWords(p: StrikePick): string {
  if (p.strikeRule === 'strict') return strikeLabel(p.strikeStep);
  const sign = p.premium.mode === 'atLeast' ? '≥' : '≤';
  const f = p.premium.fallbackUsd;
  const m = p.premium.minOtm;
  return `${sign} $${p.premium.usd}`
    + (f === null || f === undefined ? '' : ` (if none, ${sign} $${f})`)
    + (m === null || m === undefined ? '' : ` at ${strikeLabel(m)} or further, else ${strikeLabel(elseOtmOf(p.premium)!)}`);
}

/** " — then from 9:35 PM at most $40, from 1:35 AM OTM 2", or nothing when there is one rule all window. */
export function blocksWords(c: StrategyConfig): string {
  const blocks = c.strikeBlocks ?? [];
  if (blocks.length === 0) return '';
  return ` — then ${blocks.map((b) => `from ${isHhmm(b.at) ? time12(b.at) : '?'} ${pickWords(b)}`).join(', ')}`;
}

/** One block's problems, kept apart so the form can say each under its own row. */
export type BlockProblem = { index: number; message: string };

/**
 * What is wrong with the blocks -- the server's `strikeBlockProblems`, in its
 * words. `index` is the block's place in `strikeBlocks`, or -1 for the list.
 */
export function strikeBlockProblems(blocks: StrikeBlock[] | undefined, entryTime: string, exitTime: string): BlockProblem[] {
  if (!blocks) return [];
  const bad: BlockProblem[] = [];
  if (blocks.length > MAX_STRIKE_BLOCKS) bad.push({ index: -1, message: `The strike rule can change at most ${MAX_STRIKE_BLOCKS} times in a window.` });
  const windowOk = isHhmm(entryTime) && isHhmm(exitTime);
  const entry = windowOk ? minutesOf(entryTime) : 0;
  const span = windowOk ? minutesForward(entry, minutesOf(exitTime)) : 0;
  let last = 0;
  blocks.forEach((b, index) => {
    const n = index + 2;
    const say = (message: string) => bad.push({ index, message });
    if (!isHhmm(b.at)) {
      say(`Block ${n} needs a time of day, like 9:35 PM.`);
    } else if (windowOk) {
      const at = minutesForward(entry, minutesOf(b.at));
      if (at === 0 || at >= span) {
        say(`Block ${n} (${time12(b.at)}) must start after entry (${time12(entryTime)}) and before exit (${time12(exitTime)}).`);
      } else if (at <= last) {
        say(`Block ${n} (${time12(b.at)}) must start after block ${n - 1}.`);
      }
      last = Math.max(last, at);
    }
    if (b.strikeRule !== 'premium' && b.strikeRule !== 'strict') {
      say(`Block ${n}: pick the strike by premium or by strike.`);
    } else if (b.strikeRule === 'strict') {
      if (!Number.isInteger(b.strikeStep) || Math.abs(b.strikeStep) > MAX_STRIKE_STEP) {
        say(`Block ${n}: pick a strike between ITM ${MAX_STRIKE_STEP} and OTM ${MAX_STRIKE_STEP}, or at the money.`);
      }
    } else if (b.premium.mode !== 'atLeast' && b.premium.mode !== 'atMost') {
      say(`Block ${n}: the premium rule must be "at least" or "at most".`);
    } else if (!(b.premium.usd > 0) || b.premium.usd > 10_000) {
      say(`Block ${n}: the premium must be a positive number of dollars.`);
    } else {
      const f = premiumFallbackProblem(b.premium);
      if (f) say(`Block ${n}: ${f}`);
      for (const m of minOtmProblems(b.premium)) say(`Block ${n}: ${m}`);
    }
  });
  return bad;
}

/** The four fields that hold every block's rule: block 1's on the strategy, the rest in `strikeBlocks`. */
export type BlockRules = Pick<StrategyConfig, 'strikeRule' | 'strikeStep' | 'premium' | 'strikeBlocks'>;

/**
 * "Apply to all blocks" (owner, 8 Oct 2026): one block's premium -- its ≥ or ≤, its number and its "if none"
 * number -- copied onto every block, so a number worked out once is not typed six times. `from` is the block's
 * place on the screen: 0 is block 1, the strategy's own rule.
 *
 * What is copied is what the owner named, the entry premium and its "if none". Each block keeps its own time, and
 * its own distance rule (the OTM strike it must be at, and the else strike): that part is set per block on
 * purpose, the far blocks of a day sitting further out than the near ones. A block picked "by strike" copies its
 * strike instead, and turns the others to "by strike" with it.
 *
 * Returns null where there is nothing to copy from, or the block's premium is not a usable number -- the form
 * greys the button there rather than spread a mistake across the day.
 */
export function applyToAllBlocks(c: StrategyConfig, from: number): BlockRules | null {
  const blocks = c.strikeBlocks ?? [];
  const src = from === 0 ? ownPick(c) : blocks[from - 1];
  if (!src) return null;
  if (src.strikeRule === 'premium' && (!(src.premium.usd > 0) || src.premium.usd > 10_000 || premiumFallbackProblem(src.premium))) return null;
  if (src.strikeRule === 'strict' && (!Number.isInteger(src.strikeStep) || Math.abs(src.strikeStep) > MAX_STRIKE_STEP)) return null;
  const onto = <T extends Omit<StrikeBlock, 'at'>>(b: T): T => (src.strikeRule === 'strict'
    ? { ...b, strikeRule: 'strict', strikeStep: src.strikeStep }
    : { ...b, strikeRule: 'premium', premium: { ...b.premium, mode: src.premium.mode, usd: src.premium.usd, fallbackUsd: src.premium.fallbackUsd ?? null } });
  const first = onto(ownPick(c));
  return { strikeRule: first.strikeRule, strikeStep: first.strikeStep, premium: first.premium, strikeBlocks: blocks.map(onto) };
}

/** What "Apply to all blocks" copies, in a few words: "≤ $50 (if none, ≤ $60)", "OTM 2". The distance rule is not copied, so it is not said. */
export function appliedWords(p: StrikePick): string {
  return pickWords(p.strikeRule === 'strict' ? p : { ...p, premium: { ...p.premium, minOtm: null, elseOtm: null } });
}

/** The IST minute of the day at an instant (epoch ms): the clock every strategy time is read on. */
export const istMinuteOf = (ms: number): number => (((Math.floor(ms / 60_000) + 330) % 1440) + 1440) % 1440;

/**
 * The block the clock is in now -- the rule a signal arriving this minute is
 * sold under -- with when it ends and what comes after. The same reading as the
 * server's `strikePickAt`: measured forward from the window's start, the last
 * block started by now. Null outside the window (between its end and its next
 * start), or while a time is not set.
 *
 * `n` is the block's number as the form counts them: 1 is the strategy's own
 * rule, and with no blocks at all it is the only one.
 */
export function blockNow(c: StrategyConfig, istMinute: number): {
  n: number; of: number; from: string; until: string; minutesLeft: number; pick: StrikePick;
  next: { n: number; at: string; pick: StrikePick } | null;
} | null {
  if (!isHhmm(c.entryTime) || !isHhmm(c.exitTime)) return null;
  const entry = minutesOf(c.entryTime);
  const span = minutesForward(entry, minutesOf(c.exitTime));
  const since = minutesForward(entry, istMinute);
  if (since >= span) return null;
  const blocks = (c.strikeBlocks ?? []).filter((b) => isHhmm(b.at));
  const starts = [0, ...blocks.map((b) => minutesForward(entry, minutesOf(b.at)))];
  const picks: StrikePick[] = [ownPick(c), ...blocks];
  let i = 0;
  starts.forEach((at, j) => { if (at <= since) i = j; });
  const end = starts[i + 1] ?? span;
  return {
    n: i + 1, of: starts.length,
    from: hhmmOf(entry + starts[i]!), until: hhmmOf(entry + end), minutesLeft: end - since,
    pick: picks[i]!,
    next: i + 1 < starts.length ? { n: i + 2, at: hhmmOf(entry + starts[i + 1]!), pick: picks[i + 1]! } : null,
  };
}
