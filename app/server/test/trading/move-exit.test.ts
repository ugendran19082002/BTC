import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOVE_EXIT_DEFAULT, MoveExitWatch, inMoveHours, moveExitProblems, moveExitWhy, movePicks, parseMoveExit, type MoveExit, type MovePick,
} from '../../src/trading/move-exit.js';

/**
 * The BTC-move exit (owner, 22 Nov 2026: "build panu best practice"): a sale whose strike is near BTC bought back when BTC
 * runs against it. The 30-day study (docs/research/2026-11-22-sl-jump-study.md) chose 0.8% in 10 minutes, strikes within
 * 1.5%: +₹17.9k, loss days 3 → 1, the 600%+ stops of 22 Nov 88 → 13.
 */

const ON: MoveExit = { on: true, pct: 0.8, minutes: 10, nearPct: 1.5 };
const T0 = 1_800_000_000_000;
const MIN = 60_000;
type Tr = { state: any; plan: any };
const sale = (id: string, side: 'CE' | 'PE', strike: number, o: { enteredAt?: number; position?: number; origin?: string; closing?: object; action?: string } = {}): Tr => ({
  state: { tradeId: id, position: o.position ?? -2, closing: o.closing ?? null, fills: [{ role: 'entry', side: 'sell', size: 2, price: 20, ts: o.enteredAt ?? T0 - 60 * MIN, orderId: 'x' }] },
  plan: { tradeId: id, origin: o.origin ?? 'strategy', optionSide: side, action: o.action, expect: { underlying: 'BTC', optionSide: side, strike, expiryTs: 0 } },
});
/** BTC at 59,726 ten minutes ago, at `now` now. */
const pxFrom = (then: number) => (ms: number) => (ms <= T0 - 5 * MIN ? then : null);

test('[critical] off by default; the setting is checked; anything that will not read is off', () => {
  assert.equal(MOVE_EXIT_DEFAULT.on, false);
  assert.deepEqual(parseMoveExit(null), MOVE_EXIT_DEFAULT);
  assert.deepEqual(parseMoveExit('not json'), MOVE_EXIT_DEFAULT);
  assert.deepEqual(parseMoveExit(JSON.stringify(ON)), { ...ON, from: null, to: null }, 'kept before the hours existed: all day');
  assert.deepEqual(moveExitProblems(ON), []);
  assert.match(moveExitProblems({ ...ON, pct: 9 }).join(' '), /BTC move is 0.2% to 5%/);
  assert.match(moveExitProblems({ ...ON, minutes: 2.5 }).join(' '), /whole minutes/);
  assert.match(moveExitProblems({ ...ON, nearPct: 0 }).join(' '), /How near/);
  assert.match(moveExitProblems({ ...ON, on: 'yes' }).join(' '), /on or off/);
  assert.deepEqual(parseMoveExit(JSON.stringify({ ...ON, pct: 9 })), MOVE_EXIT_DEFAULT);
});

test('[critical] BTC up 0.8% in 10 min: the calls near BTC are named -- not the far calls, not the puts', () => {
  const now = 60_206; // +0.80% on 59,726
  const trades = [
    sale('c-60200', 'CE', 60_200), sale('c-60400', 'CE', 60_400), sale('c-61000', 'CE', 61_000),
    sale('c-61400', 'CE', 61_400), sale('c-62000', 'CE', 62_000), sale('p-59400', 'PE', 59_400),
  ];
  const picks = movePicks(trades, ON, T0, now, pxFrom(59_726));
  assert.deepEqual(picks.map((p) => p.tradeId), ['c-60200', 'c-60400', 'c-61000'], 'within 1.5% of 60,206: up to ~61,109');
  assert.ok(picks.every((p) => p.side === 'CE' && p.movePct >= 0.8));
});

