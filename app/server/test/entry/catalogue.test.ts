import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { recordSignals } from '../../src/entry/signals.js';
import { methodsSchema } from '../../src/entry/catalogue.js';
import { METHODS } from '../../src/entry/methods.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool, rows } from '../../src/db/pool.js';

after(closePool);

const T = 1_790_035_200;
const read = (id: string): MethodRead => ({
  id, n: 4, name: id, group: 'pullback', summary: '', mode: 'single', tf: '3m', dir: 'short', state: 'WAIT',
  steps: [], gates: [], plan: null, score: 50, scoreParts: [], alignment: null, reason: 'waiting', triggerTime: T,
});

test('[critical] the methods are in the database: 1-81 in the code\'s order, a method gone from the code kept as retired, and no row can name a method not in it', async () => {
  // A signal from a method the code has since dropped, written before the table existed.
  await recordSignals([read('dropped-method')], T * 1000);
  await methodsSchema();

  const db = await rows<{ id: string; n: number | null; code: string | null; ref: string | null; active: boolean }>(
    'SELECT id, n, code, ref, active FROM entry_methods ORDER BY n NULLS LAST, id');
  const live = db.filter((m) => m.active);
  assert.equal(live.length, 81);
  assert.deepEqual(live.map((m) => m.id), METHODS.map((m) => m.id), 'the code\'s order');
  assert.deepEqual(live.map((m) => m.n), Array.from({ length: 81 }, (_, i) => i + 1), 'numbered 1-81');
  assert.ok(live.every((m) => m.code === String(m.n)));
  assert.equal(live.find((m) => m.id === 'multi-factor')!.ref, '38a', 'the research number kept');
  assert.deepEqual(db.filter((m) => !m.active).map((m) => [m.id, m.n]), [['dropped-method', null]], 'kept, unnumbered: its rows are history');

  await recordSignals([read('fvg-retest')], T * 1000);
  await assert.rejects(recordSignals([read('no-such-method')], T * 1000), /entry_signals_method_fk/);
});
