import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ExpiryCone } from './ExpiryCone';
import type { ExpiryPath, PathRow } from '@/types/live';

const row = (label: string, minutes: number, p68: number, p95: number, interpolated = false): PathRow => ({
  label, minutes, interpolated, windows: interpolated ? 0 : 105_000,
  medianUsd: p68 * 0.6, p68Usd: p68, p95Usd: p95,
  low68: 84_000 - p68, high68: 84_000 + p68,
  low95: 84_000 - p95, high95: 84_000 + p95,
  impliedUsd: p68 * 1.1, pUp: 0.502, leanUsd: 1.2,
});

const path = (over: Partial<ExpiryPath> = {}): ExpiryPath => ({
  spot: 84_000,
  hoursToExpiry: 6.4,
  rows: [
    row('5m', 5, 78, 232),
    row('15m', 15, 133, 400),
    row('30m', 30, 190, 570, true),
    row('1h', 60, 265, 799),
    row('2h', 120, 377, 1162),
    row('expiry', 384, 690, 2100),
  ],
  settlement: row('expiry', 384, 690, 2100),
  directionEdgePct: 0.62,
  sampleWindows: 105_119,
  sampleDays: 364,
  watch: 'LOWER',
  note: 'Measured over 1,05,119 windows across 364 days, the share closing higher never leaves 49.4–50.6%. The band is measured; the direction is not.',
  ...over,
});

describe('the settlement band', () => {
  it('[critical] draws a band, never a directional arrow', () => {
    const { container } = render(<ExpiryCone path={path()} bias="DOWN" />);
    // No up/down arrows anywhere in the cone: the table is symmetric by design.
    expect(container.textContent).not.toMatch(/[↑↓]/);
  });

  it('[critical] states that the band is measured and the direction is not', () => {
    render(<ExpiryCone path={path()} bias="DOWN" />);
    expect(screen.getByText(/The band is measured; the direction is not/)).toBeVisible();
  });

  it('[critical] prints the measured lean as points from a coin flip', () => {
    render(<ExpiryCone path={path()} bias="DOWN" />);
    expect(screen.getByText('0.62 pts from a coin flip')).toBeVisible();
  });

  it('every horizon is a row, settlement last', () => {
    render(<ExpiryCone path={path()} bias="SIDE" />);
    const rows = screen.getAllByRole('row').slice(1); // drop the header
    expect(rows).toHaveLength(6);
    expect(within(rows[rows.length - 1]!).getByText('expiry')).toBeInTheDocument();
  });

  it('[critical] an interpolated horizon is marked, a measured one is not', () => {
    render(<ExpiryCone path={path()} bias="SIDE" />);
    const thirty = screen.getByText('30m').closest('th')!;
    expect(within(thirty).getByTitle(/Not measured at this horizon/)).toBeInTheDocument();
    const hour = screen.getByText('1h').closest('th')!;
    expect(within(hour).queryByTitle(/Not measured/)).not.toBeInTheDocument();
  });

  it('the band widens with time', () => {
    render(<ExpiryCone path={path()} bias="SIDE" />);
    expect(screen.getByText('±232')).toBeInTheDocument();
    expect(screen.getByText('±2,100')).toBeInTheDocument();
  });

  it('names which edge the ladder says to watch', () => {
    render(<ExpiryCone path={path()} bias="DOWN" />);
    expect(screen.getByText(/lower edge is the one to watch/)).toBeVisible();
  });

  it('with no side from the ladder it says to watch both', () => {
    render(<ExpiryCone path={path({ watch: 'BOTH' })} bias="SIDE" />);
    expect(screen.getByText(/watch both edges/)).toBeVisible();
  });

  it('no measured horizons is said in a sentence, not an empty table', () => {
    render(<ExpiryCone path={null} bias="SIDE" />);
    expect(screen.getByText(/No measured horizons are loaded/)).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('wide content scrolls inside its own container rather than the page', () => {
    const { container } = render(<ExpiryCone path={path()} bias="SIDE" />);
    expect(container.querySelector('.overflow-x-auto')).not.toBeNull();
  });
});
