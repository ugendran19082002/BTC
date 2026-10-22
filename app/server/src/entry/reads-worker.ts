import { parentPort } from 'node:worker_threads';
import { allReads } from './engine.js';
import type { EntryContext, MethodRead, Tf } from './types.js';

/**
 * The signals' own thread (22 Oct 2026). Asked by `reads-run.ts`, one message a minute: the market as read
 * (`EntryContext`, plain data), answered with every method's read on it -- `allReads`, which reads nothing but what it
 * is handed, so the answer is the one the desk's own thread would have worked. Why a thread: the methods on every
 * timeframe held the desk's thread for a tenth of a second to a second, in the first seconds of every minute, and the
 * stop watch, the ticker socket and every order wait on that thread.
 */
export type ReadsAsk = { id: number; ctx: EntryContext; tfs?: readonly Tf[] };
export type ReadsAnswer = { id: number; ok: true; reads: MethodRead[]; calcMs: number } | { id: number; ok: false; error: string };

const port = parentPort;
if (port) {
  port.on('message', (m: ReadsAsk) => {
    try {
      const from = performance.now();
      const reads = m.tfs ? allReads(m.ctx, m.tfs) : allReads(m.ctx);
      port.postMessage({ id: m.id, ok: true, reads, calcMs: performance.now() - from } satisfies ReadsAnswer);
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies ReadsAnswer);
    }
  });
}
