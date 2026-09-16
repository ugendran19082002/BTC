import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertText, contractWords, judge } from '../../src/notify/premium-alerts.js';
import { SqliteTradeStore, type PremiumAlert } from '../../src/trading/store.js';

/**
 * "Tell me when this strike pays 5."
 *
 * A doorbell, not a siren: it rings once, on the bid, and never after the
 * contract has settled. The store is the guard against ringing twice, so it
 * is tested against a real database file rather than a fake.
 */

const alert = (over: Partial<PremiumAlert> = {}): PremiumAlert => ({
  id: 1, symbol: 'P-BTC-74000-160926', threshold: 5, expiryTs: 1_789_650_000,
  createdAt: 0, firedAt: null, firedBid: null, ...over,
});
const before = 1_789_600_000;

// ------------------------------------------------------------- the decision

test('[critical] fires when the bid reaches the threshold, and not a tick before', () => {
  assert.deepEqual(judge(alert(), { bid: 5, nowTs: before }), { fire: true, bid: 5 });
  assert.deepEqual(judge(alert(), { bid: 7.8, nowTs: before }), { fire: true, bid: 7.8 });
  assert.deepEqual(judge(alert(), { bid: 4.99, nowTs: before }), { fire: false, why: 'below' });
});

test('[critical] the bid, never the mark: a number nobody will pay is not a premium', () => {
  // The caller passes the bid; a null bid is "no bid", however high the mark.
  assert.deepEqual(judge(alert(), { bid: null, nowTs: before }), { fire: false, why: 'no bid' });
  assert.deepEqual(judge(alert(), { bid: 0, nowTs: before }), { fire: false, why: 'no bid' });
});

test('[critical] once: an alert that has fired never fires again, whatever the bid does', () => {
  assert.deepEqual(judge(alert({ firedAt: 1, firedBid: 6 }), { bid: 50, nowTs: before }), { fire: false, why: 'already fired' });
});

test('[critical] dead at expiry: a settled contract has no bid to reach', () => {
  assert.deepEqual(judge(alert(), { bid: 50, nowTs: 1_789_650_000 }), { fire: false, why: 'expired' });
  assert.deepEqual(judge(alert(), { bid: 50, nowTs: 1_789_650_000 - 1 }), { fire: true, bid: 50 });
});

test('the message names the contract, the bid and the level, and says it will not repeat', () => {
  const text = alertText(alert(), 7.8, 'live');
  assert.match(text, /PREMIUM ALERT/);
  assert.match(text, /74,000 PE · 160926/);
  assert.match(text, /Bid is <b>7\.80<\/b> — you asked to hear at 5\.00/);
  assert.match(text, /will not repeat/);
  assert.doesNotMatch(text, /PAPER/);
  assert.match(alertText(alert(), 7.8, 'paper'), /PAPER/);
});

test('a symbol is read into words the phone can use', () => {
  assert.equal(contractWords('C-BTC-80000-160926'), '80,000 CE · 160926');
  assert.equal(contractWords('P-BTC-74000-160926'), '74,000 PE · 160926');
});

// ------------------------------------------------------------------ the store

const fresh = () => new SqliteTradeStore(join(mkdtempSync(join(tmpdir(), 'alerts-')), 'trades.db'));

test('[critical] an alert is stored, listed while live, and gone from the live list once fired', () => {
  const s = fresh();
  const a = s.addPremiumAlert({ symbol: 'P-BTC-74000-160926', threshold: 5, expiryTs: 1_789_650_000, now: 1_000 });
  assert.equal(a.firedAt, null);
  assert.equal(s.livePremiumAlerts().length, 1);
  assert.equal(s.firePremiumAlert(a.id, 2_000, 5.4), true);
  assert.equal(s.livePremiumAlerts().length, 0, 'fired is not live');
  const after = s.premiumAlert(a.id)!;
  assert.equal(after.firedAt, 2_000);
  assert.equal(after.firedBid, 5.4);
});

test('[critical] firing is idempotent at the row: the second fire is refused', () => {
  // The guard against ringing twice: the store says no, before any message.
  const s = fresh();
  const a = s.addPremiumAlert({ symbol: 'P-BTC-74000-160926', threshold: 5, expiryTs: 1_789_650_000, now: 1_000 });
  assert.equal(s.firePremiumAlert(a.id, 2_000, 5.4), true);
  assert.equal(s.firePremiumAlert(a.id, 3_000, 9.9), false);
  assert.equal(s.premiumAlert(a.id)!.firedBid, 5.4, 'and the first bid is what is kept');
});

test('the recent list keeps fired alerts, so "did it ever go off" is answerable', () => {
  const s = fresh();
  const a = s.addPremiumAlert({ symbol: 'P-BTC-74000-160926', threshold: 5, expiryTs: 1_789_650_000, now: 1_000 });
  s.firePremiumAlert(a.id, 2_000, 5.4);
  assert.equal(s.recentPremiumAlerts(0).length, 1);
  assert.equal(s.recentPremiumAlerts(5_000).length, 0, 'and only from the moment asked');
});

test('deleting is final, and deleting nothing says so', () => {
  const s = fresh();
  const a = s.addPremiumAlert({ symbol: 'C-BTC-80000-160926', threshold: 3, expiryTs: 1_789_650_000, now: 1_000 });
  assert.equal(s.deletePremiumAlert(a.id), true);
  assert.equal(s.deletePremiumAlert(a.id), false);
  assert.equal(s.premiumAlert(a.id), null);
});

test('the migration is on the ledger, after the MTM samples', () => {
  const s = fresh();
  assert.ok(s.migrations().some((m) => m.id === '009-premium-alerts'));
});
