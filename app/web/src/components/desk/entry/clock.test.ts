import { describe, expect, it } from 'vitest';
import { clockText, lag, span } from './clock';

describe('the entry clocks', () => {
  it('a span as a counter, never below zero', () => {
    expect([span(42_000), span(12 * 60_000 + 3_000), span(3_849_000), span(-5_000)]).toEqual(['0:42', '12:03', '1:04:09', '0:00']);
  });

  it('a lag after the bar closed', () => {
    expect([lag(3_000), lag(64_000), lag(120_000), lag(-200)]).toEqual(['+3 s', '+1 min 4 s', '+2 min', '+0 s']);
  });

  it('[critical] where a TRADE stands: the fill window, in the trade with its time-out, expired, or held', () => {
    const now = 1_000_000_000;
    const s = now / 1000;
    expect(clockText({ status: 'open', fillBy: s + 90, filledAt: null, timeoutAt: null, exitAt: null }, now))
      .toEqual({ label: 'Fill window closes in', value: '1:30', tone: 'wait' });
    expect(clockText({ status: 'filled', fillBy: s, filledAt: s - 65, timeoutAt: s + 600, exitAt: null }, now))
      .toEqual({ label: 'In the trade', value: '1:05 · time-out in 10:00', tone: 'live' });
    expect(clockText({ status: 'expired', fillBy: s, filledAt: null, timeoutAt: null, exitAt: null }, now)!.tone).toBe('done');
    expect(clockText({ status: 'tp1', fillBy: s, filledAt: s - 600, timeoutAt: null, exitAt: s - 60 }, now))
      .toEqual({ label: 'Held', value: '9:00', tone: 'done' });
  });

  it('[critical] a limit price ran away from is missed, not waiting', () => {
    expect(clockText({ status: 'missed', fillBy: 0, filledAt: null, timeoutAt: null, exitAt: null }, 0))
      .toEqual({ label: 'Missed', value: 'price ran to TGT1 without filling', tone: 'done' });
  });
});