test('[critical] BTC down 0.8%: the puts near BTC are named; a move short of the rule names nothing', () => {
  const trades = [sale('p-59000', 'PE', 59_000), sale('p-58000', 'PE', 58_000), sale('c-59800', 'CE', 59_800)];
  assert.deepEqual(movePicks(trades, ON, T0, 59_248, pxFrom(59_726)).map((p) => p.tradeId), ['p-59000'], '−0.80%');
  assert.deepEqual(movePicks(trades, ON, T0, 59_300, pxFrom(59_726)), [], '−0.71%: under the rule');
});

test('[critical] the window starts at the entry at most: a move made before a sale was sold is not held against it', () => {
  const fresh = sale('c-new', 'CE', 60_200, { enteredAt: T0 - 2 * MIN });
  // BTC 59,726 ten minutes ago, 60,150 when the sale went on two minutes ago, 60,206 now: +0.09% since the sale.
  const px = (ms: number) => (ms <= T0 - 10 * MIN ? 59_726 : ms <= T0 - 2 * MIN ? 60_150 : null);
  assert.deepEqual(movePicks([fresh], ON, T0, 60_206, px), []);
});

test('[critical] left alone: a bought position, a trade by hand, one already closing, one flat; no price, no judgement', () => {
  const trades = [
    sale('long', 'CE', 60_200, { position: 2 }), sale('hand', 'CE', 60_200, { origin: 'manual' }),
    sale('closing', 'CE', 60_200, { closing: { all: true } }), sale('flat', 'CE', 60_200, { position: 0 }),
    sale('buy', 'CE', 60_200, { action: 'buy' }),
  ];
  assert.deepEqual(movePicks(trades, ON, T0, 60_206, pxFrom(59_726)), []);
  assert.deepEqual(movePicks([sale('c', 'CE', 60_200)], ON, T0, 60_206, () => null), [], 'the price then not known');
  assert.deepEqual(movePicks([sale('c', 'CE', 60_200)], { ...ON, on: false }, T0, 60_206, pxFrom(59_726)), [], 'off');
});

test('the close reason names the move, the strike and the distance -- History reads it as a BTC move', async () => {
  const p: MovePick = { tradeId: 'x', side: 'CE', strike: 60_400, movePct: 0.8036, fromPx: 59_726, nowPx: 60_206, nearPct: 0.32 };
  assert.equal(moveExitWhy(p, 10), 'btc move exit: BTC +0.80% in 10 min against the 60400 CE, 0.3% away');
  const { exitByOf } = await import('../../src/strategy/store.js');
  assert.equal(exitByOf(moveExitWhy(p, 10), null), 'btc-move');
});

/** A watch on a clock and a perp the test moves by hand; what it closes, and what it says. */
function watch(o: { setting?: MoveExit; trades?: Tr[]; atMinute?: (m: number) => number | null; hold?: Promise<void> } = {}) {
  let now = T0 - 12 * MIN;
  let perp: { price: number; at: number } | null = { price: 59_726, at: now };
  const closed: { ids: string[]; why: string[] }[] = [];
  const said: { closed: number }[] = [];
  const w = new MoveExitWatch({
    setting: () => o.setting ?? ON,
    openTrades: async () => o.trades ?? [sale('c-60400', 'CE', 60_400), sale('c-62000', 'CE', 62_000)],
    perpNow: () => perp,
    ...(o.atMinute ? { perpAtMinute: async (m: number) => o.atMinute!(m) } : {}),
    close: async (picks, why) => { closed.push({ ids: picks.map((p) => p.tradeId), why: picks.map(why) }); if (o.hold) await o.hold; return { closed: picks.map((p) => p.tradeId), failed: [] }; },
    said: (r) => { said.push({ closed: r.closed }); },
    now: () => now,
  });
  return { w, closed, said, at: (ms: number, px: number) => { now = ms; perp = { price: px, at: ms }; }, stale: (ms: number) => { now = ms; } };
}

