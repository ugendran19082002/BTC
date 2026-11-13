import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE_HOLD_MS } from '../../src/trading/engine.js';
import { failureCodes } from '../../src/trading/precheck.js';
import { liveWhy } from '../../src/report/signal-backtest.js';
import { ceProduct, planFor, quote, rig } from './harness.js';

/*
 * A balance Delta would not say (13 Nov 2026). On 12 Nov at 13:45 the rate limit refused the balance read and the gate
 * took it as $0: four accounts with full wallets were refused "Needs $0.37, have $0.00". The last balance read stands
 * in for a refused one up to five minutes; with none at all, the gate says so -- which is not "not enough margin".
 */

const CE = ceProduct().symbol;
const plan = () => planFor(ceProduct(), { lots: 1, stopPrice: 60, takeProfitPrice: 2, entry: { type: 'limit', limitPrice: 20, timeoutMs: 0, marketFallback: false, chase: null } });

test('[critical] a refused balance read falls back on the last one answered: the entry is not refused for margin', async () => {
  const r = rig({ quotes: [quote(CE, 19, 20)], balanceUsd: 500 });
  const first = await r.engine.previewOpen(plan());
  assert.equal(first.ok, true, JSON.stringify(first));
  const real = r.ex.getBalanceUsd.bind(r.ex);
  r.ex.getBalanceUsd = async () => { throw new Error('Delta rate limit reached.'); };
  r.advance(60_000);
  r.ex.tick(quote(CE, 19, 20, { ts: r.now() }));
  const again = await r.engine.previewOpen(plan());
  assert.equal(again.ok, true, `the balance read a minute ago stands: ${JSON.stringify(again.failures)}`);
  assert.ok(!failureCodes(again).includes('INSUFFICIENT_MARGIN'));
  r.ex.getBalanceUsd = real;
});

test('[critical] no balance at all -- none read yet, or the last one too old: refused as unread, never as "have $0.00"', async () => {
  const r = rig({ quotes: [quote(CE, 19, 20)], balanceUsd: 500 });
  r.ex.getBalanceUsd = async () => { throw new Error('Delta rate limit reached.'); };
  const none = await r.engine.previewOpen(plan());
  assert.equal(none.ok, false);
  assert.deepEqual(failureCodes(none), ['BALANCE_UNREAD']);
  assert.match(none.failures[0]!.message, /Delta did not say the balance/);
  assert.doesNotMatch(none.failures[0]!.message, /have \$0\.00/);
});

test('[critical] the last balance is held five minutes, not for ever', async () => {
  const r = rig({ quotes: [quote(CE, 19, 20)], balanceUsd: 500 });
  assert.equal((await r.engine.previewOpen(plan())).ok, true);
  r.ex.getBalanceUsd = async () => { throw new Error('Delta rate limit reached.'); };
  r.advance(BALANCE_HOLD_MS);
  r.ex.tick(quote(CE, 19, 20, { ts: r.now() }));
  assert.equal((await r.engine.previewOpen(plan())).ok, true, 'at five minutes: still held');
  r.advance(1);
  r.ex.tick(quote(CE, 19, 20, { ts: r.now() }));
  assert.deepEqual(failureCodes(await r.engine.previewOpen(plan())), ['BALANCE_UNREAD'], 'past it: unknown again');
});

test('[critical] the strategy screen names the premium floor as the floor, and an unread balance as unread -- not "not enough margin"', () => {
  assert.equal(liveWhy('This one pays 6.00 and the desk will not sell below 10.00 — the same margin is at risk either way, so a cheaper option is the same risk for less pay.'), 'the premium floor');
  assert.equal(liveWhy('Delta did not say the balance just now (needs $0.37 at 200x): asked again at the next signal.'), 'the balance could not be read');
  assert.equal(liveWhy('Needs $0.37 at 200x, have $0.10.'), 'not enough margin');
});
