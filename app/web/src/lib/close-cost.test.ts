import { describe, expect, it } from 'vitest';
import { atMarkUsd, closeAll, closeCostUsd } from '@/lib/close-cost';

/**
 * Home's day at the mark against Positions' "if closed now" (4 Nov 2026). The figures of 07:10 IST that morning, account 1,
 * in dollars: a fresh short sold at the bid shows half the spread lost at the mark, the whole spread and the charges to
 * close it lost closed now -- and the gap between the two is exactly those.
 */
// Sold one at 45 (0.001 BTC), the book 44 / 47, the mark 45.5: at the mark −0.0005; bought back at 47 −0.002; entry and close charges.
const trade = (o: { realised?: number; unrealised: number | null; paid: number; toClose: number; ifClosed: number | null }) => ({
  realisedPnl: o.realised ?? 0,
  live: { markPrice: 45.5, unrealisedPnl: o.unrealised, decayed: null, netIfClosedUsd: o.ifClosed } as never,
  charges: { entryUsd: o.paid, exitUsd: 0, paidUsd: o.paid, toCloseUsd: o.toClose },
});

describe('close cost', () => {
  it('[critical] a trade at the mark is booked + open at the mark − charges paid; closing it costs the spread to the ask and the charges to close', () => {
    // At the ask: 45 − 47 = −0.002; less 0.0016 paid and 0.0017 to close.
    const t = trade({ unrealised: -0.0005, paid: 0.0016, toClose: 0.0017, ifClosed: -0.002 - 0.0016 - 0.0017 });
    expect(atMarkUsd(t)).toBeCloseTo(-0.0021, 12);
    // The spread from the mark to the ask (0.0015) and the charges to close (0.0017).
    expect(closeCostUsd(t)).toBeCloseTo(0.0015 + 0.0017, 12);
  });

  it('[critical] what a trade booked before -- a part bought back -- is on both sides, never in the gap', () => {
    const t = trade({ realised: 0.004, unrealised: -0.0005, paid: 0.0016, toClose: 0.0017, ifClosed: 0.004 - 0.002 - 0.0016 - 0.0017 });
    expect(closeCostUsd(t)).toBeCloseTo(0.0032, 12);
  });

  it('[critical] every open trade together; one without a mark or a close figure is left out of both, and counted out', () => {
    const a = trade({ unrealised: -0.0005, paid: 0.0016, toClose: 0.0017, ifClosed: -0.0053 });
    const b = trade({ unrealised: 0.01, paid: 0.002, toClose: 0.001, ifClosed: 0.006 });
    const all = closeAll([a, b, trade({ unrealised: null, paid: 0.002, toClose: 0.001, ifClosed: -0.01 }), trade({ unrealised: 0.01, paid: 0.002, toClose: 0.001, ifClosed: null })]);
    expect(all.priced).toBe(2);
    expect(all.atMarkUsd).toBeCloseTo(-0.0021 + 0.008, 12);
    expect(all.closedUsd).toBeCloseTo(-0.0053 + 0.006, 12);
    expect(all.costUsd).toBeCloseTo(all.atMarkUsd - all.closedUsd, 12);
    expect(closeAll([])).toEqual({ atMarkUsd: 0, closedUsd: 0, costUsd: 0, priced: 0 });
  });
});
