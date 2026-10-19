import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const getBacktestPortfolio = vi.fn();
vi.mock('@/api/backtest-saves', async (orig) => ({
  ...(await orig<typeof import('@/api/backtest-saves')>()),
  getBacktestPortfolio: (...a: unknown[]) => getBacktestPortfolio(...a),
}));
const { PortfolioRun } = await import('@/components/report/SavedBacktests');

/**
 * 19 Oct 2026: methods by win % on the days before a run from 1 Oct -- refused by the server every time, "They could
 * not be run together". Settings the screen already knows cannot be run are not asked for: said, with the fix.
 */
describe('PortfolioRun', () => {
  it('[critical] settings that cannot be run are not sent: why is said, with the change that makes them work a tap away', () => {
    const apply = vi.fn();
    const onClose = vi.fn();
    render(<PortfolioRun run={{ ids: ['a', 'b'], title: 'High win%' }} range={{ from: '2026-10-01', to: '2026-10-20' }} onClose={onClose}
      blocked={{ problem: 'There are no finished days before Thu 1 Oct to pick from: the record starts Thu 1 Oct.', fix: { label: "Pick on the run's first 7 days instead", apply } }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Not run with these settings. There are no finished days before Thu 1 Oct to pick from');
    fireEvent.click(screen.getByRole('button', { name: "Pick on the run's first 7 days instead" }));
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getBacktestPortfolio).not.toHaveBeenCalled();
  });
});
