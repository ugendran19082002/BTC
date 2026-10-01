import { describe, expect, it } from 'vitest';
import { overlayOf } from './parts';
import type { MethodRead, SetupClock } from '@/types/entry';

const read = (paper: Partial<SetupClock> | null): MethodRead => ({
  id: 'vwap-reversion', n: 10, code: '10', name: 'VWAP / mean reversion', group: 'reversal', summary: '', mode: 'single', tf: '5m', dir: 'short', state: 'TRADE',
  steps: [], gates: [], score: 40, scoreParts: [], alignment: null, reason: '', triggerTime: 1,
  plan: { entryLo: 83_589, entryHi: 83_605, stop: 83_677, tp1: 83_507, tp2: null, tp3: null, tpWhy: [], rr: 1 },
  paper: paper === null ? null : ({ status: 'open', ...paper } as SetupClock),
});

describe('the setup drawn on the chart', () => {
  it('[critical] says where it stands in the paper log: levels are where the order rests, not a position', () => {
    expect(overlayOf(read({ status: 'open' }), true)!.label).toBe('#10 VWAP / mean reversion (5m) · waiting for fill');
    expect(overlayOf(read({ status: 'expired', expireWhy: 'target' }), true)!.label).toBe('#10 VWAP / mean reversion (5m) · EXPIRED (ran to TGT1 unfilled)');
    expect(overlayOf(read({ status: 'expired', expireWhy: 'window' }), true)!.label).toMatch(/· expired unfilled$/);
    expect(overlayOf(read({ status: 'filled' }), true)!.label).toMatch(/· filled$/);
    expect(overlayOf(read(null), true)!.label).toBe('#10 VWAP / mean reversion (5m)');
  });
});
