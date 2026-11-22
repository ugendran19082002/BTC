import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExitRail } from '@/components/mobile/ExitRail';

/** The rail's marker with its live % (22 Nov 2026): a pill, + green toward the target, − red toward the stop. */
describe('ExitRail marker %', () => {
  const opt = { title: 'Option', entry: 80, target: 4, stop: 214, fmt: (n: number) => n.toFixed(2), nowLabel: 'ask' };

  it('[critical] the option in profit: the pill says the premium kept, in green, and the line says it for a screen reader', () => {
    render(<ExitRail {...opt} current={73} marker="kept" />);
    const pill = screen.getByTestId('rail-marker');
    expect(pill).toHaveTextContent('+9%');
    expect(pill.innerHTML).toContain('bg-[var(--up)]');
    expect(screen.getByRole('img')).toHaveAccessibleName(/\+9% of the premium kept/);
  });

  it('[critical] toward the stop: minus, in red', () => {
    render(<ExitRail {...opt} current={94.4} marker="kept" />);
    const pill = screen.getByTestId('rail-marker');
    expect(pill).toHaveTextContent('−18%');
    expect(pill.innerHTML).toContain('bg-[var(--down)]');
  });

  it('the perp: how far along, and near an end the pill hangs inward so it never leaves the card', () => {
    render(<ExitRail title="BTC perp" entry={60_000} target={60_500} stop={59_600} current={60_490} fmt={(n) => String(n)} nowLabel="last" marker="progress" />);
    const pill = screen.getByTestId('rail-marker');
    expect(pill).toHaveTextContent('+98%');
    expect(pill.className).not.toContain('-translate-x-1/2');
  });

  it('without `marker`, the plain dot as before', () => {
    render(<ExitRail {...opt} current={73} />);
    expect(screen.queryByTestId('rail-marker')).toBeNull();
  });
});
