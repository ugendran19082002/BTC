import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool, query, rows } from '../../src/db/pool.js';
import { SettingsCache } from '../../src/db/settings.js';

/**
 * The best pick's alert and automatic trade went on 4 Oct 2026. Their keys
 * were on the desk -- `auto_trade`, its ledger, the alert's switch and counts --
 * and a key nothing reads must not sit there looking like a live setting.
 */
after(() => closePool());

test('[critical] the retired best-pick keys are removed once; every other setting is left exactly as it was', async () => {
  await new SettingsCache().load(); // the table, as a desk before this change had it
  await query("DELETE FROM public.schema_migrations WHERE id = 'trading-007-retire-best-pick-settings'");
  const before: [string, string][] = [
    ['auto_trade', '{"on":false,"lots":10}'], ['auto_trade_limits', '{"maxLots":50}'], ['auto_trade_done', '{"expiry":"190926"}'],
    ['best_trade_alert', '0'], ['best_trade_last', ''], ['best_trade_sent', '{}'], ['best_trade_repeat', '2'],
    ['best_trade_min_premium', '7'], ['scheduler_enabled', '1'], ['signal_max_open', '28'], ['mode', 'paper'],
  ];
  for (const [k, v] of before) await query('INSERT INTO public.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);

  const settings = await new SettingsCache().load();
  const left = (await rows<{ key: string }>('SELECT key FROM public.settings ORDER BY key')).map((r) => r.key);
  for (const k of ['auto_trade', 'auto_trade_limits', 'auto_trade_done', 'best_trade_alert', 'best_trade_last', 'best_trade_sent', 'best_trade_repeat']) {
    assert.ok(!left.includes(k), `${k} is gone`);
  }
  assert.equal(settings.get('best_trade_min_premium'), '7', 'the card\'s floor is kept');
  assert.equal(settings.get('scheduler_enabled'), '1', 'the master switch is untouched');
  assert.equal(settings.get('signal_max_open'), '28', 'the desk-wide limit is untouched');
  assert.equal(settings.get('mode'), 'paper');
});
