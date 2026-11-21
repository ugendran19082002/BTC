import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MS, SessionLossGuard, type RecomputeAnswer, type SessionHit, type SessionLoss } from '../../src/trading/session-loss.js';
import { USDINR } from '../../src/domain/score.js';

/**
 * The session's limit worked out again by hand (owner, 20 Nov 2026): Low's lots went from 1 to 2 at 07:05, five
 * minutes into its 07:00 session, and the limit stayed the 1-lot figure. `recompute` works it out again from the lots
 * traded now, keeps it for the session -- across a restart -- and refuses whatever would hurt.
 */

const at = (hhmm: string, day = '2026-11-20') => Date.parse(`${day}T${hhmm}:00+05:30`);
const PCT: SessionLoss = { on: true, sessions: [{ from: '07:00', to: '15:00', limit: 18, unit: 'pct' }] };
/** 18% of $100 (one lot) and of $200 (two lots), in rupees. */
const ONE_LOT = 0.18 * 100 * USDINR;
const TWO_LOTS = 0.18 * 200 * USDINR;

function rig(setting: SessionLoss = PCT, o: { kept?: Map<string, number>; written?: SessionHit[] } = {}) {
  let now = at('07:00');
  let netUsd = 0;
  let modelUsd: number | null = 100;
  const kept = o.kept ?? new Map<string, number>();
  const written = o.written ?? [];
  const told: Extract<RecomputeAnswer, { ok: true }>[] = [];
  const squared: number[] = [];
  const guard = new SessionLossGuard({
    now: () => now,
    rule: () => setting,
    // At the session's start the base is the 1-lot model; Delta's measured margin later would be another figure.
    pctBaseUsd: async () => 100,
    pctModelUsd: async () => modelUsd,
    netUsd: async () => netUsd,
    netUsdAt: async () => 0,
    squareOff: async () => { squared.push(now); return { closed: ['a'], cancelled: [], failed: [] }; },
    fixedLimit: { get: async (k) => kept.get(k) ?? null, set: async (k, v) => { kept.clear(); kept.set(k, v); } },
    record: async (h) => { written.push(h); },
    hitsOn: async (day) => written.filter((h) => h.day === day),
    said: () => {},
    recomputed: (r) => { told.push(r); },
  });
  return {
    guard, kept, told, squared, written,
    set: (t: string, lossInr: number) => { now = at(t); netUsd = -lossInr / USDINR; },
    move: (ms: number) => { now += ms; },
    lots: (n: number | null) => { modelUsd = n === null ? null : 100 * n; },
  };
}

test('[critical] the 1-lot limit worked out again with 2 lots: previewed without a change, then kept', async () => {
  const r = rig();
  r.set('07:00', 0);
  await r.guard.tick();
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(ONE_LOT), 'the session starts on the 1-lot line');
  r.lots(2);
  r.set('07:06', 120);
  const p = await r.guard.recomputePreview();
  assert.ok(p.ok);
  assert.equal(Math.round(p.beforeInr!), Math.round(ONE_LOT));
  assert.equal(Math.round(p.afterInr), Math.round(TWO_LOTS));
  assert.equal(Math.round(p.lossInr), 120);
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(ONE_LOT), 'a preview changes nothing');
  assert.equal(r.told.length, 0);

  const done = await r.guard.recompute();
  assert.ok(done.ok);
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(TWO_LOTS));
  assert.equal(r.told.length, 1, 'said once: the phone, the log');
  assert.equal(Math.round(r.kept.get('2026-11-20|07:00|pct:18')!), Math.round(TWO_LOTS), 'kept for a restart');
  r.set('07:07', 130);
  await r.guard.tick();
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(TWO_LOTS), 'the next look keeps it');
});

test('[critical] a restart in the session reads the worked-out limit back, not the 1-lot one', async () => {
  const kept = new Map<string, number>();
  const a = rig(PCT, { kept });
  a.set('07:00', 0); await a.guard.tick();
  a.lots(2); a.set('07:06', 0); await a.guard.recompute();
  const b = rig(PCT, { kept });
  b.set('07:10', 50);
  await b.guard.tick();
  assert.equal(Math.round(b.guard.status()!.limitInr!), Math.round(TWO_LOTS));
});

test('[critical] squared off at the new limit, not the old one', async () => {
  const r = rig();
  r.set('07:00', 0); await r.guard.tick();
  r.lots(2); r.set('07:06', 0); await r.guard.recompute();
  r.set('08:00', ONE_LOT + 200);
  await r.guard.tick();
  r.move(HOLD_MS + 1_000);
  await r.guard.tick();
  assert.deepEqual(r.squared, [], 'over the 1-lot line, under the 2-lot one: still trading');
  r.set('09:00', TWO_LOTS + 10);
  await r.guard.tick();
  r.move(HOLD_MS + 1_000);
  await r.guard.tick();
  assert.equal(r.squared.length, 1);
});

