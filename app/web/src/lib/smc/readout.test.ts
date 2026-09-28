import { describe, expect, it } from 'vitest';
import { runSmc } from './engine';
import { readout } from './readout';
import type { TfRead } from './context';
import { walk } from '@/test/bars';

const bars = walk(3 * 288, 18);
const full = runSmc(bars, { tfSec: 300 });

/** The chart as it was at a candle where a setup was READY and not yet filled. */
function atReady() {
  for (const s of full.setups) {
    const ready = s.events.find((e) => e.state === 'READY');
    const next = s.events[s.events.indexOf(ready!) + 1];
    if (ready && (!next || next.at > ready.at)) {
      const past = bars.slice(0, ready.at + 1);
      return { st: runSmc(past, { tfSec: 300 }), past, dir: s.dir };
    }
  }
  throw new Error('no READY setup in the fixture');
}

const ctx = (role: TfRead['role'], trend: TfRead['trend']): TfRead => ({ tf: role === 'Bias' ? '30M' : '15M', role, trend, last: null });

describe('readout', () => {
  it('with no setup, says what the next one needs rather than naming a price it will reach', () => {
    const r = readout(runSmc(bars.slice(0, 5), { tfSec: 300 }), bars.slice(0, 5));
    expect(r.tone).toBe('flat');
    expect(r.headline).toMatch(/^NO TRADE/);
    expect(r.detail).toMatch(/sweep → .*CHoCH/);
  });

  it('a ready setup carries its plan and its confirmations', () => {
    const { st, past, dir } = atReady();
    const r = readout(st, past);
    expect(r.headline).toContain(dir === 'bull' ? 'LONG' : 'SHORT');
    expect(r.plan?.targets).toHaveLength(3);
    expect(r.blocked).toEqual([]);
  });

  it('[critical] a setup against the 30M bias or the 15M structure is not a trade', () => {
    const { st, past, dir } = atReady();
    const against = dir === 'bull' ? 'bear' : 'bull';
    const r = readout(st, past, [ctx('Bias', against), ctx('Structure', dir)]);
    expect(r.headline).toMatch(/^NO TRADE — (long|short) setup against 30M bias/);
    expect(r.tone).toBe('flat');
    expect(r.blocked).toHaveLength(1);
  });

  it('agreeing context, or a timeframe that is not a gate, does not block it', () => {
    const { st, past, dir } = atReady();
    const against = dir === 'bull' ? 'bear' : 'bull';
    const r = readout(st, past, [ctx('Bias', dir), ctx('Structure', dir), { tf: '1M', role: 'Trigger', trend: against, last: null }]);
    expect(r.blocked).toEqual([]);
  });
});
