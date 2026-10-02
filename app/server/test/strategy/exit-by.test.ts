import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitByOf, perpInReason } from '../../src/strategy/store.js';

/** Which exit closed a signal trade -- the perp first, then the option -- for the history's Result. */
test('[critical] each exit named from the close reason and the order that filled', () => {
  assert.equal(exitByOf("BTC perp at 84,590.00 reached the signal's stop 84,600.00", 'manual'), 'perp-sl');
  assert.equal(exitByOf("BTC perp at 85,510.00 reached the signal's target 85,500.00", 'manual'), 'perp-tgt');
  assert.equal(exitByOf(null, 'take_profit'), 'option-tgt', 'the option target rested at Delta and filled');
  assert.equal(exitByOf(null, 'stop_loss'), 'option-sl', 'the backstop stop at Delta');
  assert.equal(exitByOf('stop reached: the offer held at 75 (stop 72) for 15 s', 'manual'), 'option-sl', "the desk's own option stop watch");
  assert.equal(exitByOf("the strategy's exit time, 5:29 PM", 'manual'), 'window-end');
  assert.equal(exitByOf('manual exit', 'manual'), 'manual');
  // an option stop watch's reason never reads as the perp's
  assert.notEqual(exitByOf('stop: a bar closed at 80 through 72', 'manual'), 'perp-sl');
});

test('the perp price in a reason, grouped and two decimals', () => {
  assert.equal(perpInReason("BTC perp at 84,590.50 reached the signal's stop 84,612.35"), 84_590.5);
  assert.equal(perpInReason('stop reached: the offer held at 75'), null);
});
