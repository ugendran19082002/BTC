import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_GUARDS_TESTED, MOMENTUM_GUARD_DEFAULT, anyEntryGuardOn, bidGuardWhy, marketGuardWhy, momentumBlocks, momentumGuardMerged, momentumGuardOf, momentumGuardProblem, momentumPtsAt, momentumWords, type GuardMarket } from '../../src/strategy/types.js';
import { signalReasons } from '../../src/strategy/signal-reasons.js';

/**
 * The momentum guard, one account's (owner, 30 Oct 2026: "Momentum 1h >= +250, CE mattum, default off"): no call sold
 * while the perp has risen its points or more in the hour. Stored as JSON; whatever cannot be read is off.
 */

/** The guards added on 21 Nov 2026, as a setting saved before then reads them: calls only, the rest off. */
const NEW = { sides: 'ce', q15: { on: false, pct: 0.4 }, iv: { on: false, pts: 5 }, bid: { on: false, min: 500 } } as const;

test('[critical] off unless set; stored: on and its points, a figure out of range keeps 250', () => {
  assert.deepEqual(MOMENTUM_GUARD_DEFAULT, { on: false, pts: 250, unit: 'pts', pct: 0.25, ...NEW });
  for (const raw of [null, '', 'not json', '[1]', '{"on":"yes"}']) assert.deepEqual(momentumGuardOf(raw), { on: false, pts: 250, unit: 'pts', pct: 0.25, ...NEW }, String(raw));
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":300}'), { on: true, pts: 300, unit: 'pts', pct: 0.25, ...NEW }, 'saved before the unit: points');
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":10}'), { on: true, pts: 250, unit: 'pts', pct: 0.25, ...NEW });
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":250.5}'), { on: true, pts: 250, unit: 'pts', pct: 0.25, ...NEW });
});

test('[critical] what it holds back: a call to be sold, the guard on, the rise at its points or more -- nothing else', () => {
  const on = { on: true, pts: 250, unit: 'pts' as const, pct: 0.25 };
  assert.equal(momentumBlocks(on, 'CE', 250), true, 'at the points');
  assert.equal(momentumBlocks(on, 'CE', 555), true);
  assert.equal(momentumBlocks(on, 'CE', 249), false, 'a point short');
  assert.equal(momentumBlocks(on, 'CE', -400), false, 'a fall');
  assert.equal(momentumBlocks(on, 'PE', 555), false, 'puts are never held back');
  assert.equal(momentumBlocks(on, null, 555), false, 'nor an option bought');
  assert.equal(momentumBlocks(on, 'CE', null), false, 'a rise that cannot be read holds nothing back');
  assert.equal(momentumBlocks({ ...on, on: false }, 'CE', 555), false, 'off');
});

test('what may be saved: on true or false, whole points 50 to 2000; null is back to off', () => {
  assert.equal(momentumGuardProblem(null), null);
  assert.equal(momentumGuardProblem({ on: true, pts: 250 }), null);
  assert.equal(momentumGuardProblem({ on: false, pts: 50 }), null);
  assert.equal(momentumGuardProblem({ on: true, pts: 2_000 }), null);
  assert.match(momentumGuardProblem({ on: true, pts: 49 })!, /whole points from 50 to 2000/);
  assert.match(momentumGuardProblem({ on: true, pts: 250.5 })!, /whole points/);
  assert.match(momentumGuardProblem({ on: true })!, /whole points/);
  assert.match(momentumGuardProblem({ on: 'yes', pts: 250 })!, /true or false/);
  assert.match(momentumGuardProblem([250])!, /"on": true, "pts": 250/);
});