test('[critical] the watch samples the perp and closes the near sales once BTC has run -- once, however many looks', async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const c = watch({ hold });
  for (let t = T0 - 12 * MIN; t <= T0 - 5 * MIN; t += MIN) { c.at(t, 59_726); assert.deepEqual(await c.w.tick(), []); }
  c.at(T0, 60_206);
  assert.deepEqual(await c.w.tick(), ['c-60400'], 'the near call; the far one left');
  c.at(T0 + 5_000, 60_250);
  assert.deepEqual(await c.w.tick(), [], 'still closing: not named again');
  release();
  await c.w.closesDone();
  assert.equal(c.closed.length, 1);
  assert.match(c.closed[0]!.why[0]!, /^btc move exit: BTC \+0\.8\d% in 10 min against the 60400 CE/);
  assert.deepEqual(c.said, [{ closed: 1 }]);
});

test('[critical] a stale perp judges nothing; off, nothing is closed', async () => {
  const c = watch();
  for (let t = T0 - 12 * MIN; t <= T0 - 5 * MIN; t += MIN) { c.at(t, 59_726); await c.w.tick(); }
  c.stale(T0 + 60_000);
  assert.deepEqual(await c.w.tick(), [], 'the socket last heard a minute ago');
  const off = watch({ setting: { ...ON, on: false } });
  off.at(T0, 61_000);
  assert.deepEqual(await off.w.tick(), []);
});

test('[critical] after a restart, a window older than the samples is read off the record\'s minute', async () => {
  const c = watch({ atMinute: (m) => (m <= T0 - 10 * MIN ? 59_726 : null) });
  c.at(T0, 60_206);
  assert.deepEqual(await c.w.tick(), ['c-60400']);
  const none = watch();
  none.at(T0, 60_206);
  assert.deepEqual(await none.w.tick(), [], 'nothing on record: nothing judged');
});

test('[critical] the desk closes them the session square-off\'s way, each with its own words, and keeps the setting', async () => {
  const { TradingService } = await import('../../src/trading/service.js');
  const { MemoryTradeStore } = await import('../../src/trading/engine.js');
  const { SettingsCache } = await import('../../src/db/settings.js');
  const { closePool } = await import('../../src/db/pool.js');
  try {
    const svc = new TradingService({ settings: await new SettingsCache().load(), store: new MemoryTradeStore() as never, notifier: null });
    const calls: { only: readonly string[] | undefined; whys: string[]; order: string }[] = [];
    (svc as unknown as { closeAll: (...a: unknown[]) => Promise<unknown> }).closeAll = async (only: any, why: any, order: any) => {
      calls.push({ only, whys: (only as string[]).map((id: string) => (typeof why === 'function' ? why(id) : why)), order });
      return { cancelled: [], closed: only, failed: [] };
    };
    const picks: MovePick[] = [
      { tradeId: 'a', side: 'CE', strike: 60_400, movePct: 0.81, fromPx: 59_726, nowPx: 60_210, nearPct: 0.3 },
      { tradeId: 'b', side: 'CE', strike: 60_800, movePct: 0.81, fromPx: 59_726, nowPx: 60_210, nearPct: 1.0 },
    ];
    const deps = (svc.moveExit as unknown as { d: { close: (p: MovePick[], w: (p: MovePick) => string) => Promise<{ closed: string[] }> } }).d;
    const out = await deps.close(picks, (p) => moveExitWhy(p, 10));
    assert.deepEqual(out.closed, ['a', 'b']);
    assert.equal(calls[0]!.order, 'worst-first');
    assert.deepEqual(calls[0]!.only, ['a', 'b']);
    assert.match(calls[0]!.whys[0]!, /against the 60400 CE/);
    assert.match(calls[0]!.whys[1]!, /against the 60800 CE/);
    // The setting: refused in words when it will not read; kept and read back when it will.
    assert.match((await svc.setMoveExit({ ...ON, pct: 7 }) as { reason: string }).reason, /0.2% to 5%/);
    const saved = await svc.setMoveExit({ on: true, pct: 1.0, minutes: 15, nearPct: 1.5 });
    assert.deepEqual(saved, { ok: true, moveExit: { on: true, pct: 1.0, minutes: 15, nearPct: 1.5, from: null, to: null } });
    assert.deepEqual(svc.moveExitSetting, { on: true, pct: 1.0, minutes: 15, nearPct: 1.5, from: null, to: null });
    // The hours kept as given (22 Nov 2026).
    await svc.setMoveExit({ on: true, pct: 0.8, minutes: 10, nearPct: 1.5, from: '12:00', to: '16:30' });
    assert.deepEqual(svc.moveExitSetting, { on: true, pct: 0.8, minutes: 10, nearPct: 1.5, from: '12:00', to: '16:30' });
    await svc.setMoveExit({ ...MOVE_EXIT_DEFAULT });
  } finally { await closePool(); }
});


