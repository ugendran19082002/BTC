import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CEILING_MARGIN_MAX_RATIO, DEFAULT_LIMITS, ceilingMarginPerContract, maxShortContractsFor, precheck, type PrecheckInput,
} from '../../src/trading/precheck.js';

/**
 * The total-short cap, made settable from the screen.
 *
 * Written after a live refusal nobody could explain from the desk: 410
 * contracts were already short, the ticket offered "775 lots at 200x", and the
 * gate answered "Would take total short to 820, limit is 500". Every number on
 * that screen was right and none of them agreed.
 *
 * The rule the cap has to keep is the one `maxDailyLossUsd` already keeps: the
 * browser may ask the desk to risk *less*, never more. A cap above what the
 * margin can carry can never fire, and a gate that cannot fire is worse than no
 * gate, because it reads as protection.
 */

test('with nothing chosen, the margin ceiling is the cap', () => {
  assert.equal(maxShortContractsFor(900, null), 900);
});

test('a smaller choice lowers the cap', () => {
  assert.equal(maxShortContractsFor(900, 500), 500);
});

test('[critical] a choice above the margin ceiling cannot raise the cap', () => {
  // The whole point. Asking for 5,000 on margin that covers 900 must not
  // produce a limit of 5,000 -- it produces 900, and the gate still bites.
  assert.equal(maxShortContractsFor(900, 5_000), 900);
});

test('an unknown ceiling falls back to the fixed default rather than to no limit', () => {
  // No spot or no balance read yet. The dangerous answer here is Infinity.
  assert.equal(maxShortContractsFor(null, null), DEFAULT_LIMITS.maxShortContracts);
  assert.equal(maxShortContractsFor(null, 5_000), DEFAULT_LIMITS.maxShortContracts);
  assert.equal(maxShortContractsFor(null, 50), 50);
});

test('a nonsense ceiling is treated as no ceiling, not as zero', () => {
  // A zero cap would refuse every order on the desk, which is a worse failure
  // than the one it is guarding against.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(maxShortContractsFor(bad, null), DEFAULT_LIMITS.maxShortContracts);
  }
});

test('a nonsense choice leaves the ceiling standing', () => {
  for (const bad of [0, -5, Number.NaN]) {
    assert.equal(maxShortContractsFor(900, bad), 900);
  }
});

test('fractional numbers are floored, never rounded up', () => {
  // Rounding up would let a cap of 500.9 permit 501 contracts.
  assert.equal(maxShortContractsFor(900.9, null), 900);
  assert.equal(maxShortContractsFor(900, 500.9), 500);
});

test('a sub-contract choice is ignored rather than halting the desk', () => {
  assert.equal(maxShortContractsFor(900, 0.4), 900);
});

test('[critical] a ceiling below one contract never becomes a cap of zero', () => {
  // floor(0.5) is 0, and a cap of 0 refuses every order on the desk -- a worse
  // failure than the one the cap exists to prevent.
  assert.equal(maxShortContractsFor(0.5, null), DEFAULT_LIMITS.maxShortContracts);
  // An explicit choice of 1 is still honoured: asking to risk less is allowed.
  assert.equal(maxShortContractsFor(0.5, 1), 1);
});

/**
 * The gate itself, on the board from the incident: 80,800 CE, bid 25 / ask 28,
 * spot 78,607.8, $305.59 free. Resting at the offer, so the spread and depth
 * gates do not apply -- the cap is the only thing under test.
 */
const NOW = 1_700_000_000_000;
const EXPIRY_TS = Math.floor(NOW / 1000) + 63_000;

const gateInput = (totalShort: number, size: number, cap: number): PrecheckInput => ({
  now: NOW,
  intent: {
    side: 'sell',
    size,
    expect: { underlying: 'BTC', optionSide: 'CE', strike: 80_800, expiryTs: EXPIRY_TS },
    price: 26,
    reduceOnly: false,
    leverage: 200,
    crossing: false,
    stopPrice: null,
  },
  spot: 78_607.8,
  product: {
    symbol: 'C-BTC-80800-090926', productId: 1, underlying: 'BTC', optionSide: 'CE',
    strike: 80_800, expiryTs: EXPIRY_TS, tickSize: 0.1, lotSize: 1,
    contractValue: 0.001, state: 'live',
  },
  quote: {
    symbol: 'C-BTC-80800-090926', bid: 25, ask: 28,
    bidSize: 5_000, askSize: 5_000, mark: 26.19, at: NOW,
  },
  feedHealthy: true,
  tradingEnabled: true,
  account: { availableUsd: 305.59 },
  existingPosition: 0,
  totalShortContracts: totalShort,
  dayPnlUsd: 0,
  worstCaseLossUsd: 0,
  limits: { ...DEFAULT_LIMITS, maxShortContracts: cap },
});

test('the live refusal reproduces: 410 short, 410 more, cap 500', () => {
  const res = precheck(gateInput(410, 410, 500));
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.failures.some((f) => f.code === 'MAX_POSITION'));
  assert.ok(
    !res.ok && res.failures.some((f) => f.message.includes('820') && f.message.includes('500')),
    'the refusal has to name both numbers, or it cannot be acted on',
  );
});

test('the same order passes once the cap is raised to what margin allows', () => {
  const res = precheck(gateInput(410, 410, 900));
  assert.equal(res.ok, true);
});

