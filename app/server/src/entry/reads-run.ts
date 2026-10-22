import { Worker } from 'node:worker_threads';
import { allReads } from './engine.js';
import type { EntryContext, MethodRead, Tf } from './types.js';
import type { ReadsAnswer, ReadsAsk } from './reads-worker.js';

/**
 * Where the minute's signals are worked (22 Oct 2026): in a thread of their own once the server has asked for one
 * (`useReadsThread`, from index.ts), and otherwise here -- a test, a script.
 *
 * Never a minute without its signals: a thread that will not start, fails, or has not answered in `READS_TIMEOUT_MS`
 * is given up on for that minute and the reads are worked here, as they always were, and the trouble is said. A
 * thread that has never answered is not tried again for `GIVE_UP_MS`; one that answered before is started afresh the
 * next minute. The thread is kept between minutes -- its compiled code is what makes it quick -- and never keeps the
 * process alive. The same pattern as the backtests' (`report/backtest-run.ts`).
 */

export const READS_TIMEOUT_MS = 20_000;
const GIVE_UP_MS = 10 * 60_000;

export type Worked = {
  reads: MethodRead[];
  /** Working the methods, wherever it was done. */
  calcMs: number;
  /** What of it this thread spent: all of it here; handing the board over and taking the reads back, there. */
  mainMs: number;
  where: 'thread' | 'here';
};

let wanted = false;
let worker: Worker | null = null;
let proven = false;
let gaveUpAt = 0;
let seq = 0;
let fileGiven: URL | null = null;
let onTrouble: (message: string) => void = () => {};
const waiting = new Map<number, { done: (a: ReadsAnswer) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();

/** From now on the signals are worked in their own thread. `trouble` hears of a thread that failed, stalled or would not start. */
export function useReadsThread(trouble?: (message: string) => void, file?: URL): void {
  wanted = true;
  if (trouble) onTrouble = trouble;
  fileGiven = file ?? null;
}

/** Back to working them here, the thread let go: for tests. */
export function stopReadsThread(): void {
  wanted = false; proven = false; gaveUpAt = 0; fileGiven = null; onTrouble = () => {};
  drop('stopped');
}

function drop(why: string): void {
  const w = worker;
  worker = null;
  for (const [id, x] of waiting) { clearTimeout(x.timer); waiting.delete(id); x.fail(new Error(why)); }
  if (w) void w.terminate().catch(() => {});
}

function thread(): Worker {
  if (worker) return worker;
  // Beside this file, whichever the process runs: the built `.js`, or the `.ts` under tsx.
  const file = import.meta.url.endsWith('.ts') ? './reads-worker.ts' : './reads-worker.js';
  const w = new Worker(fileGiven ?? new URL(file, import.meta.url), { name: 'signal-reads', resourceLimits: { maxOldGenerationSizeMb: 256 } });
  w.unref();
  w.on('message', (a: ReadsAnswer) => {
    const x = waiting.get(a.id);
    if (!x) return;
    clearTimeout(x.timer); waiting.delete(a.id);
    x.done(a);
  });
  w.on('error', (e) => { if (worker === w) drop(`the signal thread failed: ${e.message}`); });
  w.on('exit', (code) => { if (worker === w) drop(`the signal thread stopped (code ${code})`); });
  worker = w;
  return w;
}

const here = (ctx: EntryContext, tfs?: readonly Tf[]): Worked => {
  const from = performance.now();
  const reads = tfs ? allReads(ctx, tfs) : allReads(ctx);
  const ms = performance.now() - from;
  return { reads, calcMs: ms, mainMs: ms, where: 'here' };
};

/** Every method's read on the market as read: in the signals' thread where there is one, here where there is not. */
export async function readsOf(ctx: EntryContext, o: { tfs?: readonly Tf[]; timeoutMs?: number } = {}): Promise<Worked> {
  if (!wanted || Date.now() - gaveUpAt < GIVE_UP_MS) return here(ctx, o.tfs);
  const timeoutMs = o.timeoutMs ?? READS_TIMEOUT_MS;
  let mainMs = 0;
  try {
    const a = await new Promise<ReadsAnswer>((done, fail) => {
      const id = ++seq;
      const w = thread();
      const timer = setTimeout(() => {
        waiting.delete(id);
        fail(new Error(`no answer in ${timeoutMs / 1000} s`));
        if (worker === w) drop('the signal thread was stopped: it ran past its time');
      }, timeoutMs);
      timer.unref();
      waiting.set(id, { done, fail, timer });
      const from = performance.now();
      w.postMessage({ id, ctx, ...(o.tfs ? { tfs: o.tfs } : {}) } satisfies ReadsAsk);
      mainMs = performance.now() - from;
    });
    if (!a.ok) throw new Error(a.error);
    proven = true;
    // Taking the answer back costs this thread too; it is timed as the reads are handed on.
    return { reads: a.reads, calcMs: a.calcMs, mainMs, where: 'thread' };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!proven) gaveUpAt = Date.now();
    onTrouble(proven
      ? `the signals were worked on the desk's own thread this minute: their thread ${why}`
      : `no signal thread could be started, so the signals are worked on the desk's own thread for now: ${why}`);
    return here(ctx, o.tfs);
  }
}
