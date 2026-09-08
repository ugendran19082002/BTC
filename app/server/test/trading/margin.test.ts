import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_BTC, LEVERAGE_STEPS, MAX_LEVERAGE, clampLeverage, feePerContract,
  fundsRequiredPerContract, initialMarginPerContract, liquidationMultiple,
  liquidationPrice, liquidationRoom, maxLotsAt,
} from '../../src/trading/margin.js';

/**
 * Two real tickets, read off Delta's own app, are the anchors for everything
 * here. If a change to the model moves either of them, the model is wrong --
 * not the test.
 */

/** C-BTC-82000: index 78,405.5, call at $16, 200x, 10 lots -> "Funds req. 3.93". */
const CALL = { spot: 78_405.5, premium: 16, leverage: 200 };
/** P-BTC-78400: index 78,450.1, put at $506, 200x. */
const PUT = { spot: 78_450.1, premium: 506, leverage: 200 };

test('funds required matches the number Delta actually shows', () => {
  const total = fundsRequiredPerContract(CALL) * 10;
  assert.ok(Math.abs(total - 3.93) < 0.01, `got ${total.toFixed(4)}, Delta said 3.93`);
});

test('the premium is not part of the margin', () => {
  // adding it, which the docs seem to suggest, overstates the real ticket by 4%
  const naive = (CALL.spot / CALL.leverage + CALL.premium) * CONTRACT_BTC * 10;
  assert.ok(naive > 4.07, 'the naive version really is higher');
  assert.ok(Math.abs(naive - 3.93) > 0.1, 'and it really does miss');
  // two options at the same leverage cost the same to hold, however dear
  assert.equal(
    initialMarginPerContract({ ...CALL, premium: 16 }),
    initialMarginPerContract({ ...CALL, premium: 506 }),
  );
});

test('the fee is capped at a share of the premium, not charged on the notional', () => {
  const fee = feePerContract(CALL);
  // 0.01% of a $78k notional would be 7.8 cents; 3.5% of a $16 premium is 0.056
  assert.ok(Math.abs(fee - 0.00056) < 1e-6, `got ${fee}`);
  // on a dear enough option the notional rate binds instead
  const dear = feePerContract({ spot: 78_405.5, premium: 5_000, leverage: 200 });
  assert.ok(Math.abs(dear - 0.0001 * 78_405.5 * CONTRACT_BTC) < 1e-9);
});

test('margin falls in proportion to leverage', () => {
  const at = (leverage: number) => initialMarginPerContract({ ...CALL, leverage });
  assert.ok(Math.abs(at(10) / at(200) - 20) < 1e-9, 'exactly twenty times, since it is a flat slice of spot');
  assert.ok(Math.abs(at(200) - 0.392) < 0.001, `got ${at(200)}`);
  assert.ok(Math.abs(at(10) - 7.84) < 0.01, `got ${at(10)}`);
});

test('a short is closed out above where it was sold, never below', () => {
  for (const leverage of LEVERAGE_STEPS) {
    for (const t of [CALL, PUT]) {
      const liq = liquidationPrice({ ...t, leverage })!;
      assert.ok(liq > t.premium, `${leverage}x put the close-out at ${liq}, under the ${t.premium} sold`);
    }
  }
});

test('the room is a flat number of dollars, the same for a cheap option and a dear one', () => {
  // 78,405 x 0.5 / 200
  assert.ok(Math.abs(liquidationRoom(CALL)! - 196.0) < 0.5, `got ${liquidationRoom(CALL)}`);
  assert.ok(Math.abs(liquidationRoom({ ...CALL, premium: 506 })! - liquidationRoom(CALL)!) < 1e-9);
});

test('which is why the dear option is the dangerous one at the same leverage', () => {
  // the $16 call has to go up thirteen-fold; the $506 put only has to move 39%
  assert.ok(liquidationMultiple(CALL)! > 12, `call: ${liquidationMultiple(CALL)!.toFixed(1)}x`);
  assert.ok(liquidationMultiple(PUT)! < 1.5, `put: ${liquidationMultiple(PUT)!.toFixed(2)}x`);
  assert.ok(Math.abs(liquidationPrice(PUT)! - 702.1) < 1, `put closes out at ${liquidationPrice(PUT)}`);
});

test('dropping to 10x gives the same trade twenty times the room', () => {
  const tight = liquidationRoom({ ...PUT, leverage: 200 })!;
  const loose = liquidationRoom({ ...PUT, leverage: 10 })!;
  assert.ok(Math.abs(loose / tight - 20) < 1e-9);
  assert.ok(liquidationMultiple({ ...PUT, leverage: 10 })! > 8, 'the put would have to go up eightfold');
});

test('the room shrinks at every rung as leverage rises', () => {
  let previous = Infinity;
  for (const leverage of LEVERAGE_STEPS) {
    const room = liquidationRoom({ ...PUT, leverage })!;
    assert.ok(room < previous, `${leverage}x did not tighten the room`);
    previous = room;
  }
});

test('more leverage buys proportionally more lots', () => {
  // the account in the screenshot had $0.58 available
  assert.equal(maxLotsAt(0.58, CALL), 1, 'barely one lot, which is what Delta said');
  assert.equal(maxLotsAt(50, CALL), 127);
  assert.equal(maxLotsAt(50, { ...CALL, leverage: 10 }), 6);
  // the same $50 opens twenty times the position, which loses twenty times as fast
  assert.ok(maxLotsAt(50, CALL) > maxLotsAt(50, { ...CALL, leverage: 10 }) * 19);
});

test('lots floor rather than round, so margin is never overcommitted', () => {
  const per = fundsRequiredPerContract(CALL);
  assert.equal(maxLotsAt(per * 3.9, CALL), 3, 'three fit; a fourth would not be covered');
});

test('an account with nothing in it can carry nothing', () => {
  assert.equal(maxLotsAt(0, CALL), 0);
  assert.equal(maxLotsAt(-5, CALL), 0);
});

test('leverage is clamped to what Delta accepts, not passed through', () => {
  assert.equal(clampLeverage(0), 1);
  assert.equal(clampLeverage(-3), 1);
  assert.equal(clampLeverage(1000), MAX_LEVERAGE);
  assert.equal(clampLeverage(25.9), 25, 'whole numbers only');
  assert.equal(clampLeverage(Number.NaN), 1, 'a missing leverage is the safest one');
});

test('a nonsense spot returns no answer rather than a misleading one', () => {
  assert.equal(liquidationPrice({ spot: 0, premium: 506, leverage: 200 }), null);
  assert.equal(liquidationPrice({ ...PUT, contractValue: 0 }), null);
  assert.equal(liquidationMultiple({ ...PUT, premium: 0 }), null);
});

test('a lot larger than one contract scales the requirement with it', () => {
  const per = fundsRequiredPerContract(CALL);
  assert.equal(maxLotsAt(per * 10, CALL, 1), 10);
  assert.equal(maxLotsAt(per * 10, CALL, 10), 1);
});

test('the contract size is the one Delta lists', () => {
  assert.equal(CONTRACT_BTC, 0.001);
});
