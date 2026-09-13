import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suddenMove, expectedMoveOver, SHOCK_AT } from '../src/domain/shock.js';
import type { MarketRead } from '../src/market/moves.js';
import type { OptionStructure } from '../src/domain/structure.js';
import type { OiChange } from '../src/market/oi-history.js';

/**
 * Whether something is happening right now.
 *
 * The property worth more than the rest is the third test: a reading the desk
 * cannot take must score as *nothing*, never as calm. A desk that has been up
 * for one minute has no open-interest history and no volatility history, and a
 * score that counts those absences as zeros reports a quiet market on the
 * strength of not knowing — which is the one failure that would get somebody
 * short into a move.
 */

const SPOT = 77_000;
const IV = 0.30;

const market = (over: Partial<MarketRead> = {}): MarketRead =>
  ({
    spot: SPOT,
    agreement: 0,
    moves: [{ hours: 5 / 60, label: 'last 5m', changeUsd: 10, changePct: 0.01, rangeUsd: 20, rangePct: 0.03 }],
    volume: [{ tf: '5m', current: 100, median: 100, spike: 1 }],
    ...over,
  }) as unknown as MarketRead;

const structure = (over: Partial<OptionStructure> = {}): OptionStructure =>
  ({ ceOi: 1_000_000, peOi: 1_000_000, ceVolume: 5_000, peVolume: 5_000, pcrOi: 1, ...over }) as unknown as OptionStructure;

const base = {
  spot: SPOT,
  atmIv: IV,
  market: market(),
  structure: structure(),
  oiChanges: new Map<string, OiChange>(),
  iv: null,
};

// ---------------------------------------------------------------------------

test('the expected move is scaled to the window being asked about', () => {
  const twelveHours = expectedMoveOver(SPOT, IV, 12)!;
  const fiveMinutes = expectedMoveOver(SPOT, IV, 5 / 60)!;
  assert.ok(fiveMinutes < twelveHours / 10,
    'comparing a 5-minute move against a 12-hour expectation is how a violent tape reads as calm');
  assert.ok(Math.abs(twelveHours - SPOT * IV * Math.sqrt(12 / 8760)) < 1e-9);
});

test('there is no expected move without a volatility to price it from', () => {
  assert.equal(expectedMoveOver(SPOT, null, 1), null);
  assert.equal(expectedMoveOver(SPOT, 0, 1), null);
});

// ---------------------------------------------------------------------------

test('a quiet tape scores normal', () => {
  const s = suddenMove(base);
  assert.equal(s.band, 'normal');
  assert.ok(s.score !== null && s.score < SHOCK_AT.watch, `got ${s.score}`);
  assert.deepEqual(s.reasons, [], 'nothing is raised, so nothing is printed');
});

test('[critical] a reading it cannot take scores as nothing, not as calm', () => {
  // a desk one minute old: no open-interest history, no volatility history
  const young = suddenMove({ ...base, oiChanges: new Map(), iv: null });
  const unreadable = young.parts.filter((p) => p.note === null).map((p) => p.name);

  assert.deepEqual(unreadable, ['Volatility repricing', 'Open interest moving']);
  assert.ok(
    young.parts.filter((p) => p.note === null).every((p) => p.value === 0),
    'they contribute nothing rather than contributing calm',
  );
  assert.ok(
    !young.reasons.some((r) => /open interest|volatility/.test(r)),
    'and nothing is claimed about them either way',
  );
});

test('a board with nothing readable at all has no score', () => {
  const blind = suddenMove({
    ...base,
    atmIv: null,
    market: null,
    structure: structure({ pcrOi: null }),
  });
  assert.equal(blind.score, null);
  assert.equal(blind.band, 'normal');
});

// ---------------------------------------------------------------------------

test('[critical] a move far past what it was priced for is raised, and said', () => {
  const em5 = expectedMoveOver(SPOT, IV, 5 / 60)!;
  const s = suddenMove({
    ...base,
    market: market({
      moves: [{ hours: 5 / 60, label: 'last 5m', changeUsd: 0, changePct: 0, rangeUsd: em5 * 2.5, rangePct: 0 }],
    }),
  });
  assert.ok(s.score! > suddenMove(base).score!, 'it scores above the same board sitting still');
  assert.ok(s.reasons.some((r) => /5m range is 2\.5× what it was priced for/.test(r)), s.reasons.join(' | '));
});

