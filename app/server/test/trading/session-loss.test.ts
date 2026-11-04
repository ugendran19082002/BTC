import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusalAlerts } from '../../src/strategy/runner.js';
import { BASELINE_LIVE_MS, HOLD_MS, SESSION_LOSS_OFF, SessionLossGuard, parseSessionLoss, sessionAt, sessionLossProblems, type SessionHit, type SessionLoss } from '../../src/trading/session-loss.js';
import { precheck } from '../../src/trading/precheck.js';
import { USDINR } from '../../src/domain/score.js';

/**
 * The session loss limit (owner, 4 Nov 2026): an hour of the day, say, with a limit in rupees on an account; lost that
 * much since the session began -- booked and open, less charges -- held for `HOLD_MS`, the account is squared off and
 * takes no new entry for the rest of the day; the next day it trades as usual. Off with none until set.
 */

const at = (hhmm: string, day = '2026-11-04') => Date.parse(`${day}T${hhmm}:00+05:30`);
const S = (from: string, to: string, limitInr: number) => ({ from, to, limit: limitInr, unit: 'inr' as const });
const P = (from: string, to: string, pct: number) => ({ from, to, limit: pct, unit: 'pct' as const });

test('the setting checked in words; one that will not read is off', () => {
  assert.deepEqual(sessionLossProblems({ on: true, sessions: [S('07:00', '08:00', 1000), S('08:00', '09:00', 500)] }), []);
  assert.match(sessionLossProblems({ on: true, sessions: [S('08:00', '07:00', 1000)] }).join(), /end after it starts/);
  assert.match(sessionLossProblems({ on: true, sessions: [S('07:00', '08:30', 1000), S('08:00', '09:00', 1)] }).join(), /overlap/);
  assert.match(sessionLossProblems({ on: true, sessions: [S('7:00', '08:00', 1000)] }).join(), /HH:MM/);
  assert.match(sessionLossProblems({ on: true, sessions: [S('07:00', '08:00', 0)] }).join(), /above 0/);
  assert.match(sessionLossProblems({ on: true, sessions: [P('07:00', '08:00', 101)] }).join(), /100% of the "At most open" margin/);
  assert.match(sessionLossProblems({ on: true, sessions: [{ from: '07:00', to: '08:00', limit: 5, unit: 'usd' }] }).join(), /₹ or %/);
  assert.deepEqual(sessionLossProblems({ on: true, sessions: [P('07:00', '08:00', 2.5)] }), []);
  assert.match(sessionLossProblems({ on: 'yes', sessions: [] }).join(), /on or off/);
  assert.deepEqual(parseSessionLoss(null), SESSION_LOSS_OFF);
  assert.deepEqual(parseSessionLoss('not json'), SESSION_LOSS_OFF);
  assert.deepEqual(parseSessionLoss(JSON.stringify({ on: true, sessions: [S('09:00', '10:00', 2), S('07:00', '08:00', 1)] })).sessions.map((s) => s.from), ['07:00', '09:00']);
});

test('the session a moment falls in: its start counted, its end not', () => {
  const rules = [S('07:00', '08:00', 1000), S('08:00', '09:00', 500)];
  assert.equal(sessionAt(rules, at('06:59')), null);
  assert.deepEqual(sessionAt(rules, at('07:00')), { rule: rules[0], startMs: at('07:00'), endMs: at('08:00') });
  assert.equal(sessionAt(rules, at('07:59'))!.rule.from, '07:00');
  assert.equal(sessionAt(rules, at('08:00'))!.rule.from, '08:00');
  assert.equal(sessionAt(rules, at('09:00')), null);
});

/** A guard on a clock and a day's net the test moves by hand. */
function rig(setting: SessionLoss, o: { baselineUsd?: number | null; written?: SessionHit[]; baseUsd?: number | null } = {}) {
  let now = at('07:00');
  let netUsd = 0;
  const squared: number[] = [];
  const written: SessionHit[] = o.written ?? [];
  const said: SessionHit[] = [];
  const asked: number[] = [];
  const guard = new SessionLossGuard({
    now: () => now,
    rule: () => setting,
    pctBaseUsd: async () => (o.baseUsd === undefined ? 1_000 : o.baseUsd),
    netUsd: async () => netUsd,
    netUsdAt: async (t) => { asked.push(t); return o.baselineUsd === undefined ? 0 : o.baselineUsd; },
    squareOff: async () => { squared.push(now); return { closed: ['a', 'b'], cancelled: ['c'], failed: [] }; },
    record: async (h) => { written.push(h); },
    hitsOn: async (day) => written.filter((h) => h.day === day),
    said: (h) => { said.push(h); },
  });
  return {
    guard, squared, written, said, asked,
    set: (t: string, lossInr: number) => { now = at(t); netUsd = (o.baselineUsd ?? 0) - lossInr / USDINR; },
    move: (ms: number) => { now += ms; },
  };
}

