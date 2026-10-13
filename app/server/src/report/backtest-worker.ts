import { parentPort } from 'node:worker_threads';
import { clearSignalBacktestCache, signalBacktestHere, type Ask } from './signal-backtest.js';
import { closePool } from '../db/pool.js';

/**
 * The signal backtest's own thread (13 Oct 2026). Asked by `backtest-run.ts`, one message a backtest; it reads the
 * database through a pool of its own and answers with the result, or with the words of what went wrong.
 *
 * Why a thread: a range of expiry days a minute at a time is seconds of reading and arithmetic, and done in the
 * desk's own thread it held everything else up for most of a second at a stretch -- the same thread that looks at
 * every open trade's stop once a second.
 */
export type BacktestAsk = { id: number; kind: 'run'; ask: Ask } | { id: number; kind: 'clear' } | { id: number; kind: 'close' };
export type BacktestAnswer = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };

const port = parentPort;
if (port) {
  port.on('message', (m: BacktestAsk) => {
    const answer = (a: BacktestAnswer) => port.postMessage(a);
    if (m.kind === 'clear') { clearSignalBacktestCache(); answer({ id: m.id, ok: true }); return; }
    if (m.kind === 'close') { void closePool().then(() => answer({ id: m.id, ok: true }), () => answer({ id: m.id, ok: true })); return; }
    signalBacktestHere(m.ask).then(
      (result) => answer({ id: m.id, ok: true, result }),
      (e) => answer({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
  });
}
