import { after, test } from 'node:test';
import { closePool } from '../../src/db/pool.js';
import assert from 'node:assert/strict';
import type { Leg, Snapshot } from '../../src/market/chain.js';
import type { Alert } from '../../src/notify/telegram.js';
import { bestTradeText } from '../../src/notify/best-trade-alert.js';
import { bestTradeNow } from '../../src/domain/best-trade-now.js';

after(() => closePool());

/**
 * "Tell me when the best pick changes."
 *
 * The phone should hear once when a strike becomes the pick, not once a
 * minute while it stays the pick. A message that repeats the last one is a
 * message that teaches you to ignore the next -- so the tests here are about
 * silence as much as about sending.
 */

const SPOT = 77_000;
const NOW = Date.UTC(2026, 8, 16, 6, 0, 0); // 11:30 IST

const leg = (cp: 'C' | 'P', strike: number, bid: number, expireWorthless = 0.97): Leg => ({
  cp, strike, off: Math.round((strike - SPOT) / 200), moneyness: 'OTM',
  ltp: bid, mark: bid + 0.3, bid, ask: bid + 0.6, sellPrice: bid,
  iv: 0.45, delta: cp === 'C' ? 0.05 : -0.05, gamma: 0, theta: 0, vega: 0,
  oi: 500, volume: 200, ageMin: 3,
  probs: { expireWorthless, touch: 0.06, nearZero: 0.5 },
  emBuffer: Math.abs(strike - SPOT) / 1_400, distancePct: ((strike - SPOT) / SPOT) * 100,
  intrinsic: 0, extrinsic: bid + 0.3, gammaExposure: null,
});

const board = (legs: Leg[]): Snapshot => ({
  ts: Math.floor(NOW / 1000), live: true, expiry: '160926', expiryTs: Math.floor(NOW / 1000) + 6 * 3600,
  isDaily: true, isNextEntry: false, nextEntryTs: Math.floor(NOW / 1000) + 18 * 3600,
  step: 200, tte: 6 / (24 * 365), hoursToExpiry: 6, spot: SPOT, atm: 77_000, atmIv: 0.45,
  expectedMove: 1_400, expectedMoveAtEntry: 1_400,
  coverage: { requested: 1000, above: 3, below: 3, complete: true } as Snapshot['coverage'],
  legs,
});

/** A call paying well and a put paying little: the call is the only pick above the floor. */
const CALL_BOARD = board([
  leg('C', 79_600, 18), leg('C', 80_000, 12), leg('C', 80_400, 8),
  leg('P', 74_400, 3), leg('P', 74_000, 2), leg('P', 73_600, 1.5),
]);
/** The same board an hour later with the put side now the one paying. */
const PUT_BOARD = board([
  leg('C', 79_600, 3), leg('C', 80_000, 2), leg('C', 80_400, 1.5),
  leg('P', 74_400, 18), leg('P', 74_000, 12), leg('P', 73_600, 8),
]);

const pickOf = (snap: Snapshot) =>
  bestTradeNow({ snap, market: null, lots: 10, hedgeGap: 3, minPremiumUsd: 5 }).pick!;
const named = (snap: Snapshot) => {
  const p = pickOf(snap);
  return new RegExp(`Sell ${p.side} ${p.strike.toLocaleString('en-IN')}`);
};

/** A desk on this process's database, the way index.ts builds one. */
async function freshService() {
  const { TradingService } = await import('../../src/trading/service.js');
  const { PgTradeStore } = await import('../../src/trading/store.js');
  const { SettingsCache } = await import('../../src/db/settings.js');
  return new TradingService({ settings: await new SettingsCache().load(), store: await PgTradeStore.open() });
}

async function desk() {
  const svc = await freshService();
  const sent: Alert[] = [];
  // The notifier is built from the environment; the test wants a stub.
  (svc as unknown as { notifier: { notify(a: Alert): void } }).notifier = { notify: (a) => { sent.push(a); } };
  await svc.setAlertsOn(true);
  await svc.setBestTradeAlertOn(false);
  await svc.setBestTradeMinPremiumUsd(5);
  // Settings live in the journal and outlast one service; start every test at the default.
  await svc.setBestTradeRepeat(1);
  return { svc, sent };
}

