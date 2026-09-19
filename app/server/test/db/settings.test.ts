import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySettings, SettingsCache } from '../../src/db/settings.js';
import { closePool, one } from '../../src/db/pool.js';

/**
 * The settings cache: reads are from memory, writes reach the database before
 * the cache says so, and a fresh process sees what the last one wrote.
 */

after(() => closePool());

test('[critical] a write is in the database before set() resolves', async () => {
  const s = await new SettingsCache().load();
  await s.set('mode', 'live');
  const row = await one<{ value: string }>('SELECT value FROM settings WHERE key = $1', ['mode']);
  assert.equal(row?.value, 'live');
  assert.equal(s.get('mode'), 'live');
});

test('a second load sees what the first wrote -- a restart keeps its settings', async () => {
  const a = await new SettingsCache().load();
  await a.set('expiry_default', 'next_entry');
  const b = await new SettingsCache().load();
  assert.equal(b.get('expiry_default'), 'next_entry');
});

test('overwriting keeps one row per key', async () => {
  const s = await new SettingsCache().load();
  await s.set('max_short_contracts', '10');
  await s.set('max_short_contracts', '20');
  assert.equal(s.get('max_short_contracts'), '20');
  const n = await one<{ n: string }>('SELECT COUNT(*)::text AS n FROM settings WHERE key = $1', ['max_short_contracts']);
  assert.equal(n?.n, '1');
});

test('an unset key reads null, never undefined', async () => {
  const s = await new SettingsCache().load();
  assert.equal(s.get('never-written'), null);
});

test('[critical] reading before load() is a programming error, not a silent null', () => {
  const s = new SettingsCache();
  assert.throws(() => s.get('mode'), /before load/);
});

test('MemorySettings honours the same contract', async () => {
  const s = new MemorySettings({ mode: 'paper' });
  assert.equal(s.get('mode'), 'paper');
  await s.set('mode', 'live');
  assert.equal(s.get('mode'), 'live');
  assert.equal(s.get('x'), null);
});
