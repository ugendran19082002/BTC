import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceProduct, planFor, rig } from './harness.js';

test('journal events reach the listener with the trade before and after each one', async () => {
  const r = rig();
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, true);

  const submitted = r.events.find((x) => x.event.t === 'entry_submitted');
  assert.ok(submitted, `events seen: ${r.events.map((x) => x.event.t).join(', ')}`);
  assert.notEqual(submitted.before.phase, 'entry_pending');
  assert.equal(submitted.after.phase, 'entry_pending');

  for (const { event, before, after } of r.events) {
    if (event.t === 'fill' && event.role === 'entry') assert.equal(after.entrySize, before.entrySize + event.size);
  }
});

test('a listener that throws cannot stop the trade being opened or written down', async () => {
  const r = rig({ onEvent: () => { throw new Error('listener bug'); } });
  const res = await r.engine.open(planFor(ceProduct()));
  assert.equal(res.ok, true);
  assert.ok(r.events.length > 0);
  assert.ok(r.store.get(res.state.tradeId), 'the trade must still be in the journal');
});
