import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { plainOf, TelegramLogCard } from '@/components/desk/TelegramLogCard';

const getTelegramLog = vi.fn();
vi.mock('@/api/trade', () => ({ getTelegramLog: (...a: unknown[]) => getTelegramLog(...a) }));

/** Every Telegram message, and what became of it. */
const AT = Date.UTC(2026, 9, 2, 16, 40);
const entries = [
  { id: 3, at: AT + 2, key: 'a:exit', status: 'repeat', text: '<b>TARGET HIT · BTC 88,200 CE</b>\nBought back 3 @ 2.20', error: null },
  { id: 2, at: AT + 1, key: 'b:entry', status: 'failed', text: '<b>SOLD BTC 86,400 CE</b>\nFilled 3', error: 'Forbidden: bot was blocked by the user (HTTP 403)' },
  { id: 1, at: AT, key: 'a:entry', status: 'sent', text: '🟢 <b>SOLD BTC 88,200 CE</b>\n<i>Expiry 3 Oct</i>\nFilled <b>3</b> of 3 @ <b>44.00</b>', error: null },
];

beforeEach(() => {
  localStorage.clear();
  getTelegramLog.mockReset();
  getTelegramLog.mockResolvedValue({ configured: true, on: true, entries });
});

describe('the Telegram log', () => {
  it('[critical] each message: when, what (its first line, no markup), sent / failed / held back, and Telegram\'s reason', async () => {
    render(<TelegramLogCard />);
    const table = await screen.findByRole('table', { name: 'telegram messages' });
    expect(table).toHaveTextContent('TARGET HIT · BTC 88,200 CE');
    expect(table).toHaveTextContent('held back');
    expect(table).toHaveTextContent('failed');
    expect(table).toHaveTextContent('Telegram said: Forbidden: bot was blocked by the user (HTTP 403)');
    expect(table).not.toHaveTextContent('<b>');
    expect(screen.getByText('alerts on')).toBeInTheDocument();
  });

  it('[critical] the filter asks the server for one kind, and is kept', async () => {
    const { unmount } = render(<TelegramLogCard />);
    await screen.findByRole('table', { name: 'telegram messages' });
    fireEvent.click(within(screen.getByRole('group', { name: 'which messages' })).getByRole('button', { name: 'Failed' }));
    await waitFor(() => expect(getTelegramLog).toHaveBeenLastCalledWith('failed'));
    unmount();
    render(<TelegramLogCard />);
    await waitFor(() => expect(getTelegramLog).toHaveBeenLastCalledWith('failed'));
  });

  it('plainOf: markup out, entities back, first line and the rest', () => {
    expect(plainOf('🟢 <b>SOLD</b> &amp; more\n<i>x</i>\ny')).toEqual({ head: '🟢 SOLD & more', rest: 'x · y' });
  });
});