test('a volume spike is raised at twice the median and not at one and a half', () => {
  const at = (spike: number) =>
    suddenMove({ ...base, market: market({ volume: [{ tf: '5m', current: spike * 100, median: 100, spike }] }) });

  assert.equal(at(1.5).reasons.length, 0);
  assert.ok(at(3.1).reasons.some((r) => r.includes('3.1× its median')));
});

test('volatility repricing counts upward only — a collapse is not a shock for a seller', () => {
  const up = suddenMove({ ...base, iv: { changePct: 6, overMinutes: 15 } });
  const down = suddenMove({ ...base, iv: { changePct: -6, overMinutes: 15 } });

  assert.ok(up.score! > down.score!, 'implied volatility expanding is the thing that hurts a short');
  assert.ok(up.reasons.some((r) => r.includes('up 6.0%')));
  assert.equal(down.reasons.length, 0);
});

test('open interest turning over is measured against the whole board', () => {
  const changes = new Map<string, OiChange>([
    ['C80000', { change: 150_000, changePct: 15, overMinutes: 60, spotChangePct: 1 }],
  ]);
  const s = suddenMove({ ...base, oiChanges: changes });
  // 150k against 2m open is 7.5%
  assert.ok(s.reasons.some((r) => r.includes('7.5% of open interest turned over in 60 minutes')), s.reasons.join(' | '));
});

test('lopsided reads the same either way round', () => {
  const calls = suddenMove({ ...base, structure: structure({ pcrOi: 0.44 }) });
  const puts = suddenMove({ ...base, structure: structure({ pcrOi: 1 / 0.44 }) });
  const part = (s: typeof calls) => s.parts.find((p) => p.name === 'One-sided positioning')!.value;
  assert.ok(Math.abs(part(calls) - part(puts)) < 1e-9, '0.44 and 2.27 are equally one-sided');
});

test('[critical] everything at once is a sudden move, with every reason named', () => {
  const em5 = expectedMoveOver(SPOT, IV, 5 / 60)!;
  const s = suddenMove({
    spot: SPOT,
    atmIv: IV,
    market: market({
      moves: [{ hours: 5 / 60, label: 'last 5m', changeUsd: -500, changePct: -0.65, rangeUsd: em5 * 3, rangePct: 0 }],
      volume: [{ tf: '5m', current: 400, median: 100, spike: 4 }],
      agreement: -5,
    }),
    structure: structure({ pcrOi: 0.4, ceVolume: 3_000, peVolume: 9_000 }),
    oiChanges: new Map([['C80000', { change: 400_000, changePct: 40, overMinutes: 30, spotChangePct: -1.5 }]]),
    iv: { changePct: 9, overMinutes: 15 },
  });

  assert.equal(s.band, 'sudden');
  assert.ok(s.score! >= SHOCK_AT.sudden, `got ${s.score}`);
  assert.equal(s.reasons.length, 5, 'all five are raised, and all five are printable');
  assert.equal(s.directionLabel, 'downside pressure');
  assert.ok(s.direction! < 0);
});

test('direction is its own question, not folded into the risk number', () => {
  const em5 = expectedMoveOver(SPOT, IV, 5 / 60)!;
  const violentUp = {
    ...base,
    market: market({
      moves: [{ hours: 5 / 60, label: 'last 5m', changeUsd: 500, changePct: 0.65, rangeUsd: em5 * 3, rangePct: 0 }],
      agreement: 5,
    }),
    structure: structure({ ceVolume: 9_000, peVolume: 3_000 }),
  };
  const violentDown = {
    ...violentUp,
    market: market({
      moves: [{ hours: 5 / 60, label: 'last 5m', changeUsd: -500, changePct: -0.65, rangeUsd: em5 * 3, rangePct: 0 }],
      agreement: -5,
    }),
    structure: structure({ ceVolume: 3_000, peVolume: 9_000 }),
  };

  const up = suddenMove(violentUp);
  const down = suddenMove(violentDown);
  assert.equal(up.score, down.score, 'the same violence scores the same whichever way it points');
  assert.ok(up.direction! > 0.3 && down.direction! < -0.3);
});

test('a tape pushing nowhere says so rather than picking a side', () => {
  assert.equal(suddenMove(base).directionLabel, 'no clear side');
});

test('the parts carry their own figures, so the score can be argued with', () => {
  const s = suddenMove({ ...base, iv: { changePct: 4.2, overMinutes: 15 } });
  const iv = s.parts.find((p) => p.name === 'Volatility repricing')!;
  assert.equal(iv.note, '+4.2% over 15m');
  assert.ok(s.parts.every((p) => p.weight > 0 && p.value >= 0 && p.value <= 1));
});
