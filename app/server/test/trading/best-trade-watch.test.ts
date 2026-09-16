import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Leg, Snapshot } from '../../src/market/chain.js';
import type { Alert } from '../../src/notify/telegram.js';
import { bestTradeText } from '../../src/notify/best-trade-alert.js';
import { bestTradeNow } from '../../src/domain/best-trade-now.js';

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
  return new RegExp(`SELL ${p.side} ${p.strike.toLocaleString('en-IN')}`);
};

async function desk() {
  const { TradingService } = await import('../../src/trading/service.js');
  const svc = new TradingService();
  const sent: Alert[] = [];
  // The notifier is built from the environment; the test wants a stub.
  (svc as unknown as { notifier: { notify(a: Alert): void } }).notifier = { notify: (a) => { sent.push(a); } };
  svc.setAlertsOn(true);
  svc.setBestTradeAlertOn(false);
  svc.setBestTradeMinPremiumUsd(5);
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
  svc.setBestTradeAlertOn(true);
  assert.equal(await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null }), 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].key, 'best-trade');
  assert.match(sent[0].text, /BEST PICK CHANGED/);
  assert.match(sent[0].text, named(CALL_BOARD));
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: CALL_BOARD, market: null }), 'unchanged');
  assert.equal(await svc.watchBestTrade(NOW + 120_000, { snap: CALL_BOARD, market: null }), 'unchanged');
  assert.equal(sent.length, 1, 'one message for one pick, however many minutes it stays the pick');
  svc.stop();
});

test('[critical] a different strike is announced', async () => {
  const { svc, sent } = await desk();
  svc.setBestTradeAlertOn(true);
  await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null });
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: PUT_BOARD, market: null }), 'sent');
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, named(PUT_BOARD));
  svc.stop();
});

test('[critical] a pick that goes away is not announced, and its return is', async () => {
  const { svc, sent } = await desk();
  svc.setBestTradeAlertOn(true);
  await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null });
  const nothing = board(CALL_BOARD.legs.map((l) => ({ ...l, bid: 2, sellPrice: 2, ask: 2.6, mark: 2.3 })));
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: nothing, market: null }), 'unchanged');
  assert.equal(sent.length, 1, 'nothing worth selling is not news worth a message');
  assert.equal(await svc.watchBestTrade(NOW + 120_000, { snap: CALL_BOARD, market: null }), 'sent',
    'the same strike coming back after a gap is news again');
  svc.stop();
});

test('[critical] the floor decides: a strike paying under it is never the pick that gets sent', async () => {
  const { svc, sent } = await desk();
  svc.setBestTradeAlertOn(true);
  svc.setBestTradeMinPremiumUsd(20);
  assert.equal(await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null }), 'unchanged');
  assert.equal(sent.length, 0);
  svc.setBestTradeMinPremiumUsd(5);
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: CALL_BOARD, market: null }), 'sent');
  assert.match(sent[0].text, /Only strikes paying \$5\+/);
  svc.stop();
});

test('[critical] phone alerts off silences the message but the pick is still remembered', async () => {
  const { svc, sent } = await desk();
  svc.setBestTradeAlertOn(true);
  svc.setAlertsOn(false);
  assert.equal(await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null }), 'sent');
  assert.equal(sent.length, 0);
  // turning the phone back on does not replay a pick the desk already noted
  svc.setAlertsOn(true);
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: CALL_BOARD, market: null }), 'unchanged');
  svc.stop();
});

test('switching the reminder on again announces the current pick rather than waiting for a change', async () => {
  const { svc, sent } = await desk();
  svc.setBestTradeAlertOn(true);
  await svc.watchBestTrade(NOW, { snap: CALL_BOARD, market: null });
  svc.setBestTradeAlertOn(false);
  assert.equal(await svc.watchBestTrade(NOW + 60_000, { snap: CALL_BOARD, market: null }), 'off');
  svc.setBestTradeAlertOn(true);
  assert.equal(await svc.watchBestTrade(NOW + 120_000, { snap: CALL_BOARD, market: null }), 'sent');
  assert.equal(sent.length, 2);
  svc.stop();
});

test('a board that is not live is left alone', async () => {
  const { svc, sent } = await desk();
  svc.setBestTradeAlertOn(true);
  assert.equal(await svc.watchBestTrade(NOW, { snap: { ...CALL_BOARD, live: false }, market: null }), 'no board');
  assert.equal(sent.length, 0);
  svc.stop();
});

test('the settings survive as the desk remembers them', async () => {
  const { svc } = await desk();
  svc.setBestTradeMinPremiumUsd(7.5);
  assert.equal(svc.bestTradeMinPremiumUsd, 7.5);
  svc.setBestTradeAlertOn(true);
  assert.equal(svc.bestTradeAlertOn, true);
  svc.stop();
});

test('the message carries the whole card, in the card’s words', () => {
  const best = bestTradeNow({ snap: CALL_BOARD, market: null, lots: 10, hedgeGap: 3, minPremiumUsd: 5 });
  const text = bestTradeText(best, '160926', 'paper', NOW);
  assert.match(text, /PAPER/);
  assert.match(text, /11:30 IST/);
  assert.match(text, new RegExp(`${named(CALL_BOARD).source}<\\/b> · 160926`));
  assert.match(text, new RegExp(`You'd be paid <b>${pickOf(CALL_BOARD).premiumUsd.toFixed(2)}<\\/b> · rank \\d+/100`));
  assert.match(text, /Chance you keep it all: \d+\.\d% · price gets there first: \d+%/);
  assert.match(text, /Most you can lose/);
  assert.match(text, /Nothing has been placed/);
});