test('[critical] at the limit, held for its seconds: squared off once, and no new entry for the rest of the day', async () => {
  const r = rig({ on: true, sessions: [S('07:00', '08:00', 1000), S('09:00', '10:00', 1000)] }, { baselineUsd: 20 });
  r.set('07:10', 400);
  assert.equal(await r.guard.tick(), null);
  assert.deepEqual(r.asked, [at('07:00')], 'the day\'s figure read as at the session\'s start');
  assert.equal(Math.round(r.guard.status()!.lossInr!), 400);
  // At the limit: held first, so a flicker is not a square-off.
  r.set('07:20', 1_050);
  assert.equal(await r.guard.tick(), null);
  assert.ok(r.guard.status()!.breachSince);
  r.move(HOLD_MS - 1_000);
  assert.equal(await r.guard.tick(), null);
  // Back under it: the hold starts again.
  r.set('07:21', 900);
  await r.guard.tick();
  assert.equal(r.guard.status()!.breachSince, null);
  r.set('07:30', 1_200);
  await r.guard.tick();
  r.move(HOLD_MS);
  const hit = await r.guard.tick();
  assert.ok(hit);
  assert.deepEqual([hit.from, hit.to, hit.limitInr, Math.round(hit.lossInr), hit.closed, hit.cancelled, hit.failed], ['07:00', '08:00', 1000, 1200, 2, 1, 0]);
  assert.equal(r.squared.length, 1);
  assert.equal(r.written.length, 1);
  assert.equal(r.said.length, 1);
  assert.match(r.guard.entryBlock()!, /07:00–08:00 session lost ₹1,200.*no new entry today/);
  // The rest of the day: stopped, and not squared off again -- the next session included.
  r.move(5_000);
  assert.equal(await r.guard.tick(), null);
  r.set('09:30', 5_000);
  assert.equal(await r.guard.tick(), null);
  assert.equal(r.squared.length, 1);
  assert.ok(r.guard.entryBlock(at('23:59')));
  // The next day: as usual.
  assert.equal(r.guard.entryBlock(at('00:00', '2026-11-05')), null);
});

test('off, or outside every session: nothing read, nothing done', async () => {
  const off = rig({ on: false, sessions: [S('07:00', '08:00', 1)] });
  off.set('07:10', 99_999);
  off.move(HOLD_MS * 2);
  assert.equal(await off.guard.tick(), null);
  assert.deepEqual([off.asked.length, off.squared.length], [0, 0]);
  assert.equal(off.guard.status(), null);
  const outside = rig({ on: true, sessions: [S('07:00', '08:00', 1)] });
  outside.set('08:30', 99_999);
  assert.equal(await outside.guard.tick(), null);
  assert.equal(outside.asked.length, 0);
});

test('a profit booked before the session is not spent by it: the loss is from the session\'s start', async () => {
  // ₹2,000 up at 07:00; ₹1,500 up at 07:30 -- a session loss of ₹500, under a ₹1,000 limit, though the day is still up.
  const r = rig({ on: true, sessions: [S('07:00', '08:00', 1000)] }, { baselineUsd: 2000 / USDINR });
  r.set('07:30', 500);
  await r.guard.tick();
  assert.equal(Math.round(r.guard.status()!.lossInr!), 500);
  assert.equal(r.squared.length, 0);
});