test('the fixture boards each name a pick above the floor, on opposite sides', () => {
  const call = bestTradeNow({ snap: CALL_BOARD, market: null, lots: 10, hedgeGap: 3, minPremiumUsd: 5 });
  const put = bestTradeNow({ snap: PUT_BOARD, market: null, lots: 10, hedgeGap: 3, minPremiumUsd: 5 });
  assert.equal(call.pick?.side, 'CE');
  assert.equal(put.pick?.side, 'PE');
  assert.equal(call.bestOfNone, false);
});

test('[critical] switched off, the watcher does nothing and says so', async () => {
  const { svc, sent } = await desk();
  assert.equal(await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null }), 'off');
  assert.equal(sent.length, 0);
  svc.stop();
});

test('[critical] the first look announces the pick; the same pick again is silence', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  assert.equal(await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null }), 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'best-trade');
  assert.match(sent[0].text, /New best pick/);
  assert.match(sent[0].text, named(CALL_BOARD));
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: CALL_BOARD, market: null }), 'unchanged');
  assert.equal(await svc.watchBestTrade(NOW + 120_000, { snap: CALL_BOARD, market: null }), 'unchanged');
  assert.equal(sent.length, 1, 'one message for one pick, however many minutes it stays the pick');
  svc.stop();
});

test('[critical] a different strike is announced', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null });
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: PUT_BOARD, market: null }), 'sent');
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, named(PUT_BOARD));
  svc.stop();
});

test('[critical] a pick that goes away is not announced, and its return counts against the cap', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null });
  const nothing = board(CALL_BOARD.legs.map((l) => ({ ...l, bid: 2, sellPrice: 2, ask: 2.6, mark: 2.3 })));
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: nothing, market: null }), 'unchanged');
  assert.equal(sent.length, 1, 'nothing worth selling is not news worth a message');
  assert.equal(await svc.watchBestTrade(NOW + 120_000, { snap: CALL_BOARD, market: null }), 'repeat',
    'at the default of once, the same strike coming back on the same contract is not sent again');
  assert.equal(sent.length, 1);
  svc.stop();
});

/*
 * The repeat cap, asked for on 17 September: the same strike is announced at
 * most N times per contract -- from 5:31 PM to 5:30 PM the next day -- and N is
 * one unless somebody changes it.
 */

test('[critical] the same strike coming back is not sent again for the same contract', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  assert.equal(svc.bestTradeRepeat, 1, 'once per strike per contract, by default');
  assert.equal(await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null }), 'sent');
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: PUT_BOARD, market: null }), 'sent');
  assert.equal(await svc.watchBestTrade(NOW + 120_000, { snap: CALL_BOARD, market: null }), 'repeat');
  assert.equal(sent.length, 2, 'call, put -- and not the call a second time');
  assert.equal(await svc.watchBestTrade(NOW + 180_000, { snap: CALL_BOARD, market: null }), 'unchanged',
    'and quiet while it stays the pick');
  svc.stop();
});

test('[critical] the cap is a setting: at 2 a strike can come back once more, and no more', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  await svc.setBestTradeRepeat(2);
  for (const [i, snap, want] of [
    [0, CALL_BOARD, 'sent'], [1, PUT_BOARD, 'sent'], [2, CALL_BOARD, 'sent'], [3, PUT_BOARD, 'sent'], [4, CALL_BOARD, 'repeat'],
  ] as const) {
    assert.equal(await svc.watchBestTrade(NOW + i * 60_000, { snap, market: null }), want, `look ${i}`);
  }
  assert.equal(sent.length, 4);
  assert.match(sent[0].text, /Alert 1 of 2 for this strike/);
  assert.match(sent[2].text, /Alert 2 of 2 for this strike/);
  svc.stop();
});

test('[critical] a new contract starts the count again -- the 5:31 PM reset', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null });
  await svc.watchBestTrade(NOW + 60_000, { snap: PUT_BOARD, market: null });
  assert.equal(await svc.watchBestTrade(NOW + 120_000, { snap: CALL_BOARD, market: null }), 'repeat');
  // the next day's contract, listed at 5:30 PM: the same strike is news on it
  const tomorrow = { ...CALL_BOARD, expiry: '170926' };
  assert.equal(await svc.watchBestTrade(NOW + 180_000, { snap: tomorrow, market: null }), 'sent');
  assert.equal(sent.length, 3);
  svc.stop();
});

