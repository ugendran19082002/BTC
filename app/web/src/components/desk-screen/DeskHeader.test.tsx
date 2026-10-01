import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeskHeader, friendlyExpiry } from './DeskHeader';

describe('the desk header', () => {
  it('reads the expiry code as a date, and keeps anything else as given', () => {
    expect(friendlyExpiry('011026 17:30 IST')).toBe('1 Oct, 17:30 IST');
    expect(friendlyExpiry('251226 17:30 IST')).toBe('25 Dec, 17:30 IST');
    expect(friendlyExpiry('Weekly')).toBe('Weekly');
  });

  it('the countdown turns amber under three hours and red under one', () => {
    const { rerender } = render(<DeskHeader expiryLabel="011026 17:30 IST" hoursToExpiry={9.5} />);
    expect(screen.getByText('9h 30m left').className).not.toMatch(/is-soon|is-urgent/);
    rerender(<DeskHeader expiryLabel="011026 17:30 IST" hoursToExpiry={2.25} />);
    expect(screen.getByText('2h 15m left').className).toMatch(/is-soon/);
    rerender(<DeskHeader expiryLabel="011026 17:30 IST" hoursToExpiry={0.5} />);
    expect(screen.getByText('0h 30m left').className).toMatch(/is-urgent/);
    expect(screen.getByText('1 Oct, 17:30 IST')).toBeInTheDocument();
  });
});