test('[critical] a limit in per cent: of the max-open margin as it stood when the session began, fixed for the session', async () => {
  // 2% of $1,000 (max open 200 × $5, say): ₹1,700 at ₹85.
  const r = rig({ on: true, sessions: [P('07:00', '08:00', 2)] }, { baseUsd: 1_000 });
  r.set('07:10', 1_600);
  await r.guard.tick();
  assert.equal(r.guard.status()!.limitInr, 1_700);
  assert.equal(r.squared.length, 0);
  r.set('07:20', 1_750);
  await r.guard.tick();
  r.move(HOLD_MS);
  const hit = await r.guard.tick();
  assert.ok(hit);
  assert.equal(hit.limitInr, 1_700);
  // No max open set (or no price to price the margin): no line yet, nothing squared off on a guess.
  const blind = rig({ on: true, sessions: [P('07:00', '08:00', 2)] }, { baseUsd: null });
  blind.set('07:10', 999_999);
  await blind.guard.tick();
  blind.move(HOLD_MS * 2);
  assert.equal(await blind.guard.tick(), null);
  assert.equal(blind.guard.status()!.limitInr, null);
});

test('[critical] a restart the same day stays stopped; the next day does not', async () => {
  const written: SessionHit[] = [{ day: '2026-11-04', from: '07:00', to: '08:00', limitInr: 1000, lossInr: 1100, at: at('07:40'), closed: 3, cancelled: 0, failed: 0, detail: '' }];
  const r = rig({ on: true, sessions: [S('07:00', '08:00', 1000)] }, { written });
  r.set('10:00', 0);
  await r.guard.restore();
  assert.match(r.guard.entryBlock()!, /07:00–08:00 session lost ₹1,100/);
  const next = rig({ on: true, sessions: [S('07:00', '08:00', 1000)] }, { written });
  next.set('07:05', 0);
  next.move(86_400_000);
  await next.guard.restore();
  assert.equal(next.guard.entryBlock(), null);
});

test('[critical] the session\'s starting figure: the live one when read at its start; the day\'s line after a restart', async () => {
  // The line says $50 at 07:00; the live sum says $40 -- the same moment valued two ways.
  const live = rig({ on: true, sessions: [S('07:00', '08:00', 1000)] }, { baselineUsd: 50 });
  live.set('07:00', 850);                 // live net: $50 − ₹850 = $40
  live.move(5_000);
  await live.guard.tick();
  assert.equal(live.asked.length, 0, 'read at the start: the line is not asked');
  assert.equal(live.guard.status()!.lossInr, 0);
  live.set('07:20', 850 + 425);           // $5 more lost since
  await live.guard.tick();
  assert.equal(Math.round(live.guard.status()!.lossInr!), 425);
  // A restart at 07:20: past the first seconds, so the start is the line's.
  const late = rig({ on: true, sessions: [S('07:00', '08:00', 1000)] }, { baselineUsd: 50 });
  late.set('07:20', 425);
  assert.ok(at('07:20') - at('07:00') > BASELINE_LIVE_MS);
  await late.guard.tick();
  assert.deepEqual(late.asked, [at('07:00')]);
  assert.equal(Math.round(late.guard.status()!.lossInr!), 425);
});

test('a day stopped by the limit says each refused signal nowhere: its own alert said it once', () => {
  assert.equal(refusalAlerts({ ok: false, failures: [{ code: 'SESSION_LOSS_LIMIT' }] }), false);
  assert.equal(refusalAlerts({ ok: false, failures: [{ code: 'STALE_QUOTE' }] }), true);
  assert.equal(refusalAlerts(null), true);
});

test('[critical] a new entry the day is stopped is refused by the order gate, in words', () => {
  const base = {
    now: Date.now(), intent: { side: 'sell' as const, size: 1, price: 10, reduceOnly: false, leverage: 10 },
    spot: 76_000, product: null, quote: null, feedHealthy: true, tradingEnabled: true, account: { availableUsd: 1000 },
    existingPosition: 0, totalShortContracts: 0, dayPnlUsd: 0, worstCaseLossUsd: 1,
    limits: {} as never,
  };
  const r = precheck({ ...base, entryBlock: 'The 07:00–08:00 session lost ₹1,200 …' } as never);
  assert.ok(!r.ok && r.failures.some((f) => f.code === 'SESSION_LOSS_LIMIT' && f.message.includes('07:00–08:00')));
  const free = precheck({ ...base, entryBlock: null } as never);
  assert.ok(free.ok || !free.failures.some((f) => f.code === 'SESSION_LOSS_LIMIT'));
});
