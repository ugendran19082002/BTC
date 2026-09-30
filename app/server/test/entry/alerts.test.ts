import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { alertSettings, entryAlertFor, recentAlerts, sendEntryAlert, setAlert, wanted } from '../../src/entry/alerts.js';
import { recordSetups } from '../../src/entry/paper.js';
import type { MethodRead } from '../../src/entry/types.js';
import { closePool, rows } from '../../src/db/pool.js';

after(closePool);

const T = 1_790_035_200;
const trade = (over: Partial<MethodRead> = {}): MethodRead => ({
  id: 'liquidity-sweep', n: 3, name: 'Liquidity sweep', group: 'reversal', summary: '', mode: 'mtf', tf: '5m', dir: 'long', state: 'TRADE',
  steps: [], gates: [], score: 72, scoreParts: [], alignment: 100, reason: '', triggerTime: T,
  plan: { entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: 84_500, tp3: null, tpWhy: [], rr: 1.9 },
  ...over,
});

test('[critical] alerts are off until switched on, each way on its own, and every change is logged', async () => {
  assert.deepEqual((await alertSettings()).map((a) => [a.mode, a.enabled]), [['single', false], ['mtf', false]]);
  await setAlert('mtf', true, 5_000);
  const now = await alertSettings();
  assert.deepEqual(now.map((a) => [a.mode, a.enabled, a.changedAt]), [['single', false, null], ['mtf', true, 5_000]]);
  const log = await rows<{ mode: string; enabled: boolean }>('SELECT mode, enabled FROM entry_alert_changes ORDER BY id');
  assert.deepEqual(log.map((r) => [r.mode, r.enabled]), [['mtf', true]]);
});

test('[critical] the message: side, method, way, entry, SL with its points, targets, R:R, and that nothing was ordered', () => {
  const a = entryAlertFor(trade())!;
  assert.match(a.text, /^🟢 <b>BUY<\/b> · <b>#3 Liquidity sweep<\/b>/);
  assert.match(a.text, /with timeframe \(5m entry\)/);
  assert.match(a.text, /Entry 84,120–84,160/);
  assert.match(a.text, /SL 83,980 \(160 pts\)/);
  assert.match(a.text, /TP1 84,300 · TP2 84,500/);
  assert.match(a.text, /R:R 1\.90 after fees · quality 72\/100/);
  assert.match(a.text, /no order placed/);
  assert.equal(a.key, `entry:mtf:liquidity-sweep:long:${T}`, 'one key per setup');
  assert.match(entryAlertFor(trade({ dir: 'short', mode: 'single' }))!.text, /^🔴 <b>SELL<\/b>[\s\S]*without timeframe \(5m\)/);
});

test('[critical] a gate switched off is said in the alert; a WAIT or a TRADE with no levels is never an alert', () => {
  const off = entryAlertFor(trade({ gates: [{ key: 'rr', label: 'R:R after fees', rule: '', value: '1.2', ok: false, why: null, enabled: false }] }))!;
  assert.match(off.text, /⚠️ gates off: R:R after fees/);
  assert.equal(entryAlertFor(trade({ state: 'WAIT' })), null);
  assert.equal(entryAlertFor(trade({ plan: null })), null);
});

test('[critical] a setup is heard once, when the paper log first writes it -- not every minute it stays on the board', async () => {
  const heard: string[] = [];
  await recordSetups([trade()], (T + 300) * 1000, (r) => heard.push(r.id));
  await recordSetups([trade()], (T + 360) * 1000, (r) => heard.push(r.id));
  assert.deepEqual(heard, ['liquidity-sweep']);
});

test('names are escaped for Telegram HTML', () => {
  assert.match(entryAlertFor(trade({ name: 'A & <B>' }))!.text, /#3 A &amp; &lt;B&gt;/);
});

// ------------------------------------------------------------ timeframes and the log

test('[critical] without the chain a way alerts on the timeframes chosen -- 5m until the owner picks others; the chain always on its 5m entry', async () => {
  const before = await alertSettings();
  assert.deepEqual(before.find((a) => a.mode === 'single')!.tfs, ['5m']);
  const after = await setAlert('single', true, 6_000, ['3m', '15m', 'nonsense']);
  assert.deepEqual(after.find((a) => a.mode === 'single')!.tfs, ['3m', '15m'], 'kept, the unknown one dropped');
  assert.deepEqual((await setAlert('single', true, 7_000)).find((a) => a.mode === 'single')!.tfs, ['3m', '15m'], 'switching keeps the pick');
  await assert.rejects(setAlert('single', true, 8_000, []), /at least one timeframe/);
  const settings = await alertSettings();
  assert.equal(wanted(trade({ mode: 'single', tf: '3m' }), settings), true);
  assert.equal(wanted(trade({ mode: 'single', tf: '5m' }), settings), false, 'not picked');
  assert.equal(wanted(trade({ mode: 'mtf', tf: '5m' }), settings), true);
  await setAlert('mtf', false, 9_000);
  assert.equal(wanted(trade({ mode: 'mtf', tf: '5m' }), await alertSettings()), false, 'switched off');
});

test('[critical] every alert is written down with what became of it: sent, failed and why, or Telegram not set up', async () => {
  const sent: string[] = [];
  await sendEntryAlert(trade({ triggerTime: T + 1 }), { send: async (t) => { sent.push(t); return true; } });
  await sendEntryAlert(trade({ triggerTime: T + 2 }), { send: async () => false });
  await sendEntryAlert(trade({ triggerTime: T + 3 }), { send: async () => { throw new Error('socket hang up'); } });
  await sendEntryAlert(trade({ triggerTime: T + 4 }), null);
  await sendEntryAlert(trade({ state: 'WAIT', triggerTime: T + 5 }), { send: async () => true });
  assert.equal(sent.length, 1);
  const log = await recentAlerts(10);
  assert.deepEqual(log.map((a) => a.status), ['failed', 'failed', 'failed', 'sent'], 'newest first; a WAIT is never an alert');
  assert.match(log[0]!.error ?? '', /not set up/);
  assert.match(log[1]!.error ?? '', /socket hang up/);
  assert.match(log[2]!.error ?? '', /did not accept/);
  assert.equal(log[3]!.error, null);
});