test('exactly at the cap is allowed; one contract over is not', () => {
  assert.equal(precheck(gateInput(410, 90, 500)).ok, true);
  assert.equal(precheck(gateInput(410, 91, 500)).ok, false);
});

// ------------------------------------------------ the ceiling, priced at what the exchange charges (11 Oct 2026)

/*
 * Live, 11 Oct 2026: "still to open: 37 entries, 73 lots -- needs Rs 2,730 more margin, Rs 2,593 is free (105%),
 * more than is free", under "the desk's limit of 93 short (20 now)". The limit was the free margin over the desk's
 * 200x model; Delta was charging about 5% more a lot. The gate would pass four lots Delta would refuse.
 */
const MODEL = (83_000 * 0.001) / 200;   // the desk's 200x model: 0.415 USD a contract
const FREE = 30.5;                      // free margin, USD (Rs 2,593 at 85)
const ceiling = (each: number, short: number) => Math.floor(FREE / each) + short;

test('[critical] the live figures: the limit was 93 at the model, and is 89 at what Delta charges -- what the margin carries', () => {
  assert.equal(ceiling(MODEL, 20), 93, 'as it read on the screen');
  const delta = 0.44;                    // Delta's margin in use over the 20 short: Rs 37.39 a lot
  const each = ceilingMarginPerContract(MODEL, delta * 20, 20);
  assert.ok(Math.abs(each - delta) < 1e-9, 'Delta\'s figure, the dearer');
  assert.equal(ceiling(each, 20), 89);
  // And the lots it leaves fit in what is free -- the screen's question, answered the same way by the gate.
  assert.ok((ceiling(each, 20) - 20) * delta <= FREE);
  assert.ok((ceiling(MODEL, 20) - 20) * delta > FREE, 'which the old limit did not');
  assert.equal(maxShortContractsFor(ceiling(each, 20), null), 89);
  assert.equal(maxShortContractsFor(ceiling(each, 20), 50), 50, 'a smaller choice still lowers it');
});

test('[critical] the exchange\'s figure is never taken below the model, and never when it is not a margin per contract', () => {
  // Cheaper than the model: the model stands -- the ceiling is never raised by a reading.
  assert.equal(ceilingMarginPerContract(MODEL, 0.30 * 20, 20), MODEL);
  // Nothing short, nothing in use, no reading (paper): the model.
  assert.equal(ceilingMarginPerContract(MODEL, 5, 0), MODEL);
  assert.equal(ceilingMarginPerContract(MODEL, 0, 20), MODEL);
  assert.equal(ceilingMarginPerContract(MODEL, null, 20), MODEL);
  // Two short and six entries resting: margin in use is eight contracts' over two -- four times a contract's.
  // Taken literally it would quarter the limit and refuse entries the margin can carry.
  assert.equal(ceilingMarginPerContract(MODEL, MODEL * 8, 2), MODEL);
  // Up to the band it is taken; a hair past it, not.
  assert.equal(ceilingMarginPerContract(MODEL, MODEL * CEILING_MARGIN_MAX_RATIO * 10, 10), MODEL * CEILING_MARGIN_MAX_RATIO);
  assert.equal(ceilingMarginPerContract(MODEL, MODEL * (CEILING_MARGIN_MAX_RATIO + 0.01) * 10, 10), MODEL);
  // A model that is not a number yet is handed back as it came (the caller answers "no ceiling").
  assert.equal(ceilingMarginPerContract(0, 5, 10), 0);
});

test('[critical] the desk\'s own ceiling uses it: the wallet read for the balance carries the margin in use', async () => {
  const { TradingService } = await import('../../src/trading/service.js');
  const { MemoryTradeStore } = await import('../../src/trading/engine.js');
  const { SettingsCache } = await import('../../src/db/settings.js');
  const { closePool } = await import('../../src/db/pool.js');
  try {
    const svc = new TradingService({ settings: await new SettingsCache().load(), store: new MemoryTradeStore() as never, notifier: null });
    // The desk as it stood: 20 short, Delta's wallet worth 39.3 with 30.5 free -- 8.8 in use, 0.44 a contract.
    const inside = svc as unknown as {
      exchange: { getWalletUsd?: () => Promise<{ balance: number; available: number }>; getBalanceUsd: () => Promise<number> };
      lastShortContracts: number; lastSpot: number | null;
    };
    inside.lastShortContracts = 20;
    inside.lastSpot = 83_000;
    inside.exchange.getWalletUsd = async () => ({ balance: 39.3, available: 30.5 });
    assert.equal(await svc.balance(), 30.5, 'the balance is still what is free');
    assert.equal(svc.shortCeilingContracts, 89);
    assert.equal(svc.maxShortContracts, 89);
    // An exchange with no wallet to read (paper): the balance alone, and the model, as before.
    delete inside.exchange.getWalletUsd;
    inside.exchange.getBalanceUsd = async () => 30.5;
    const paper = new TradingService({ settings: await new SettingsCache().load(), store: new MemoryTradeStore() as never, notifier: null });
    const p = paper as unknown as typeof inside;
    p.lastShortContracts = 20; p.lastSpot = 83_000;
    p.exchange.getBalanceUsd = async () => 30.5;
    await paper.balance();
    assert.equal(paper.shortCeilingContracts, 93);
  } finally {
    await closePool();
  }
});
