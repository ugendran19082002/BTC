import { describe, expect, it } from 'vitest';
import { topByEv, otmPct, failing, signalReason, SIGNAL_LABEL } from '@/lib/ev-view';
import type { Leg } from '@/types/desk';

/**
 * Ordering and wording only. The decision — sell, watch or avoid — was made on
 * the server, and the one thing worth pinning here is that this side never
 * second-guesses it: a strike the server refused must not reappear in a list
 * headed "best to sell" because its number happened to be large.
 */

/** `tier` follows the signal unless a test says otherwise: it is what ranks. */
const leg = (
  strike: number,
  signal: Leg['ev']['signal'],
  evUsd: number | null,
  checks: Leg['ev']['checks'] = [],
  over: Partial<Leg['ev']> = {},
): Leg =>
  ({
    cp: 'C',
    strike,
    ev: {
      evUsd, signal, checks, evPerBtc: evUsd, volumeToOi: 0.2,
      tier: signal === 'sell' ? 'candidate' : signal,
      score: 70,
      ...over,
    },
  }) as unknown as Leg;

describe('ranking by expected value', () => {
  it('puts the richest first', () => {
    const ranked = topByEv([
      leg(79_000, 'sell', 12),
      leg(79_400, 'sell', 31),
      leg(79_200, 'sell', 20),
    ]);
    expect(ranked.map((l) => l.strike)).toEqual([79_400, 79_200, 79_000]);
  });

  it('[critical] never ranks a strike the server refused, however big the number', () => {
    const ranked = topByEv([
      leg(79_400, 'sell', 12),
      leg(82_000, 'avoid', 99),
    ]);
    expect(ranked.map((l) => l.strike)).toEqual([79_400]);
  });

  it('[critical] keeps a thin strike, below the clear ones — dropping them emptied the card', () => {
    // At this distance almost every genuine candidate fails the liquidity rule,
    // so ranking `sell` alone left the card reading "nothing qualifies".
    const ranked = topByEv([
      leg(81_000, 'watch', 50),
      leg(79_400, 'sell', 12),
    ]);
    expect(ranked.map((l) => l.strike)).toEqual([79_400, 81_000]);
  });

  it('skips a strike with no expected value to rank on', () => {
    expect(topByEv([leg(79_000, 'sell', null)])).toHaveLength(0);
  });

  it('stops at five, so the card never grows a scrollbar of its own', () => {
    const many = Array.from({ length: 9 }, (_, i) => leg(79_000 + i * 200, 'sell', i));
    expect(topByEv(many)).toHaveLength(5);
    expect(topByEv(many, 3)).toHaveLength(3);
  });
});

describe('distance to the strike', () => {
  it('is the same percentage either side of spot', () => {
    expect(otmPct(80_000, 77_000)).toBeCloseTo((3_000 / 77_000) * 100, 10);
    expect(otmPct(74_000, 77_000)).toBeCloseTo((3_000 / 77_000) * 100, 10);
  });

  it('has no answer without a price to measure from', () => {
    expect(otmPct(80_000, 0)).toBeNull();
  });
});

describe('saying why', () => {
  const bad = leg(80_000, 'avoid', -4, [
    { ok: true, severity: 'block', text: 'Pays $18.00, at or above the $10 floor.' },
    { ok: false, severity: 'warn', text: 'Traded only 0.2% of its open interest today.' },
    { ok: false, severity: 'block', text: 'Negative expected value.' },
  ]);

  it('lists only the rules that are failing, the hard ones first', () => {
    expect(failing(bad).map((c) => c.text)).toEqual([
      'Negative expected value.',
      'Traded only 0.2% of its open interest today.',
    ]);
  });

  it('says so plainly when nothing is wrong', () => {
    const good = leg(79_000, 'sell', 20, [{ ok: true, severity: 'block', text: 'fine' }]);
    expect(signalReason(good)).toBe('Every eligibility rule is clear.');
  });

  it('joins the failures into one line a tooltip can carry', () => {
    expect(signalReason(bad)).toContain('Negative expected value.');
    expect(signalReason(bad)).toContain('open interest');
  });
});

describe('labels', () => {
  it('are the words a trader reads, not the keys', () => {
    expect(SIGNAL_LABEL).toEqual({ sell: 'Sell', watch: 'Watch', avoid: 'Avoid' });
  });
});
