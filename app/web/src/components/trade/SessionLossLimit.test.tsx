import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SessionLossView } from '@/api/desk';

/**
 * The session loss limit card (owner, 4 Nov 2026): off by default on every account; sessions of the day each with a
 * limit in ₹ or %; at it the account is squared off and stopped for the rest of the day.
 */

const getSessionLoss = vi.fn();
const saveSessionLoss = vi.fn();
vi.mock('@/api/desk', async (orig) => ({
  ...(await orig<typeof import('@/api/desk')>()),
  getSessionLoss: (...a: unknown[]) => getSessionLoss(...a),
  saveSessionLoss: (...a: unknown[]) => saveSessionLoss(...a),
}));
const { SessionLossLimit, draftProblems, everyHour } = await import('@/components/trade/SessionLossLimit');

const view = (o: Partial<SessionLossView> = {}): SessionLossView => ({ setting: { on: false, sessions: [] }, now: null, blocked: null, hits: [], ...o });

beforeEach(() => {
  getSessionLoss.mockReset(); saveSessionLoss.mockReset();
  getSessionLoss.mockResolvedValue(view());
  saveSessionLoss.mockImplementation(async (setting) => ({ ok: true, ...view({ setting }) }));
});

describe('Session loss limit', () => {
  it('[critical] off by default, with no session; nothing saved until asked', async () => {
    render(<SessionLossLimit />);
    const sw = await screen.findByRole('switch', { name: /^Session loss limit/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Off: no session limit on this account.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(saveSessionLoss).not.toHaveBeenCalled();
  });

  it('[critical] every hour 07:00–17:00 at ₹1,000, switched on, saved as sessions of the day', async () => {
    render(<SessionLossLimit />);
    await screen.findByRole('switch', { name: /^Session loss limit/ });
    fireEvent.click(screen.getByRole('button', { name: 'Every hour 07:00–17:00' }));
    fireEvent.click(screen.getByRole('switch', { name: /^Session loss limit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveSessionLoss).toHaveBeenCalledTimes(1));
    const sent = saveSessionLoss.mock.calls[0]![0];
    expect(sent.on).toBe(true);
    expect(sent.sessions).toHaveLength(10);
    expect(sent.sessions[0]).toEqual({ from: '07:00', to: '08:00', limit: 1000, unit: 'inr' });
    expect(sent.sessions[9]).toEqual({ from: '16:00', to: '17:00', limit: 1000, unit: 'inr' });
  });

  it('[critical] a session in per cent: chosen on the row, sent as such', async () => {
    render(<SessionLossLimit />);
    await screen.findByRole('switch', { name: /^Session loss limit/ });
    fireEvent.click(screen.getByRole('button', { name: '+ Add session' }));
    const row = screen.getByRole('group', { name: 'Session 1 limit in' });
    fireEvent.click(within(row).getByRole('button', { name: '%' }));
    fireEvent.change(screen.getByLabelText('Session 1 limit'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveSessionLoss).toHaveBeenCalled());
    expect(saveSessionLoss.mock.calls[0]![0].sessions).toEqual([{ from: '07:00', to: '08:00', limit: 2.5, unit: 'pct' }]);
  });

  it('a session that ends before it starts is said, and cannot be saved', async () => {
    render(<SessionLossLimit />);
    await screen.findByRole('switch', { name: /^Session loss limit/ });
    fireEvent.click(screen.getByRole('button', { name: '+ Add session' }));
    fireEvent.change(screen.getByLabelText('Session 1 to'), { target: { value: '06:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Session 1: it must end after it starts.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('[critical] the session now against its limit; and the day stopped, said plainly with the square-off', async () => {
    getSessionLoss.mockResolvedValue(view({
      setting: { on: true, sessions: [{ from: '07:00', to: '08:00', limit: 1000, unit: 'inr' }] },
      now: { from: '07:00', to: '08:00', limit: 1000, unit: 'inr', limitInr: 1000, lossInr: 420, hit: false, breachSince: null },
    }));
    const { unmount } = render(<SessionLossLimit />);
    expect(await screen.findByText(/lost ₹420 of ₹1,000/)).toBeInTheDocument();
    unmount();
    getSessionLoss.mockResolvedValue(view({
      setting: { on: true, sessions: [{ from: '07:00', to: '08:00', limit: 1000, unit: 'inr' }] },
      blocked: 'The 07:00–08:00 session lost ₹1,234, at its ₹1,000 limit: the account was squared off and takes no new entry today.',
      hits: [{ day: '2026-11-04', from: '07:00', to: '08:00', limitInr: 1000, lossInr: 1234, at: Date.parse('2026-11-04T07:40:00+05:30'), closed: 12, cancelled: 2, failed: 0, detail: '' }],
    }));
    render(<SessionLossLimit />);
    expect(await screen.findByText(/Stopped for today/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Squared off by the session limit' })).toHaveTextContent('11-04 07:40 · 07:00–08:00 lost ₹1,234 of ₹1,000 · 12 closed');
  });

  it('on all accounts: set on each account\'s own tab, nothing read', () => {
    render(<SessionLossLimit several />);
    expect(screen.getByText(/set on each account's own tab/)).toBeInTheDocument();
    expect(getSessionLoss).not.toHaveBeenCalled();
  });
});

describe('the parts', () => {
  it('every hour, and the rules', () => {
    expect(everyHour(7, 9, 500, 'pct')).toEqual([{ from: '07:00', to: '08:00', limit: 500, unit: 'pct' }, { from: '08:00', to: '09:00', limit: 500, unit: 'pct' }]);
    expect(draftProblems({ on: true, sessions: [] })).toEqual(['Add a session to switch it on.']);
    expect(draftProblems({ on: true, sessions: [{ from: '07:00', to: '08:30', limit: 1, unit: 'inr' }, { from: '08:00', to: '09:00', limit: 1, unit: 'inr' }] })).toEqual(['Sessions 1 and 2 overlap.']);
    expect(draftProblems({ on: false, sessions: [{ from: '07:00', to: '08:00', limit: 150, unit: 'pct' }] })).toEqual(['Session 1: at most 100% of the account.']);
  });
});
