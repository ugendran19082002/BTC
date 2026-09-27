import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SignalDesk, RANGES } from './SignalDesk';
import { progressOf } from './SignalRow';
import type { StateHistoryRow } from '@/api/desk';
import type { Measured } from '@/types/live';

const measured: Measured = {
  policy: 'entry 1.5 ATR : 3 ATR', tf: '5m', mode: 'rolling',
  modeLabel: "the last 20 bars' high and low",
  n: 9987, hitRate: 0.229, netR: -0.612, avgR: -0.038,
  outOfSample: { year: '2026', n: 2937, hitRate: 0.222, netR: -0.645 },
  from: '2024-04-01', to: '2026-09-27',
};

const row = (over: Partial<StateHistoryRow> = {}): StateHistoryRow => ({
  id: 1, at: Date.parse('2026-09-27T14:37:00Z'), tf: '5m',
  event: 'BREAKDOWN_WATCH', stage: 'WATCH', side: 'DOWN', confirmed: false,
  confidence: 32, close: 84_651,
  plan: { side: 'DOWN', trigger: 84_588, target1: 84_457, target2: 84_400, invalidation: 84_719 },
  outcome: null, gradedAt: null, movePts: 77, ...over,
} as StateHistoryRow);

const base = { range: 0 as number | null, onRange: () => {} };

describe('the signal desk', () => {
  it('[critical] the net-after-fees figure is on screen before any row is read', () => {
    render(<SignalDesk {...base} rows={[row()]} measured={measured} />);
    expect(screen.getByText('-0.612R')).toBeVisible();
    expect(screen.getByText('Net after fees')).toBeVisible();
  });

  it('[critical] a losing shape says information only, not worth trading', () => {
    render(<SignalDesk {...base} rows={[row()]} measured={measured} />);
    expect(screen.getByText(/Information only/)).toBeVisible();
  });

  it('[critical] an ungraded timeframe claims nothing rather than borrowing a number', () => {
    render(<SignalDesk {...base} rows={[row()]} measured={null} tf="2h" />);
    // Said twice on purpose: once where the hit rate would have been, once in
    // the note. Neither cell may quietly show the other timeframe's number.
    expect(screen.getAllByText(/never graded/)).toHaveLength(2);
    expect(screen.getByText(/Nothing is claimed about these calls/)).toBeVisible();
    expect(screen.queryByText(/-0\.612R/)).not.toBeInTheDocument();
  });

  it('the held-out year is shown separately from the whole sample', () => {
    render(<SignalDesk {...base} rows={[row()]} measured={measured} />);
    expect(screen.getByText('2026 (held out)')).toBeVisible();
    expect(screen.getByText('-0.645R')).toBeVisible();
  });

  it('every range tab is offered, and pressing one asks for it', () => {
    const seen: (number | null)[] = [];
    render(<SignalDesk {...base} rows={[row()]} onRange={(d) => seen.push(d)} />);
    for (const r of RANGES) expect(screen.getByRole('button', { name: r.label })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(seen).toEqual([7]);
  });

  it('the chosen range is the pressed one', () => {
    render(<SignalDesk {...base} range={3} rows={[row()]} />);
    expect(screen.getByRole('button', { name: '3 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('[critical] an empty range explains itself rather than looking broken', () => {
    render(<SignalDesk {...base} rows={[]} />);
    expect(screen.getByText(/a quiet market writes nothing/)).toBeVisible();
  });

  it('the total across all days is shown beside the range being viewed', () => {
    render(<SignalDesk {...base} rows={[row()]} total={120} />);
    expect(screen.getByText('120')).toBeVisible();
    expect(screen.getByText('across all days')).toBeVisible();
  });

  it('the desk\'s own hit rate is a count, never a bare percentage alone', () => {
    render(<SignalDesk {...base} rows={[row()]} rate={{ correct: 119, graded: 231 }} />);
    expect(screen.getByText('119 of 231 reached target')).toBeVisible();
  });

  it('nothing finished yet says so instead of showing 0%', () => {
    render(<SignalDesk {...base} rows={[row()]} rate={{ correct: 0, graded: 0 }} />);
    expect(screen.getByText('none finished yet')).toBeVisible();
  });

  it('long lists page rather than scrolling forever', () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ id: i }));
    render(<SignalDesk {...base} rows={many} />);
    expect(screen.getByText('1 / 3')).toBeVisible();
    fireEvent.click(screen.getByLabelText('Older'));
    expect(screen.getByText('2 / 3')).toBeVisible();
  });
});

describe('one signal row', () => {
  it('[critical] a waiting call shows the distance to its trigger, not a result', () => {
    render(<SignalDesk {...base} rows={[row()]} spot={84_737} />);
    expect(screen.getByText('WAITING')).toBeVisible();
    expect(screen.getByText(/pts to trigger/)).toBeVisible();
    expect(screen.getByText('Current')).toBeVisible();
  });

  it('[critical] an invalidated call says invalidated — never "wrong"', () => {
    render(<SignalDesk {...base} rows={[row({ outcome: 'INVALIDATED', movePts: -173, triggeredAt: 1 })]} />);
    expect(screen.getByText('INVALIDATED')).toBeVisible();
    expect(screen.queryByText(/wrong/i)).not.toBeInTheDocument();
  });

  it('a call whose trigger was never reached is not counted as a loss', () => {
    render(<SignalDesk {...base} rows={[row({ outcome: 'NOT_TRIGGERED', movePts: 0 })]} />);
    expect(screen.getByText('NOT TRIGGERED')).toBeVisible();
  });

  it('the plan is spelled out: trigger, target and stop', () => {
    render(<SignalDesk {...base} rows={[row()]} />);
    const list = screen.getByRole('list');
    expect(within(list).getByText('Trigger')).toBeVisible();
    expect(within(list).getByText('Target')).toBeVisible();
    expect(within(list).getByText('Stop')).toBeVisible();
  });

  it('where it hit is named when it hit something', () => {
    render(<SignalDesk {...base} rows={[row({ outcome: 'INVALIDATED', firstHit: 'STOP', firstHitPrice: 84_909, triggeredAt: 1 })]} />);
    expect(screen.getByText(/Hit: STOP at 84,909/)).toBeVisible();
  });
});

describe('the outcome bar', () => {
  it('[critical] maps a price between trigger and target to 0..1', () => {
    expect(progressOf(100, 200, 100)).toBe(0);
    expect(progressOf(100, 200, 150)).toBe(0.5);
    expect(progressOf(100, 200, 200)).toBe(1);
  });

  it('[critical] works when the target is BELOW the trigger — a breakdown', () => {
    expect(progressOf(200, 100, 150)).toBe(0.5);
    expect(progressOf(200, 100, 100)).toBe(1);
  });

  it('clamps rather than overflowing its own bar', () => {
    expect(progressOf(100, 200, 900)).toBe(1);
    expect(progressOf(100, 200, -5)).toBe(0);
  });

  it('a zero span is 0, not a division by zero', () => {
    expect(progressOf(100, 100, 100)).toBe(0);
  });
});
