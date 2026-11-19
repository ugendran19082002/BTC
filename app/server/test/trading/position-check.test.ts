import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  netByContract, POSITION_CHECK_QUOTA_PCT, POSITION_CONFIRM_MS, POSITION_RETELL_MS, PositionCheck, readOffs, type CheckedDesk,
} from '../../src/trading/position-check.js';
import type { TradeRecord } from '../../src/trading/engine.js';
import type { ExchangePosition } from '../../src/trading/types.js';
import type { Alert } from '../../src/notify/messages.js';

/** Each account's open positions against Delta's, contract by contract (19 Nov 2026): told only of a lasting difference. */

const trade = (symbol: string, position: number) => ({ state: { symbol, position }, plan: {}, events: [] }) as unknown as TradeRecord;
const pos = (symbol: string, size: number) => ({ symbol, size, productId: 1, entryPrice: null, unrealisedPnl: null, markPrice: null, liquidationPrice: null }) as ExchangePosition;

function desk(o: { trades: TradeRecord[][] | TradeRecord[]; delta: ExchangePosition[] | (() => ExchangePosition[]); live?: boolean; quota?: number; name?: string }) {
  let reads = 0;
  const calls = { positions: 0 };
  const d: CheckedDesk = {
    accountId: 1, name: o.name ?? 'High', live: o.live ?? true,
    // A list of lists: each read of the journal the next one (to make a trade move during the read).
    open: async () => (Array.isArray(o.trades[0]) ? (o.trades as TradeRecord[][])[Math.min(reads++, o.trades.length - 1)]! : (o.trades as TradeRecord[])),
    positions: async () => { calls.positions++; return typeof o.delta === 'function' ? o.delta() : o.delta; },
    quotaUsedPct: () => o.quota ?? 5,
  };
  return { d, calls };
}

test('the journal is added up per contract, shorts negative, closed trades nothing', () => {
  const m = netByContract([trade('C-BTC-64000-191126', -2), trade('C-BTC-64000-191126', -1), trade('P-BTC-61000-191126', -2), trade('C-BTC-64200-191126', 0)]);
  assert.deepEqual([...m], [['C-BTC-64000-191126', -3], ['P-BTC-61000-191126', -2]]);
});

test('[critical] desk and Delta the same: nothing off', async () => {
  const { d } = desk({ trades: [trade('C-BTC-64000-191126', -2), trade('C-BTC-64000-191126', -2)], delta: [pos('C-BTC-64000-191126', -4)] });
  assert.deepEqual(await readOffs(d), []);
});

test('[critical] a position Delta holds that the desk does not, and one the desk holds that Delta does not, are both off', async () => {
  const { d } = desk({ trades: [trade('C-BTC-64000-191126', -2)], delta: [pos('C-BTC-64000-191126', -3), pos('P-BTC-60000-191126', -1)] });
  assert.deepEqual(await readOffs(d), [
    { symbol: 'C-BTC-64000-191126', desk: -2, delta: -3 },
    { symbol: 'P-BTC-60000-191126', desk: 0, delta: -1 },
  ]);
});

test('a contract whose journal moved during the read is not judged', async () => {
  const { d } = desk({ trades: [[trade('C-BTC-64000-191126', -2)], [trade('C-BTC-64000-191126', -4)]], delta: [pos('C-BTC-64000-191126', -4)] });
  assert.deepEqual(await readOffs(d), []);
});

test('[critical] on paper, past half the quota, or with no answer from Delta: not read, nothing concluded', async () => {
  const paper = desk({ trades: [], delta: [pos('X', -1)], live: false });
  assert.equal(await readOffs(paper.d), null);
  assert.equal(paper.calls.positions, 0, 'nothing asked of Delta on paper');
  const busy = desk({ trades: [], delta: [pos('X', -1)], quota: POSITION_CHECK_QUOTA_PCT });
  assert.equal(await readOffs(busy.d), null);
  assert.equal(busy.calls.positions, 0, 'the login\'s quota is the trades\' first');
  const down = desk({ trades: [], delta: () => { throw new Error('No answer from Delta'); } });
  assert.equal(await readOffs(down.d), null);
});

function check(desks: CheckedDesk[], o: { inCharge?: () => boolean } = {}) {
  const sent: Alert[] = [];
  const slept: number[] = [];
  let now = Date.parse('2026-11-19T09:00:30+05:30');
  const c = new PositionCheck({
    desks: () => desks, inCharge: o.inCharge ?? (() => true), notify: (a) => sent.push(a),
    now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; },
  });
  return { c, sent, slept, later: (ms: number) => { now += ms; } };
}

test('[critical] a difference still there a minute later is told; one that went is not', async () => {
  let held = [pos('C-BTC-64000-191126', -3)];
  const { d } = desk({ trades: [trade('C-BTC-64000-191126', -2)], delta: () => held });
  const k = check([d]);
  await k.c.round();
  assert.deepEqual(k.slept, [POSITION_CONFIRM_MS]);
  assert.equal(k.sent.length, 1);
  assert.match(k.sent[0]!.text, /POSITIONS OFF · High/);
  assert.match(k.sent[0]!.text, /C-BTC-64000-191126: desk -2 · Delta -3/);

  // A fill not yet journaled at the first read, journaled by the second: a trade moving, not a difference.
  held = [pos('C-BTC-64000-191126', -2), pos('P-BTC-60000-191126', -1)];
  let second = false;
  const moving = desk({ trades: [trade('C-BTC-64000-191126', -2)], delta: () => (second ? [pos('C-BTC-64000-191126', -2)] : (second = true, held)) });
  const m = check([moving.d]);
  await m.c.round();
  assert.equal(m.sent.length, 0);
});

test('the same difference is not told again every quarter hour, only after two hours; its end is told once', async () => {
  let held = [pos('C-BTC-64000-191126', -3)];
  const { d } = desk({ trades: [trade('C-BTC-64000-191126', -2)], delta: () => held });
  const k = check([d]);
  await k.c.round();
  k.later(15 * 60_000);
  await k.c.round();
  assert.equal(k.sent.length, 1);
  k.later(POSITION_RETELL_MS);
  await k.c.round();
  assert.equal(k.sent.length, 2);
  held = [pos('C-BTC-64000-191126', -2)];
  await k.c.round();
  await k.c.round();
  assert.equal(k.sent.length, 3);
  assert.match(k.sent[2]!.text, /POSITIONS AGREE · High/);
});

test('[critical] a standby process does not check: nothing asked of Delta, nothing said', async () => {
  const { d, calls } = desk({ trades: [], delta: [pos('X', -1)] });
  const k = check([d], { inCharge: () => false });
  await k.c.round();
  assert.equal(calls.positions, 0);
  assert.deepEqual(k.sent, []);
});
