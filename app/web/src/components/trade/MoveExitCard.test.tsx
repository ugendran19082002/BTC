import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** The BTC-move exit card (owner, 22 Nov 2026): off by default; the move, the window and how near, a tap each; Save. */
const getMoveExit = vi.fn();
const saveMoveExit = vi.fn();
vi.mock('@/api/desk', async (orig) => ({
  ...(await orig<typeof import('@/api/desk')>()),
  getMoveExit: (...a: unknown[]) => getMoveExit(...a),
  saveMoveExit: (...a: unknown[]) => saveMoveExit(...a),
}));
const { MoveExitCard } = await import('@/components/trade/MoveExitCard');
const OFF = { on: false, pct: 0.8, minutes: 10, nearPct: 1.5, from: '12:00', to: null };

beforeEach(() => {
  getMoveExit.mockReset(); saveMoveExit.mockReset();
  getMoveExit.mockResolvedValue({ setting: OFF });
  saveMoveExit.mockImplementation(async (setting) => ({ ok: true, setting }));
});

describe('BTC-move exit', () => {
  it('[critical] off by default, nothing to choose and nothing saved until asked', async () => {
    render(<MoveExitCard />);
    const sw = await screen.findByRole('switch', { name: /^BTC-move exit/ });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Off: sales are left to their own stops and targets.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'BTC move' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('[critical] switched on with the study\'s numbers; each changed in a tap; saved as one setting', async () => {
    render(<MoveExitCard />);
    fireEvent.click(await screen.findByRole('switch', { name: /^BTC-move exit/ }));
    expect(within(screen.getByRole('group', { name: 'BTC move' })).getByRole('button', { name: '0.8%' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('group', { name: 'Within' })).getByRole('button', { name: '10 min' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('group', { name: 'Strikes near' })).getByRole('button', { name: '1.5%' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(screen.getByRole('group', { name: 'BTC move' })).getByRole('button', { name: '1%' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Within' })).getByRole('button', { name: '15 min' }));
    expect(screen.getByText(/From 12:00 to the 17:30 expiry: when BTC moves 1% against a sale within 15 min .* the sales with a strike within 1.5% of BTC are bought back at once, worst first\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMoveExit).toHaveBeenCalledWith({ on: true, pct: 1, minutes: 15, nearPct: 1.5, from: '12:00', to: null }));
  });

  it('cancel puts it back as kept; a refusal is said', async () => {
    saveMoveExit.mockRejectedValue(new Error('The BTC move is 0.2% to 5%.'));
    render(<MoveExitCard />);
    fireEvent.click(await screen.findByRole('switch', { name: /^BTC-move exit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The BTC move is 0.2% to 5%.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('switch', { name: /^BTC-move exit/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('on all accounts: set on each account\'s own tab, nothing read', () => {
    render(<MoveExitCard several />);
    expect(screen.getByText('BTC-move exit: set on each account\'s own tab.')).toBeInTheDocument();
    expect(getMoveExit).not.toHaveBeenCalled();
  });

  it('[critical] the hours: from 12:00 offered; all day or 13:00, and until 16:30, a tap each; saved with the rest', async () => {
    render(<MoveExitCard />);
    fireEvent.click(await screen.findByRole('switch', { name: /^BTC-move exit/ }));
    const from = screen.getByRole('group', { name: 'From' });
    expect(within(from).getByRole('button', { name: '12:00' })).toHaveAttribute('aria-pressed', 'true');
    const until = screen.getByRole('group', { name: 'Until' });
    expect(within(until).getByRole('button', { name: 'Expiry 17:30' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(until).getByRole('button', { name: '16:30' }));
    expect(screen.getByText(/^From 12:00 to 16:30: when BTC moves/)).toBeInTheDocument();
    fireEvent.click(within(from).getByRole('button', { name: 'All day' }));
    expect(screen.getByText(/^From the day's start to 16:30: when BTC moves/)).toBeInTheDocument();
    fireEvent.click(within(until).getByRole('button', { name: 'Expiry 17:30' }));
    expect(screen.getByText(/^All day: when BTC moves/)).toBeInTheDocument();
    fireEvent.click(within(from).getByRole('button', { name: '13:00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveMoveExit).toHaveBeenCalledWith({ on: true, pct: 0.8, minutes: 10, nearPct: 1.5, from: '13:00', to: null }));
  });

  it('a setting kept before the hours existed reads as all day, and as unchanged', async () => {
    getMoveExit.mockResolvedValue({ setting: { on: true, pct: 0.8, minutes: 10, nearPct: 1.5 } });
    render(<MoveExitCard />);
    const from = await screen.findByRole('group', { name: 'From' });
    expect(within(from).getByRole('button', { name: 'All day' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
