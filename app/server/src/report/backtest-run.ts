import { Worker } from 'node:worker_threads';
import {
  clearSignalBacktestCache as clearHere, liveCheckHere, portfolioBacktestHere, portfolioTradesHere, signalBacktestHere, signalBacktestTradesHere, volStudyHere, portfolioVolStudyHere, volStudyTradesHere, portfolioVolStudyTradesHere,
  type Ask, type BacktestPortfolioResult, type BtDayTrades, type LiveCheck, type LiveCheckAsk, type PortfolioAsk, type SignalBacktest, type TradePick, type VolStudy, type VolStudyAsk, type PortfolioVolStudyAsk, type VolTradesPick,
} from './signal-backtest.js';
import type { BacktestAnswer, BacktestAsk } from './backtest-worker.js';

/**
 * Where a signal backtest is worked out: in a thread of its own once the server has asked for one
 * (`useBacktestThread`, from index.ts), and otherwise here -- a test, a script, a tool.
 *
 * The thread is started at the first backtest and kept: its cache of days already worked is what makes the second
 * one quick. It never keeps the process alive. A backtest that fails there is an answer in words to whoever asked;
 * a thread that will not start at all is given up on for a while and the backtest is worked here instead, as it
 * always was -- slower for the rest of the desk, but an answer.
 */

/** A backtest that has not answered in this long is given up on, and its thread with it. */
export const BACKTEST_TIMEOUT_MS = 120_000;
/** What the thread is asked to work: a backtest, a portfolio, a live check, the volatility study, or one day of a backtest or a portfolio. */
type Work = { kind: 'run'; ask: Ask } | { kind: 'vol-study'; ask: VolStudyAsk } | { kind: 'portfolio-vol-study'; ask: PortfolioVolStudyAsk } | { kind: 'vol-trades'; ask: VolStudyAsk; pick: VolTradesPick } | { kind: 'portfolio-vol-trades'; ask: PortfolioVolStudyAsk; pick: VolTradesPick } | { kind: 'portfolio'; ask: PortfolioAsk } | { kind: 'live'; ask: LiveCheckAsk } | { kind: 'trades'; ask: Ask; pick: TradePick } | { kind: 'portfolio-trades'; ask: PortfolioAsk; pick: TradePick };
/** After a thread fails to start, none is tried again for this long. */
const GIVE_UP_MS = 10 * 60_000;