/*
 * The hours it watches (owner, 22 Nov 2026: "from 12:00 time setting build panu"). Round 4 of the study: from 12:00,
 * +₹14.9k over 30 days with no day worse than now. The desk's day runs 17:30 to the 17:30 expiry, so "from 12:00" is
 * 12:00-17:30 on the day -- never the evening or the night before.
 */
const istAt = (hhmm: string, day = '2026-11-22') => Date.parse(`${day}T${hhmm}:00+05:30`);

test('[critical] offered from 12:00 when switched on; off until then', () => {
  assert.deepEqual(MOVE_EXIT_DEFAULT, { on: false, pct: 0.8, minutes: 10, nearPct: 1.5, from: '12:00', to: null });
});

test('[critical] from 12:00: watching 12:00 to the expiry -- not the morning, not the evening or night before', () => {
  const s = { from: '12:00', to: null };
  assert.equal(inMoveHours(s, istAt('11:59')), false);
  assert.equal(inMoveHours(s, istAt('12:00')), true);
  assert.equal(inMoveHours(s, istAt('17:29')), true);
  assert.equal(inMoveHours(s, istAt('18:00', '2026-11-21')), false, 'the evening before is the start of the day');
  assert.equal(inMoveHours(s, istAt('02:00')), false);
  assert.equal(inMoveHours({ from: '12:00', to: '16:30' }, istAt('16:29')), true);
  assert.equal(inMoveHours({ from: '12:00', to: '16:30' }, istAt('16:30')), false, 'until is not included');
  assert.equal(inMoveHours({ from: null, to: null }, istAt('18:00', '2026-11-21')), true, 'all day');
});

test('[critical] outside its hours nothing is named, however far BTC has run', () => {
  const sale = { state: { tradeId: 'c', position: -2, closing: null, fills: [{ role: 'entry', side: 'sell', size: 2, price: 20, ts: istAt('09:00'), orderId: 'x' }] }, plan: { tradeId: 'c', origin: 'strategy', optionSide: 'CE', expect: { underlying: 'BTC', optionSide: 'CE', strike: 60_400, expiryTs: 0 } } };
  const px = () => 59_726;
  const s = { ...ON, from: '12:00', to: null };
  assert.deepEqual(movePicks([sale as any], s, istAt('11:30'), 60_300, px), [], 'the morning');
  assert.equal(movePicks([sale as any], s, istAt('12:30'), 60_300, px).length, 1, 'from 12:00');
});

test('hours checked: a time, or none; from before until in the 17:30 day', () => {
  assert.deepEqual(moveExitProblems({ ...ON, from: '12:00', to: null }), []);
  assert.deepEqual(moveExitProblems({ ...ON, from: '12:00', to: '16:30' }), []);
  assert.deepEqual(moveExitProblems({ ...ON, from: '20:00', to: '02:00' }), [], 'an evening to the night after is in order in the 17:30 day');
  assert.match(moveExitProblems({ ...ON, from: '12' }).join(' '), /From is a time/);
  assert.match(moveExitProblems({ ...ON, to: '25:00' }).join(' '), /Until is a time/);
  assert.match(moveExitProblems({ ...ON, from: '16:30', to: '12:00' }).join(' '), /From must come before until/);
});
