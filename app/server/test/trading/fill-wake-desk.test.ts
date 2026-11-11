import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../../src/db/pool.js';
import { clientId } from '../../src/trading/engine.js';

/**
 * The fill wake on a desk (trading/service.ts, 11 Nov 2026): what the private socket heard is taken only by a desk
 * that is running and live, and a trade protected or closed outside the loop has the stop watch read the open trades
 * again -- soon, at most every few seconds, never two reads at once.
 */

after(() => closePool());

const SYMBOL = 'P-BTC-77000-111126';
const TRADE = `${SYMBOL}-1794360635718`;

async function desk() {
  const { TradingService } = await import('../../src/trading/service.js');
  const { MemoryTradeStore } = await import('../../src/trading/engine.js');
  const { SettingsCache } = await import('../../src/db/settings.js');
  const svc = new TradingService({ settings: await new SettingsCache().load(), store: new MemoryTradeStore() as never, notifier: null });
  const inside = svc as unknown as {
    currentMode: 'paper' | 'live';
    wakeTimer: NodeJS.Timeout | null;
    store: { open: () => Promise<unknown[]> };
    watchesStale: () => void;
    rereadWatches: (now?: number) => Promise<void>;
  };
  return { svc, inside };
}

const heardFill = () => ({ kind: 'fill' as const, symbol: SYMBOL, orderId: '1670626067', clientOrderId: clientId(TRADE, 'entry'), heardAt: Date.now() });

test('[critical] what the socket heard is taken only by a desk running live: never on paper, never before it starts', async () => {
  const { svc, inside } = await desk();
  inside.currentMode = 'live';
  assert.equal(svc.hearOrder(heardFill()), false, 'not started: no wake timer, nothing taken');
  inside.wakeTimer = setInterval(() => {}, 60_000);
  try {
    inside.currentMode = 'paper';
    assert.equal(svc.hearOrder(heardFill()), false, 'on paper the venue is the simulator: Delta\'s orders are none of its trades');
    assert.equal(svc.fillWake.size, 0);
    inside.currentMode = 'live';
    assert.equal(svc.hearOrder(heardFill()), true);
    assert.equal(svc.fillWake.size, 1);
    assert.equal(svc.hearOrder({ ...heardFill(), clientOrderId: null }), false, 'an order from outside the desk');
  } finally {
    clearInterval(inside.wakeTimer!);
    inside.wakeTimer = null;
  }
});

test('[critical] a trade protected outside the loop: the stop watch reads the open trades again -- once owed, at most every 3 s', async () => {
  const { WATCH_REREAD_MS } = await import('../../src/trading/service.js');
  const { svc, inside } = await desk();
  const open = [{
    plan: { symbol: SYMBOL, stopPrice: 236, leverage: 200, underlying: { entry: 73_759 } },
    state: { tradeId: TRADE, position: -1, phase: 'protected', entryAvgPrice: 70, perpEntry: 73_759 },
  }];
  let reads = 0;
  inside.store = { open: async () => { reads++; return open; } };
  const t = 1_794_360_700_000;
  await inside.rereadWatches(t);
  assert.equal(reads, 0, 'nothing owed: no read');
  assert.equal(svc.stopWatch.size, 0);

  inside.watchesStale();
  await inside.rereadWatches(t);
  assert.equal(reads, 1);
  assert.equal(svc.stopWatch.size, 1, 'its stop judged by the watch from now, not from the next pass');

  inside.watchesStale();
  await inside.rereadWatches(t + WATCH_REREAD_MS - 1);
  assert.equal(reads, 1, 'not again inside 3 s');
  await inside.rereadWatches(t + WATCH_REREAD_MS);
  assert.equal(reads, 2, 'and then, since it was owed');
  await inside.rereadWatches(t + 2 * WATCH_REREAD_MS);
  assert.equal(reads, 2, 'nothing owed since');
});

test('a read that fails is owed again; two at once are one', async () => {
  const { inside } = await desk();
  let reads = 0;
  let fail = true;
  let release!: () => void;
  inside.store = {
    open: async () => {
      reads++;
      if (fail) throw new Error('database down');
      await new Promise<void>((r) => { release = r; });
      return [];
    },
  };
  inside.watchesStale();
  await inside.rereadWatches(1_000_000);
  assert.equal(reads, 1);
  fail = false;
  const first = inside.rereadWatches(1_000_000 + 10_000);
  inside.watchesStale();
  await inside.rereadWatches(1_000_000 + 20_000);
  assert.equal(reads, 2, 'a read still running: the next waits for it');
  release();
  await first;
});