let wanted = false;
let worker: Worker | null = null;
let gaveUpAt = 0;
/** Whether a thread has ever answered: one that never has, and fails, could not be started here at all. */
let proven = false;
let seq = 0;
const waiting = new Map<number, { done: (a: BacktestAnswer) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
let onTrouble: (message: string) => void = () => {};
/** The thread's own file, where a test names another; null is the one beside this. */
let fileGiven: URL | null = null;

/** From now on backtests are worked in their own thread. `trouble` hears of a thread that died or would not start. */
export function useBacktestThread(trouble?: (message: string) => void, file?: URL): void {
  wanted = true;
  if (trouble) onTrouble = trouble;
  fileGiven = file ?? null;
}

function drop(why: string): void {
  const w = worker;
  worker = null;
  for (const [id, x] of waiting) { clearTimeout(x.timer); waiting.delete(id); x.fail(new Error(why)); }
  if (w) void w.terminate().catch(() => {});
}

function thread(): Worker {
  if (worker) return worker;
  // The same file as this one's sibling, whichever of the two the process runs: the built `.js`, or the `.ts` under tsx.
  const file = import.meta.url.endsWith('.ts') ? './backtest-worker.ts' : './backtest-worker.js';
  const w = new Worker(fileGiven ?? new URL(file, import.meta.url), { name: 'signal-backtest', resourceLimits: { maxOldGenerationSizeMb: 1_024 } });
  w.unref();
  w.on('message', (a: BacktestAnswer) => {
    proven = true;
    const x = waiting.get(a.id);
    if (!x) return;
    clearTimeout(x.timer); waiting.delete(a.id);
    x.done(a);
  });
  w.on('error', (e) => { if (worker === w) { onTrouble(`the backtest thread failed: ${e.message}`); drop(`The backtest thread failed: ${e.message}`); } });
  w.on('exit', (code) => { if (worker === w) { if (code !== 0) onTrouble(`the backtest thread stopped (code ${code})`); drop('The backtest thread stopped before it answered.'); } });
  worker = w;
  return w;
}

function ask(m: Work | { kind: 'clear' } | { kind: 'close' }, timeoutMs = BACKTEST_TIMEOUT_MS): Promise<BacktestAnswer> {
  return new Promise((done, fail) => {
    const id = ++seq;
    const w = thread();
    const timer = setTimeout(() => {
      waiting.delete(id);
      fail(new Error('The backtest took too long and was stopped.'));
      // Whatever it was doing, it is still doing it: a new thread for the next one.
      if (worker === w) { onTrouble('a backtest ran past its time; its thread was stopped'); drop('The backtest thread was stopped.'); }
    }, timeoutMs);
    timer.unref();
    waiting.set(id, { done, fail, timer });
    w.postMessage({ id, ...m } satisfies BacktestAsk);
  });
}

/**
 * The same question asked again while it is being worked -- a second tab, the screen's own poll landing on a long
 * run -- shares the answer being worked rather than waiting in line behind it for a second, identical one (18 Oct 2026:
 * a portfolio is several backtests' work, and the thread works one at a time). Asked as the same, `now` apart.
 */
const asking = new Map<string, Promise<unknown>>();
function worked<T>(m: Work, here: () => Promise<T>, timeoutMs = BACKTEST_TIMEOUT_MS): Promise<T> {
  const key = JSON.stringify(m, (k, v) => (k === 'now' ? undefined : v));
  const held = asking.get(key);
  if (held) return held as Promise<T>;
  const run = workedNow(m, here, timeoutMs).finally(() => { if (asking.get(key) === run) asking.delete(key); });
  asking.set(key, run);
  return run;
}

/** In its thread where there is one, here where there is not. */
async function workedNow<T>(m: Work, here: () => Promise<T>, timeoutMs = BACKTEST_TIMEOUT_MS): Promise<T> {
  if (!wanted || Date.now() - gaveUpAt < GIVE_UP_MS) return here();
  let a: BacktestAnswer;
  try {
    a = await ask(m, timeoutMs);
  } catch (e) {
    // No thread has ever answered: it cannot be started here. Work it in this one, and do not try again for a while.
    if (!proven) {
      gaveUpAt = Date.now();
      onTrouble(`no backtest thread could be started, so backtests are worked in the desk's own for now: ${(e as Error).message}`);
      return here();
    }
    throw e;
  }
  if (!a.ok) throw new Error(a.error);
  return a.result as T;
}

/** One backtest. */
export const signalBacktest = (o: Ask): Promise<SignalBacktest> => worked({ kind: 'run', ask: o }, () => signalBacktestHere(o));

/** Several over the same days, and their total: each is a whole backtest, so it is given a whole backtest's time each. */
export const portfolioBacktest = (o: PortfolioAsk): Promise<BacktestPortfolioResult> =>
  worked({ kind: 'portfolio', ask: o }, () => portfolioBacktestHere(o), BACKTEST_TIMEOUT_MS * Math.max(1, o.members.length));

/** Forget every day worked so far, wherever they are kept. */
/** A backtest's trades, by day, session and method (`signalBacktestTradesHere`). */
export const signalBacktestTrades = (o: Ask, pick: TradePick): Promise<BtDayTrades> =>
  worked({ kind: 'trades', ask: o, pick }, () => signalBacktestTradesHere(o, pick), BACKTEST_TIMEOUT_MS * (pick.day ? 1 : 3));
/** A portfolio run's trades, by day, session and method (`portfolioTradesHere`). */
export const portfolioTrades = (o: PortfolioAsk, pick: TradePick): Promise<BtDayTrades> =>
  worked({ kind: 'portfolio-trades', ask: o, pick }, () => portfolioTradesHere(o, pick), BACKTEST_TIMEOUT_MS * Math.max(1, o.members.length) * (pick.day ? 1 : 3));

/** The option's fixed stop against one by volatility, on the same trades (`volStudyHere`): three backtests' work, so three backtests' time. */
export const volStudy = (o: VolStudyAsk): Promise<VolStudy> => worked({ kind: 'vol-study', ask: o }, () => volStudyHere(o), BACKTEST_TIMEOUT_MS * 3);
/** The same over saved backtests run together: three backtests' time for each of them. */
export const portfolioVolStudy = (o: PortfolioVolStudyAsk): Promise<VolStudy> =>
  worked({ kind: 'portfolio-vol-study', ask: o }, () => portfolioVolStudyHere(o), BACKTEST_TIMEOUT_MS * 3 * Math.max(1, o.members.length));
/** One expiry day of the study, trade by trade: one side, one way of reading the level. */
export const volStudyTrades = (o: VolStudyAsk, pick: VolTradesPick): Promise<BtDayTrades> => worked({ kind: 'vol-trades', ask: o, pick }, () => volStudyTradesHere(o, pick));
export const portfolioVolStudyTrades = (o: PortfolioVolStudyAsk, pick: VolTradesPick): Promise<BtDayTrades> =>
  worked({ kind: 'portfolio-vol-trades', ask: o, pick }, () => portfolioVolStudyTradesHere(o, pick), BACKTEST_TIMEOUT_MS * Math.max(1, o.members.length));

/** The backtest of each strategy's own rules against what the desk did with the same signals (`liveCheckHere`). */
export const liveCheck = (o: LiveCheckAsk): Promise<LiveCheck> => worked({ kind: 'live', ask: o }, () => liveCheckHere(o), BACKTEST_TIMEOUT_MS * 2);

export async function clearSignalBacktestCache(): Promise<void> {
  clearHere();
  if (worker) await ask({ kind: 'clear' }, 5_000).catch(() => {});
}

/** Stop the thread, closing its connections first: for a process shutting down, and for a test. */
export async function stopBacktestThread(): Promise<void> {
  if (worker) {
    await ask({ kind: 'close' }, 5_000).catch(() => {});
    drop('The backtest thread was stopped.');
  }
  wanted = false; proven = false; gaveUpAt = 0; fileGiven = null;
}