test('the repeat setting is kept between 1 and 10', async () => {
  const { svc } = await desk();
  assert.equal(svc.bestTradeRepeat, 1);
  await svc.setBestTradeRepeat(0);
  assert.equal(svc.bestTradeRepeat, 1);
  await svc.setBestTradeRepeat(25);
  assert.equal(svc.bestTradeRepeat, 10);
  await svc.setBestTradeRepeat(3);
  assert.equal(svc.bestTradeRepeat, 3);
  await svc.setBestTradeRepeat(1);
  svc.stop();
});

test('[critical] the floor decides: a strike paying under it is never the pick that gets sent', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  await svc.setBestTradeMinPremiumUsd(20);
  assert.equal(await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null }), 'unchanged');
  assert.equal(sent.length, 0);
  await svc.setBestTradeMinPremiumUsd(5);
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: CALL_BOARD, market: null }), 'sent');
  assert.match(sent[0].text, /Only strikes paying \$5 or more/);
  svc.stop();
});

test('[critical] phone alerts off silences the message but the pick is still remembered', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  await svc.setAlertsOn(false);
  assert.equal(await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null }), 'sent');
  assert.equal(sent.length, 0);
  // turning the phone back on does not replay a pick the desk already noted
  await svc.setAlertsOn(true);
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: CALL_BOARD, market: null }), 'unchanged');
  svc.stop();
});

test('switching the reminder on again announces the current pick rather than waiting for a change', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null });
  await svc.setBestTradeAlertOn(false);
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: CALL_BOARD, market: null }), 'off');
  await svc.setBestTradeAlertOn(true);
  assert.equal(await svc.watchBestTrade(NOW + 120_000, { snap: CALL_BOARD, market: null }), 'sent');
  assert.equal(sent.length, 2);
  svc.stop();
});

test('a board that is not live is left alone', async () => {
  const { svc, sent } = await desk();
  await svc.setBestTradeAlertOn(true);
  assert.equal(await svc.watchBestTrade(NOW, { snap: { ...CALL_BOARD, live: false }, market: null }), 'no board');
  assert.equal(sent.length, 0);
  svc.stop();
});

test('the settings survive as the desk remembers them', async () => {
  const { svc } = await desk();
  await svc.setBestTradeMinPremiumUsd(7.5);
  assert.equal(svc.bestTradeMinPremiumUsd, 7.5);
  await svc.setBestTradeAlertOn(true);
  assert.equal(svc.bestTradeAlertOn, true);
  svc.stop();
});

test('[critical] the message is plain English, one fact per line', () => {
  const best = bestTradeNow({ snap: CALL_BOARD, market: null, lots: 10, hedgeGap: 3, minPremiumUsd: 5 });
  const text = bestTradeText(best, '160926', 'paper', NOW, { n: 1, of: 1 });
  assert.match(text, /New best pick<\/b> · PAPER · 11:30 AM IST/);
  assert.match(text, new RegExp(`${named(CALL_BOARD).source}</b> · expires 16 Sep, 5:30 PM`));
  assert.match(text, new RegExp(`You get: <b>${pickOf(CALL_BOARD).premiumUsd.toFixed(2)}</b>`));
  assert.match(text, /Chance it expires worthless: \d+\.\d%/);
  assert.match(text, /Chance the price reaches it first: \d+%/);
  assert.match(text, /Max loss:/);
  assert.match(text, /Score: \d+\/100/);
  assert.match(text, /Only strikes paying \$5 or more\. Nothing was placed\./);
  assert.match(text, /Alert 1 of 1 for this strike before it expires/);
  // one fact to a line: none of the old run-together card wording
  assert.doesNotMatch(text, /rank \d+\/100|Chance you keep it all|gets there first|BEST PICK CHANGED/);
});

test('an expiry code reads as a date', async () => {
  const { expiryLabel } = await import('../../src/notify/best-trade-alert.js');
  assert.equal(expiryLabel('160926'), '16 Sep');
  assert.equal(expiryLabel('010126'), '1 Jan');
  assert.equal(expiryLabel('not-a-code'), 'not-a-code');
});

/*
 * Selling that pick by itself.
 *
 * Through the real service and the real journal, with the exchange left out:
 * what is pinned here is the writing-down, which is what stops a restart or a
 * second tick selling the same strike twice. The rules themselves are in
 * `auto-trade.test.ts`, where they need no desk at all.
 */