/** 14 Nov 2026 (owner "0.25% of price"): the rise as a per cent of the perp's price, so it scales with BTC. */
test('[critical] per cent of the price: read, saved, and turned into points at the perp now', () => {
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":200,"unit":"pct","pct":0.25}'), { on: true, pts: 200, unit: 'pct', pct: 0.25, ...NEW });
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":200,"unit":"pct","pct":9}'), { on: true, pts: 200, unit: 'pct', pct: 0.25, ...NEW }, 'out of range keeps 0.25');
  assert.deepEqual(momentumGuardOf('{"on":true,"pts":200,"unit":"weird"}').unit, 'pts');
  const g = momentumGuardOf('{"on":true,"pts":200,"unit":"pct","pct":0.25}');
  assert.equal(momentumPtsAt(g, 67_500), 168.75, '0.25% of 67,500');
  assert.equal(momentumPtsAt(g, 100_000), 250, 'and of 1,00,000');
  assert.equal(momentumPtsAt(g, null), null, 'no price, no level');
  assert.equal(momentumPtsAt({ ...g, unit: 'pts' }, 67_500), 200, 'points ignore the price');
  assert.equal(momentumBlocks(g, 'CE', 169, 67_500), true, 'at 0.25%');
  assert.equal(momentumBlocks(g, 'CE', 168, 67_500), false, 'a point short');
  assert.equal(momentumBlocks(g, 'CE', 240, 100_000), false, 'the same rise at 1,00,000 is under 0.25%');
  assert.equal(momentumBlocks(g, 'CE', 250, 100_000), true);
  assert.equal(momentumBlocks(g, 'CE', 999, null), false, 'no price: nothing held back');
  assert.equal(momentumBlocks(g, 'PE', 999, 67_500), false, 'puts are never held back');
  assert.equal(momentumWords(g, 67_567), '0.25% (169 pts at 67567)');
  assert.equal(momentumWords(g, null), '0.25%');
  assert.equal(momentumWords({ ...g, unit: 'pts' }, 67_567), '200', 'points worded as before');
  assert.equal(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.25 }), null, 'points not needed for a per cent');
  assert.equal(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.25, pts: 200 }), null);
  assert.equal(momentumGuardProblem({ on: true, unit: 'pts', pts: 200, pct: 0.25 }), null);
  assert.match(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.04 })!, /per cent from 0.05 to 2/);
  assert.match(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.255 })!, /two decimals/);
  assert.match(momentumGuardProblem({ on: true, unit: 'pct' })!, /per cent/);
  assert.match(momentumGuardProblem({ on: true, unit: 'pct', pct: 0.25, pts: 10 })!, /whole points/);
  assert.match(momentumGuardProblem({ on: true, unit: 'bps', pts: 200 })!, /"pts" or "pct"/);
});

/*
 * The entry guards of 21 Nov 2026 (owner: "IV +5 + Momentum A + bid size <500 ... one by one combo enable"): the momentum
 * guard on both sides and over 15 minutes, the IV spike guard and the thin-bid guard, each with its own switch -- the
 * 30-day study's best (docs/research/2026-11-21-entry-guard-study.md).
 */
const market = (o: Partial<GuardMarket> = {}): GuardMarket => ({ perp: 90_000, hourAgo: 90_000, quarterAgo: 90_000, ivNow: 0.4, ivHourAgo: 0.4, ...o });

test('[critical] stored: each new guard read on its own, out-of-range numbers keep the default, an old setting reads as calls only', () => {
  const g = momentumGuardOf(JSON.stringify(ENTRY_GUARDS_TESTED));
  assert.deepEqual(g, ENTRY_GUARDS_TESTED, 'the tested set reads back whole');
  assert.deepEqual(g, { on: true, pts: 250, unit: 'pct', pct: 0.8, sides: 'both', q15: { on: true, pct: 0.4 }, iv: { on: true, pts: 5 }, bid: { on: true, min: 500 } });
  const odd = momentumGuardOf('{"on":true,"pts":250,"sides":"puts","q15":{"on":true,"pct":7},"iv":{"on":true,"pts":0.5},"bid":{"on":"yes","min":2.5}}');
  assert.equal(odd.sides, 'ce', 'an unknown side is calls only');
  assert.deepEqual(odd.q15, { on: true, pct: 0.4 });
  assert.deepEqual(odd.iv, { on: true, pts: 5 });
  assert.deepEqual(odd.bid, { on: false, min: 500 }, '"yes" is not on');
  assert.equal(anyEntryGuardOn(MOMENTUM_GUARD_DEFAULT), false);
  assert.equal(anyEntryGuardOn({ ...MOMENTUM_GUARD_DEFAULT, iv: { on: true, pts: 5 } }), true, 'IV alone counts');
  assert.equal(anyEntryGuardOn({ ...MOMENTUM_GUARD_DEFAULT, bid: { on: true, min: 500 } }), true, 'bid alone counts');
});

