import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { alertSettings, entryAlertFor, recentAlerts, sampleAlertText, sendEntryAlert, setAlert, wanted } from '../../src/entry/alerts.js';
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

test('[critical] the message, in sections: signal, entry, stop loss, targets, then R:R and why -- every distance from the fill', () => {
  const r = trade({ steps: [{ tf: '4h', label: 'macro context: with it', ok: true }, { tf: '5m', label: 'swept a swing low', ok: true }, { tf: '5m', label: 'MSS', ok: true }] });
  const a = entryAlertFor(r, { ltp: 84_205, at: Date.UTC(2026, 8, 30, 14, 33) })!;
  const lines = a.text.split('\n');
  assert.equal(lines[0], '🟢 <b>BUY SIGNAL</b> · BTCUSD');
  assert.equal(lines[1], '<b>#3 Liquidity sweep</b> · with timeframe · 5m entry');
  assert.match(lines[2]!, /^🕒 30 Sept?,? 20:03 IST · LTP <code>84,205<\/code>$/, 'when, in IST, and the live price');
  // Section 1: the entry, and where it fills -- the top of the zone for a long.
  assert.ok(a.text.includes('📍 <b>ENTRY</b>\nZone   <code>84,120 – 84,160</code>\nFill   <code>84,160</code>  (the zone\'s top edge)'));
  // Section 2: the stop, from the fill: 180 pts, 0.21%, 1R.
  assert.ok(a.text.includes('🛑 <b>STOP LOSS</b>\nSL     <code>83,980</code>  −180 pts · −0.21% · −1R'));
  // Section 3: each target in points and R from the fill.
  assert.ok(a.text.includes('🎯 <b>TARGETS</b>\nTP1   <code>84,300</code>  +140 pts · 0.8R\nTP2   <code>84,500</code>  +340 pts · 1.9R'));
  assert.match(a.text, /📊 R:R <b>1\.90<\/b> · Quality 72\/100/);
  assert.match(a.text, /✅ Why: swept a swing low · MSS$/m, 'the method\'s own steps (with the chain, its 5m entry)');
  assert.match(a.text, /no order placed<\/i>$/);
  assert.equal(a.key, `entry:mtf:liquidity-sweep:long:${T}`, 'one key per setup');
});

test('a short: SELL, fills at the bottom of its zone, targets below', () => {
  const a = entryAlertFor(trade({ dir: 'short', mode: 'single', plan: { entryLo: 84_391, entryHi: 84_523, stop: 84_825, tp1: 84_288, tp2: 83_974, tp3: null, tpWhy: [], rr: 1.9 } }))!;
  assert.match(a.text, /^🔴 <b>SELL SIGNAL<\/b>/);
  assert.match(a.text, /without timeframe · 5m/);
  assert.match(a.text, /Fill   <code>84,391<\/code>  \(the zone's bottom edge\)/);
  assert.match(a.text, /SL     <code>84,825<\/code>  −434 pts/);
  assert.match(a.text, /TP1   <code>84,288<\/code>  \+103 pts · 0\.2R/);
});

test('[critical] a gate switched off is said in the alert; a WAIT or a TRADE with no levels is never an alert', () => {
  const off = entryAlertFor(trade({ gates: [{ key: 'rr', label: 'R:R', rule: '', value: '1.2', ok: false, why: null, enabled: false }] }))!;
  assert.match(off.text, /⚠️ <b>Only a TRADE because gates are off<\/b>: R:R 1\.2/);
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

test('the test button sends a made-up signal in the real format, marked TEST', () => {
  const t = sampleAlertText(Date.UTC(2026, 8, 30, 14, 33));
  assert.match(t, /^🔔 <b>TEST<\/b>/);
  assert.match(t, /📍 <b>ENTRY<\/b>[\s\S]*🛑 <b>STOP LOSS<\/b>[\s\S]*🎯 <b>TARGETS<\/b>/);
});

test('[critical] 1m never alerts: it is view-only without the chain, so it is no alert timeframe', async () => {
  const s = await setAlert('single', true, 9_000_000, ['1m', '30m']);
  assert.deepEqual(s.find((a) => a.mode === 'single')!.tfs, ['30m'], '1m dropped as unknown');
  await assert.rejects(setAlert('single', true, 9_000_001, ['1m']), /at least one timeframe/);
});


test('[critical] the alert says why the SL and each target are where they are', () => {
  const why = { stop: 'the sweep extreme 83,990 − 0.25 ATR', tp1: 'entry swing high 84,300', tp2: '4h swing high 84,500', tp3: null };
  const text = entryAlertFor(trade({ plan: { entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: 84_500, tp3: null, tpWhy: [], rr: 1.9, why } }))!.text;
  assert.match(text, /<i>the sweep extreme 83,990 − 0\.25 ATR<\/i>/);
  assert.match(text, /TP1 .*R · entry swing high 84,300/);
  assert.match(text, /TP2 .*R · 4h swing high 84,500/);
});
