import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LtpChip } from './LtpChip';

describe('the LTP chip', () => {
  afterEach(() => vi.useRealTimers());

  it('[critical] shows the last trade, which way it ticked, and the time left in the candle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 29, 6, 2, 30)));
    const { rerender } = render(<LtpChip price={81_000} at={Date.now()} tfSec={300} />);
    const chip = screen.getByRole('status', { name: 'Last traded price' });
    expect(chip.textContent).toContain('81,000');
    expect(chip.textContent).toContain('2:30');
    rerender(<LtpChip price={81_010.5} at={Date.now()} tfSec={300} />);
    expect(chip.className).toContain('up');
    rerender(<LtpChip price={80_990} at={Date.now()} tfSec={300} />);
    expect(chip.className).toContain('down');
  });

  it('[critical] a trade over a minute old says how old, instead of looking live', () => {
    render(<LtpChip price={81_000} at={Date.now() - 3 * 60_000} tfSec={300} />);
    const chip = screen.getByRole('status', { name: 'Last traded price' });
    expect(chip.className).toContain('stale');
    expect(chip.textContent).toContain('3m ago');
  });
});