test('[critical] refused when the loss so far is at the new limit: it would square the account off at once', async () => {
  const r = rig();
  r.lots(2);
  r.set('07:00', 0); await r.guard.tick();
  // Lots taken down to 1 after a bad start: the new line is under what is already lost.
  r.lots(1);
  r.set('07:30', ONE_LOT + 50);
  const a = await r.guard.recompute();
  assert.equal(a.ok, false);
  assert.match((a as { reason: string }).reason, /square the account off at once/);
  assert.equal(r.told.length, 0);
  assert.deepEqual(r.squared, []);
});

test('[critical] refused on a day already squared off: a recompute never opens a stopped account', async () => {
  const written: SessionHit[] = [{ day: '2026-11-20', from: '07:00', to: '15:00', limitInr: 1_000, lossInr: 1_100, at: at('07:30'), closed: 3, cancelled: 0, failed: 0, detail: '' }];
  const r = rig(PCT, { written });
  await r.guard.restore(at('07:40'));
  r.lots(2); r.set('07:40', 0);
  const a = await r.guard.recompute();
  assert.equal(a.ok, false);
  assert.match((a as { reason: string }).reason, /Stopped for today/);
  assert.ok(r.guard.entryBlock(at('07:41')), 'still stopped');
});

test('refused outside a session, for a rupee limit, before the session is read, and with nothing to work from', async () => {
  const r = rig();
  r.set('06:59', 0);
  assert.match(((await r.guard.recompute()) as { reason: string }).reason, /No session is running/);

  const inr = rig({ on: true, sessions: [{ from: '07:00', to: '15:00', limit: 1_000, unit: 'inr' }] });
  inr.set('07:00', 0); await inr.guard.tick();
  assert.match(((await inr.guard.recompute()) as { reason: string }).reason, /amount in rupees/);

  const early = rig();
  early.set('07:00', 0);
  assert.match(((await early.guard.recompute()) as { reason: string }).reason, /still being read/);

  const none = rig();
  none.set('07:00', 0); await none.guard.tick();
  none.lots(null);
  assert.match(((await none.guard.recompute()) as { reason: string }).reason, /At most open/);
});

/* ---------------------------------------------- 21 Nov 2026: one formula, never lowered unasked --- */

test('[critical] a recompute that would LOWER the line is refused unless asked for in so many words; asked, it is made', async () => {
  const r = rig();
  r.lots(2);
  r.set('07:00', 0); await r.guard.tick();
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(TWO_LOTS));
  r.lots(1);
  r.set('07:30', 100);
  const p = await r.guard.recomputePreview();
  assert.ok(p.ok && p.lowers, 'the preview says it lowers');
  const plain = await r.guard.recompute();
  assert.equal(plain.ok, false);
  assert.match((plain as { reason: string }).reason, /would LOWER the limit from ₹3,060 to ₹1,530/);
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(TWO_LOTS), 'nothing changed');
  const asked = await r.guard.recompute(undefined, { lower: true });
  assert.ok(asked.ok && asked.lowers);
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(ONE_LOT));
});

test('nothing to change: said, not a press that moves the line by a rupee', async () => {
  const r = rig();
  r.set('07:00', 0); await r.guard.tick();
  const a = await r.guard.recompute();
  assert.equal(a.ok, false);
  assert.match((a as { reason: string }).reason, /^Already ₹1,530/);
  assert.equal(r.told.length, 0);
});

test('[critical] one formula: the session\'s start and a rule changed in it are worked out as a recompute is -- the model × the lots set', async () => {
  // The model says two lots ($200); the other base would say $100. Both the start and a rule change follow the model.
  const setting: SessionLoss = { on: true, sessions: [{ from: '07:00', to: '15:00', limit: 18, unit: 'pct' }] };
  const r = rig(setting);
  r.lots(2);
  r.set('07:00', 0); await r.guard.tick();
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(TWO_LOTS), 'the start: the model');
  setting.sessions[0]!.limit = 19;
  r.set('09:46', 0); await r.guard.tick();
  assert.equal(Math.round(r.guard.status()!.limitInr!), Math.round(0.19 * 200 * USDINR), 'a rule changed in the session: the model too');
  assert.match(((await r.guard.recompute()) as { reason: string }).reason, /^Already/, 'and a recompute right after agrees -- no ₹3,856 then ₹3,158');
});
