import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Liveness, livenessOf, type Checked } from './Liveness';

const NOW = 1_790_500_000_000;
const check = (over: Partial<NonNullable<Checked>> = {}): Checked => ({
  tf: '5m', at: NOW - 40_000, event: 'RANGE', stage: 'RANGE', wrote: NOW - 13 * 3_600_000, ...over,
});

describe('telling a quiet market from a dead recorder', () => {
  it('[critical] a recent look says so, and names what it saw', () => {
    const l = livenessOf(check(), NOW);
    expect(l.tone).toBe('ok');
    expect(l.text).toBe('checked 40s ago · still Range');
  });

  it('[critical] a stale look is a warning, not a quiet market', () => {
    // 13 hours — the exact shape of the 27 Sep outage.
    const l = livenessOf(check({ at: NOW - 13 * 3_600_000 }), NOW);
    expect(l.tone).toBe('warn');
    expect(l.text).toMatch(/not checked for/);
    expect(l.title).toMatch(/may mean the recorder has stopped/);
  });

  it('[critical] never having run is its own state, not "quiet"', () => {
    const l = livenessOf(null, NOW);
    expect(l.tone).toBe('warn');
    expect(l.text).toBe('never recorded');
  });

  it('[critical] the two silences never produce the same words', () => {
    const quiet = livenessOf(check({ at: NOW - 30_000 }), NOW);
    const dead = livenessOf(check({ at: NOW - 6 * 3_600_000 }), NOW);
    expect(quiet.text).not.toBe(dead.text);
    expect(quiet.tone).not.toBe(dead.tone);
  });

  it('a slow timeframe is allowed a longer gap than a fast one', () => {
    const gap = 10 * 60_000;
    // 10 minutes is stale for 5m, ordinary for 4h.
    expect(livenessOf(check({ tf: '5m', at: NOW - gap }), NOW).tone).toBe('warn');
    expect(livenessOf(check({ tf: '4h', at: NOW - gap }), NOW).tone).toBe('ok');
  });

  it('an unknown timeframe still gets a limit rather than never going stale', () => {
    expect(livenessOf(check({ tf: '9h', at: NOW - 60 * 60_000 }), NOW).tone).toBe('warn');
  });

  it('the state word is readable, not a database constant', () => {
    expect(livenessOf(check({ event: 'BREAKOUT_CONFIRMED' }), NOW).text).toMatch(/still Breakout confirmed/);
  });

  it('ages read in seconds, minutes and hours as they grow', () => {
    expect(livenessOf(check({ at: NOW - 20_000 }), NOW).text).toMatch(/20s ago/);
    expect(livenessOf(check({ tf: '4h', at: NOW - 10 * 60_000 }), NOW).text).toMatch(/10m ago/);
    expect(livenessOf(check({ tf: '4h', at: NOW - 3 * 3_600_000 }), NOW).text).toMatch(/3h ago/);
  });

  it('a clock skew into the future reads as just-now, never as negative', () => {
    expect(livenessOf(check({ at: NOW + 5_000 }), NOW).text).toMatch(/0s ago/);
  });

  it('renders the words with an explanation attached', () => {
    render(<Liveness checked={check()} now={NOW} />);
    const el = screen.getByText(/checked 40s ago/);
    expect(el).toBeVisible();
    expect(el).toHaveAttribute('title', expect.stringContaining('change log'));
  });
});
