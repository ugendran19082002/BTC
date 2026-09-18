import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_TRADE_DEFAULTS, autoTradeKey, cleanAutoTradeSettings, decideAutoTrade,
  type AutoTradeLedger, type AutoTradeSettings,
} from '../src/trading/auto-trade.js';
import type { BestTrade } from '../src/domain/best-trade.js';

/**
 * Selling the best pick by itself.
 *
 * An auto-trader is judged by what it refuses to do, so that is what most of
 * this file is: off by default, never a "best of none", never the same strike
 * twice in one contract, never on top of a position the desk is already
 * carrying, and never again after the gates have turned a strike down.
 *
 * The defaults are the ones asked for on 17 September: 5 lots, a 95% target —
 * bought back at 5% of the sale price — and one automatic trade per contract.
 */

const pick = (over: Partial<NonNullable<BestTrade['pick']>> = {}): NonNullable<BestTrade['pick']> => ({
  cp: 'C', side: 'CE', strike: 78_600,
  premiumUsd: 10.1, expiryOtm: 0.997, touch: 0.05, nearZero: 0.97,
  emBuffer: 2.94, delta: 0.025, liquidity: 31,
  creditUsd: 0.968, maxLossUsd: null, creditRisk: null, hedge: null,
  rank: 84, reasons: ['99.7% to expire worthless', '2.94× the expected move away'], failing: [],
  ...over,
});

const best = (over: Partial<BestTrade> = {}): BestTrade => ({
  pick: pick(), runnersUp: [], eligible: 6, why: null,
  agreesWithEngine: true, bestOfNone: false, minPremiumUsd: 5,
  ...over,
});

const snap = { expiry: '170926', expiryTs: 1_789_646_400, live: true };
const armed = (over: Partial<AutoTradeSettings> = {}): AutoTradeSettings =>
  ({ ...AUTO_TRADE_DEFAULTS, on: true, ...over });
const empty = (expiry = snap.expiry): AutoTradeLedger => ({ expiry, entries: {} });

const decide = (o: {
  settings?: AutoTradeSettings; best?: BestTrade; ledger?: AutoTradeLedger;
  openSymbols?: string[]; live?: boolean;
} = {}) => decideAutoTrade({
  settings: o.settings ?? armed(),
  best: o.best ?? best(),
  snap: { ...snap, live: o.live ?? true },
  openSymbols: o.openSymbols ?? [],
  ledger: o.ledger ?? empty(),
  symbolFor: (side, strike) => `${side === 'CE' ? 'C' : 'P'}-BTC-${strike}-${snap.expiry}`,
});

// ---------------------------------------------------------------------------

test('[critical] off by default: nothing is ever placed by a switch nobody threw', () => {
  assert.equal(AUTO_TRADE_DEFAULTS.on, false);
  assert.deepEqual(decide({ settings: { ...AUTO_TRADE_DEFAULTS } }), { act: 'skip', why: 'off' });
});

test('[critical] armed, it sells the pick: 5 lots, a 95% target, the card\'s own reasons', () => {
  const d = decide();
  assert.equal(d.act, 'place');
  assert.deepEqual(d.act === 'place' && {
    symbol: d.symbol, lots: d.lots, takeProfitPct: d.takeProfitPct, stopLossPct: d.stopLossPct, key: d.key,
  }, {
    symbol: 'C-BTC-78600-170926', lots: 5, takeProfitPct: 0.95, stopLossPct: 0, key: 'CE-78600',
  });
  assert.match(d.act === 'place' ? d.why : '', /expire worthless/);
});

test('[critical] a "best of none" is never sold — the card says it is not a recommendation', () => {
  const d = decide({ best: best({ bestOfNone: true, why: 'nothing clears the rules' }) });
  assert.deepEqual(d, { act: 'skip', why: 'no strike clears the hard rules today' });
});

test('an empty board and a past board are both left alone', () => {
  assert.equal(decide({ best: best({ pick: null, why: 'nothing worth selling' }) }).why, 'nothing worth selling');
  assert.equal(decide({ live: false }).why, 'not a live board');
});

test('[critical] the same strike is never sold twice in one contract', () => {
  const ledger: AutoTradeLedger = {
    expiry: snap.expiry,
    entries: { [autoTradeKey('CE', 78_600)]: { at: 1, status: 'placed', tradeId: 't1' } },
  };
  assert.match(decide({ ledger }).why ?? '', /already sold automatically/);
});

test('[critical] a strike the gates refused is not asked about again this contract', () => {
  const ledger: AutoTradeLedger = {
    expiry: snap.expiry,
    entries: { [autoTradeKey('CE', 78_600)]: { at: 1, status: 'refused', detail: 'not enough margin' } },
  };
  assert.match(decide({ ledger }).why ?? '', /refused earlier/);
});

test('[critical] the cap is per contract, and a refusal does not use it up', () => {
  const placed: AutoTradeLedger = {
    expiry: snap.expiry,
    entries: { 'CE-79000': { at: 1, status: 'placed', tradeId: 't1' } },
  };
  assert.match(decide({ ledger: placed }).why ?? '', /1 automatic trade already/);
  // raising the cap lets the next pick through
  assert.equal(decide({ ledger: placed, settings: armed({ maxPerContract: 2 }) }).act, 'place');
  const refused: AutoTradeLedger = {
    expiry: snap.expiry,
    entries: { 'CE-79000': { at: 1, status: 'refused', detail: 'spread too wide' } },
  };
  assert.equal(decide({ ledger: refused }).act, 'place', 'a refusal is not a trade');
});

test('[critical] a new contract starts from a clean sheet', () => {
  const yesterday: AutoTradeLedger = {
    expiry: '160926',
    entries: { 'CE-78600': { at: 1, status: 'placed', tradeId: 't1' } },
  };
  assert.equal(decide({ ledger: yesterday }).act, 'place');
});

test('[critical] never on top of something the desk is already carrying', () => {
  assert.match(decide({ openSymbols: ['C-BTC-78600-170926'] }).why ?? '', /already holding/);
  assert.equal(decide({ openSymbols: ['P-BTC-75000-170926'] }).act, 'place', 'a different contract is not this one');
});

test('the settings are brought inside their limits rather than trusted', () => {
  assert.deepEqual(cleanAutoTradeSettings({}), AUTO_TRADE_DEFAULTS);
  const wild = cleanAutoTradeSettings({
    on: true, lots: 99_999, targetPct: 140, stopPct: -3, chaseSeconds: 10_000, maxPerContract: 99,
  });
  assert.deepEqual(wild, { on: true, lots: 1_000, targetPct: 99, stopPct: 0, chaseSeconds: 600, maxPerContract: 10 });
  assert.equal(cleanAutoTradeSettings({ lots: 0 }).lots, 1);
  assert.equal(cleanAutoTradeSettings({ lots: 2.6 }).lots, 3);
  // anything unreadable falls back to the default rather than to zero lots
  assert.deepEqual(cleanAutoTradeSettings({ lots: NaN, targetPct: undefined }), AUTO_TRADE_DEFAULTS);
  assert.equal(cleanAutoTradeSettings({ on: 'yes' as never }).on, false, 'only a real true arms it');
});

test('a 95% target means buying back at a twentieth of the sale price', () => {
  const d = decide();
  assert.equal(d.act === 'place' ? d.takeProfitPct : null, 0.95);
  // what the engine does with it: 10.10 sold, bought back at 0.50
  const target = Math.round(10.1 * (1 - 0.95) * 10) / 10;
  assert.equal(target, 0.5);
});