test('what may be saved: sides, the 15 minutes, IV vol points and the bid size, each checked', () => {
  assert.equal(momentumGuardProblem(ENTRY_GUARDS_TESTED), null);
  assert.equal(momentumGuardProblem({ on: false, pts: 250, iv: { on: true, pts: 5 } }), null, 'IV on with momentum off');
  assert.equal(momentumGuardProblem({ on: false, pts: 250, iv: { on: true, pts: 7.5 }, bid: { on: true, min: 1 } }), null);
  assert.match(momentumGuardProblem({ on: true, pts: 250, sides: 'pe' })!, /"ce" \(calls only\) or "both"/);
  assert.match(momentumGuardProblem({ on: true, pts: 250, q15: { on: true, pct: 3 } })!, /15-minute momentum guard's rise must be a per cent from 0.05 to 2/);
  assert.match(momentumGuardProblem({ on: true, pts: 250, q15: true })!, /15-minute momentum guard is \{"on"/);
  assert.match(momentumGuardProblem({ on: true, pts: 250, iv: { on: true, pts: 0 } })!, /IV spike guard's rise must be vol points from 1 to 30/);
  assert.match(momentumGuardProblem({ on: true, pts: 250, iv: { on: true, pts: 5.25 } })!, /one decimal/);
  assert.match(momentumGuardProblem({ on: true, pts: 250, bid: { on: true, min: 0 } })!, /thin-bid guard's bid size must be whole contracts from 1 to 1,00,000/);
  assert.match(momentumGuardProblem({ on: true, pts: 250, bid: { on: 1, min: 500 } })!, /thin-bid guard is \{"on"/);
});

test('[critical] saved over what was there: whatever a screen does not send is kept -- the phone never turns IV or bid off', () => {
  const was = momentumGuardOf(JSON.stringify(ENTRY_GUARDS_TESTED));
  const fromOld = momentumGuardMerged({ on: false, pts: 250 }, was);
  assert.equal(fromOld.on, false, 'what it sent');
  assert.deepEqual([fromOld.sides, fromOld.q15, fromOld.iv, fromOld.bid], [was.sides, was.q15, was.iv, was.bid], 'the rest as saved');
  assert.equal(fromOld.pct, 0.8, 'and the per cent');
  const ivOff = momentumGuardMerged({ on: true, unit: 'pct', pct: 0.8, iv: { on: false } }, was);
  assert.deepEqual(ivOff.iv, { on: false, pts: 5 }, 'off keeps its number');
  assert.deepEqual(ivOff.bid, was.bid);
});

test('[critical] momentum both sides: a call after a rise, a put after a fall -- calls only leaves puts alone', () => {
  const ce = momentumGuardOf('{"on":true,"unit":"pct","pct":0.8,"pts":250}');
  const both = { ...ce, sides: 'both' as const };
  // 0.8% of 90,720 is 725.76 pts.
  const up = market({ perp: 90_720, hourAgo: 90_000 }), down = market({ perp: 89_270, hourAgo: 90_000 });
  assert.equal(marketGuardWhy(ce, 'CE', up), null, '720 is under 0.8% of 90,720 (726)');
  const up2 = market({ perp: 90_730, hourAgo: 90_000 });
  assert.equal(marketGuardWhy(ce, 'CE', up2), 'the perp is up 730 pts in the last hour (90000 to 90730) -- the momentum guard sells no call after a rise of 0.8% (726 pts at 90730) or more');
  assert.equal(marketGuardWhy(ce, 'PE', down), null, 'calls only: a put is sold after a fall');
  assert.equal(marketGuardWhy(both, 'PE', down), 'the perp is down 730 pts in the last hour (90000 to 89270) -- the momentum guard sells no put after a fall of 0.8% (714 pts at 89270) or more');
  assert.equal(marketGuardWhy(both, 'CE', down), null, 'a call after a fall is sold');
  assert.equal(marketGuardWhy(both, 'PE', up2), null, 'a put after a rise is sold');
  assert.equal(marketGuardWhy(both, null, down), null, 'nothing bought is held back');
  assert.equal(marketGuardWhy({ ...both, on: false }, 'PE', down), null, 'off');
  assert.equal(marketGuardWhy(both, 'PE', market({ perp: null, hourAgo: 90_000 })), null, 'no price now: nothing held back');
  assert.equal(marketGuardWhy(both, 'PE', market({ perp: 89_270, hourAgo: null, quarterAgo: null })), null, 'no price an hour ago');
  assert.equal(momentumBlocks(both, 'PE', -730, 89_270), true);
  assert.equal(momentumBlocks(both, 'PE', -700, 89_270), false, '700 is under 714');
});

test('[critical] momentum over 15 minutes: its own per cent, the same sides, only while the momentum guard is on', () => {
  const g = momentumGuardOf(JSON.stringify(ENTRY_GUARDS_TESTED));
  // An hour flat, the last 15 minutes up 0.40%: 90,000 to 90,360.
  const quarter = market({ perp: 90_360, hourAgo: 90_360, quarterAgo: 90_000 });
  assert.equal(marketGuardWhy(g, 'CE', quarter), 'the perp is up 0.40% in the last 15 minutes (90000 to 90360) -- the momentum guard sells no call after a 15-minute rise of 0.4% or more');
  assert.equal(marketGuardWhy(g, 'CE', market({ perp: 90_350, hourAgo: 90_350, quarterAgo: 90_000 })), null, '0.39%: sold');
  assert.equal(marketGuardWhy(g, 'PE', market({ perp: 89_640, hourAgo: 89_640, quarterAgo: 90_000 })), 'the perp is down 0.40% in the last 15 minutes (90000 to 89640) -- the momentum guard sells no put after a 15-minute fall of 0.4% or more');
  assert.equal(marketGuardWhy({ ...g, q15: { on: false, pct: 0.4 } }, 'CE', quarter), null, 'the 15 minutes off');
  assert.equal(marketGuardWhy({ ...g, on: false, iv: { on: false, pts: 5 } }, 'CE', quarter), null, 'nor with the momentum guard off');
  assert.equal(marketGuardWhy(g, 'CE', market({ perp: 90_360, hourAgo: 90_360, quarterAgo: null })), null, 'no price 15 minutes ago');
});

test('[critical] IV spike: ATM IV up its vol points or more in the hour holds back a sale on either side, whatever the momentum guard says', () => {
  const g = { ...MOMENTUM_GUARD_DEFAULT, iv: { on: true, pts: 5 } };
  const spike = market({ ivNow: 0.45, ivHourAgo: 0.40 });
  assert.equal(marketGuardWhy(g, 'CE', spike), 'ATM IV is up 5.0 pts in the last hour (40.0% to 45.0%) -- the IV spike guard sells nothing after a rise of 5 pts or more');
  assert.match(marketGuardWhy(g, 'PE', spike)!, /the IV spike guard sells nothing/, 'a put too');
  assert.equal(marketGuardWhy(g, 'CE', market({ ivNow: 0.449, ivHourAgo: 0.40 })), null, '4.9 pts: sold');
  assert.equal(marketGuardWhy(g, 'CE', market({ ivNow: 0.35, ivHourAgo: 0.45 })), null, 'IV falling: sold');
  assert.equal(marketGuardWhy(g, null, spike), null, 'nothing bought held back');
  assert.equal(marketGuardWhy({ ...g, iv: { on: false, pts: 5 } }, 'CE', spike), null, 'off');
  assert.equal(marketGuardWhy(g, 'CE', market({ ivNow: 0.45, ivHourAgo: null })), null, 'no IV an hour ago: nothing held back');
  assert.equal(marketGuardWhy(g, 'CE', market({ perp: null, ivNow: 0.45, ivHourAgo: 0.40 })) !== null, true, 'IV needs no perp price');
});

test('[critical] thin bid: the strike picked with fewer contracts bid than the number is not sold; a size not read holds nothing back', () => {
  const g = { bid: { on: true, min: 500 } };
  assert.equal(bidGuardWhy(g, 'CE', 92_000, 120), 'only 120 contracts bid on CE 92000 -- the thin-bid guard sells only where 500 or more are bid');
  assert.equal(bidGuardWhy(g, 'PE', 84_000, 499), 'only 499 contracts bid on PE 84000 -- the thin-bid guard sells only where 500 or more are bid');
  assert.equal(bidGuardWhy(g, 'PE', 84_000, 500), null, 'at the number: sold');
  assert.equal(bidGuardWhy(g, 'PE', 84_000, null), null);
  assert.equal(bidGuardWhy(g, 'PE', 84_000, undefined), null);
  assert.equal(bidGuardWhy({ bid: { on: false, min: 500 } }, 'PE', 84_000, 1), null, 'off');
});

test('the reasons are sorted into their own tabs: momentum (calls and puts), IV spike, thin bid', () => {
  const g = momentumGuardOf(JSON.stringify(ENTRY_GUARDS_TESTED));
  const said = (why: string) => signalReasons('skipped', `#1 Breakout BUY | ${why}`);
  assert.deepEqual(said(marketGuardWhy(g, 'PE', market({ perp: 89_270, hourAgo: 90_000 }))!), ['momentum']);
  assert.deepEqual(said(marketGuardWhy(g, 'CE', market({ perp: 90_360, hourAgo: 90_360, quarterAgo: 90_000 }))!), ['momentum']);
  assert.deepEqual(said(marketGuardWhy(g, 'CE', market({ ivNow: 0.46, ivHourAgo: 0.40 }))!), ['iv-spike']);
  assert.deepEqual(said(`${bidGuardWhy(g, 'CE', 92_000, 120)} · CE 91000 full (13 of 13): the next strike out`), ['thin-bid']);
});