async function armedDesk(over: Partial<Parameters<TradingServiceType['setAutoTrade']>[0]> = {}) {
  const d = await desk();
  await d.svc.setAutoTrade({ on: true, lots: 5, targetPct: 95, ...over });
  // The ledger lives in the journal and outlasts one service: start clean.
  await d.svc.clearAutoTradeLedger();
  // Every order is answered here; the engine and the exchange have their own tests.
  const placed: { symbol: string; lots: number; takeProfitPct?: number; origin?: string }[] = [];
  (d.svc as unknown as { place: (i: Record<string, unknown>) => Promise<unknown> }).place = async (i) => {
    placed.push(i as never);
    return { ok: true, state: { tradeId: `t-${placed.length}` } };
  };
  return { ...d, placed };
}
type TradingServiceType = Awaited<ReturnType<typeof desk>>['svc'];

test('[critical] armed, it sells the pick once — the second look sells nothing', async () => {
  const { svc, placed } = await armedDesk();
  const first = await svc.autoTradeBestPick(NOW, { snap: CALL_BOARD, market: null });
  assert.equal(first.act, 'placed');
  assert.equal(placed.length, 1);
  assert.deepEqual(
    { symbol: placed[0]!.symbol, lots: placed[0]!.lots, target: placed[0]!.takeProfitPct, origin: placed[0]!.origin },
    { symbol: `C-BTC-${pickOf(CALL_BOARD).strike}-160926`, lots: 5, target: 0.95, origin: 'best-pick' },
  );
  const again = await svc.autoTradeBestPick(NOW + 60_000, { snap: CALL_BOARD, market: null });
  assert.equal(again.act, 'skip');
  assert.equal(placed.length, 1, 'one automatic trade for one strike on one contract');
  svc.stop();
});

test('[critical] switched off it places nothing, however good the pick looks', async () => {
  const { svc, placed } = await armedDesk();
  await svc.setAutoTrade({ on: false });
  assert.deepEqual(await svc.autoTradeBestPick(NOW, { snap: CALL_BOARD, market: null }), { act: 'skip', why: 'off' });
  assert.equal(placed.length, 0);
  svc.stop();
});

test('[critical] the cap holds across a different pick on the same contract', async () => {
  const { svc, placed } = await armedDesk();
  await svc.autoTradeBestPick(NOW, { snap: CALL_BOARD, market: null });
  const second = await svc.autoTradeBestPick(NOW + 60_000, { snap: PUT_BOARD, market: null });
  assert.equal(second.act, 'skip');
  assert.match(second.why, /already on this contract/);
  assert.equal(placed.length, 1);
  svc.stop();
});

test('[critical] a refusal is written down, said once, and not retried this contract', async () => {
  const { svc, sent, placed } = await armedDesk();
  (svc as unknown as { place: () => Promise<unknown> }).place = async () => {
    placed.push({ symbol: 'x', lots: 0 });
    return { ok: false, precheck: { ok: false, failures: [{ code: 'margin', message: 'not enough margin' }] }, state: null };
  };
  const r = await svc.autoTradeBestPick(NOW, { snap: CALL_BOARD, market: null });
  assert.equal(r.act, 'refused');
  assert.match(r.why, /not enough margin/);
  // Keyed per decision since 23 Sep: two strikes refused a minute apart are
  // two messages, not the second replacing the first before it is sent.
  assert.equal(sent.filter((a) => a.key.startsWith('auto-trade:')).length, 1);
  const again = await svc.autoTradeBestPick(NOW + 60_000, { snap: CALL_BOARD, market: null });
  assert.equal(again.act, 'skip');
  assert.equal(placed.length, 1, 'Delta is not asked the same refused question every minute');
  svc.stop();
});

test('the settings survive the service, and are brought inside their limits', async () => {
  const { svc } = await armedDesk();
  assert.deepEqual(await svc.setAutoTrade({ lots: 99_999, targetPct: 140 }), {
    on: true, lots: 1_000, targetPct: 99, stopPct: 0, chaseSeconds: 5, maxPerContract: 1,
  });
  assert.equal((await freshService()).autoTrade.lots, 1_000, 'read back from the journal');
  await svc.setAutoTrade({ on: false, lots: 5, targetPct: 95 });
  svc.stop();
});

