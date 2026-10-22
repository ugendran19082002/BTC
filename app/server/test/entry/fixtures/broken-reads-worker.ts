import { parentPort } from 'node:worker_threads';

/** A signal thread whose every answer is a failure. */
parentPort?.on('message', (m: { id: number }) => parentPort!.postMessage({ id: m.id, ok: false, error: 'it broke' }));
