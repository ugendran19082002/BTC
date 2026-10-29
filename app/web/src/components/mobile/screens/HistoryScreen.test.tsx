import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';
import { istMs } from '@/lib/date-time-range';
import type { OrderRecord } from '@/types/trade';

/**
 * Trade history on the phone (owner, 19 Oct 2026: "a custom date and time range, user friendly; a time frame filter,
 * responsive"): a From and a To each a date and a time, a trade counted by its entry or its exit; and the signal's
 * time frame, one or several, each with its count.
 */
const getOrders = vi.fn();
vi.mock('@/api/phone', () => ({ getOrders: (...a: unknown[]) => getOrders(...a) }));
const { HistoryScreen } = await import('@/components/mobile/screens/HistoryScreen');

const NOW = istMs('2026-10-19', '15:00');
const at = (day: string, t: string) => istMs(day, t);
const closed = (id: string, tf: string, mode: 'mtf' | 'single', inAt: number, outAt: number, net: number): OrderRecord => ({
  tradeId: id, symbol: 'P-BTC-78500-201026', productId: 1, optionSide: 'PE', phase: 'closed', status: 'completed', outcome: 'Closed',
  position: 0, requestedSize: 5, entrySize: 5, entryAvgPrice: 50, exitSize: 5, exitAvgPrice: 40, openedAt: inAt,
  protection: { takeProfit: null, stopLoss: null }, realisedPnl: net, netRealisedUsd: net, note: null, alarm: null, updatedAt: outAt,
  fills: [{ orderId: `${id}e`, role: 'entry', side: 'sell', size: 5, price: 50, ts: inAt }, { orderId: `${id}x`, role: 'exit', side: 'buy', size: 5, price: 40, ts: outAt }],
  plan: {
    lots: 5, strategyName: `S ${id}`, origin: 'strategy', entry: { type: 'limit', limitPrice: 50, timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 5, stopPrice: 200,
    signal: { method: 'm', n: 1, name: 'M', mode, tf, dir: -1, triggerTime: inAt },
  },
} as unknown as OrderRecord);
const TRADES = [
  closed('a', '5m', 'single', at('2026-10-18', '22:00'), at('2026-10-19', '01:00'), 2),
  closed('b', '15m', 'single', at('2026-10-19', '10:00'), at('2026-10-19', '10:30'), -1),
  closed('c', '5m', 'mtf', at('2026-10-19', '11:00'), at('2026-10-19', '11:30'), 1),
  closed('d', '5m', 'single', at('2026-10-19', '12:00'), at('2026-10-19', '13:00'), 3),
];
const show = () => render(
  <PhoneContext.Provider value={{ now: NOW, accountParam: null, shown: 'one', openTrade: () => {} } as unknown as PhoneData}>
    <HistoryScreen />
  </PhoneContext.Provider>,
);
const rows = () => screen.queryAllByRole('button', { name: /open the trade$/ });
const tfChip = (name: RegExp) => within(screen.getByRole('group', { name: 'Time frame' })).getByRole('button', { name });
const sheet = () => screen.getByRole('dialog', { name: 'Date and time' });

beforeEach(() => {
  window.localStorage.clear();
  getOrders.mockReset().mockResolvedValue({ from: '', to: '', counts: {}, trades: TRADES });
});

describe('HistoryScreen', () => {
  it('[critical] time frame chips, each with its count; one or several picked, All TF clears', async () => {
    show();
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(tfChip(/^5m/)).toHaveTextContent('5m 2');
    expect(tfChip(/^15m/)).toHaveTextContent('15m 1');
    expect(tfChip(/^TF chain/)).toHaveTextContent('TF chain 1');
    fireEvent.click(tfChip(/^5m/));
    expect(rows()).toHaveLength(2);
    fireEvent.click(tfChip(/^TF chain/));
    expect(rows()).toHaveLength(3);
    fireEvent.click(tfChip(/^All TF/));
    expect(rows()).toHaveLength(4);
  });

  it('[critical] Custom: a quick pick, Show -- only the trades entered then, the range said, the days around it asked', async () => {
    show();
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Last night' }));
    expect(within(sheet()).getByRole('status')).toHaveTextContent('18 Oct 9:30 PM → 19 Oct 6:00 AM · by entry time, IST');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Show' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Custom range')).toHaveTextContent('18 Oct 9:30 PM → 19 Oct 6:00 AM · by entry time');
    expect(rows()).toHaveLength(1);
    expect(getOrders).toHaveBeenLastCalledWith('2026-10-17', '2026-10-19', null, 'completed');
  });

  it('[critical] by exit time: a trade entered before the From and closed in it counts', async () => {
    show();
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    const d = sheet();
    fireEvent.change(within(d).getByLabelText('From date'), { target: { value: '2026-10-19' } });
    fireEvent.change(within(d).getByLabelText('From time'), { target: { value: '00:30' } });
    fireEvent.change(within(d).getByLabelText('To date'), { target: { value: '2026-10-19' } });
    fireEvent.change(within(d).getByLabelText('To time'), { target: { value: '10:45' } });
    fireEvent.click(within(d).getByRole('radio', { name: 'By when it closed' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(rows()).toHaveLength(2)); // a (closed 1:00 AM) and b (10:30 AM)
    expect(screen.getByLabelText('Custom range')).toHaveTextContent('by exit time');
  });

  it('[critical] each row: In and Out side by side, each its time and price -- a date where it is not today -- and how long it was held', async () => {
    show();
    await waitFor(() => expect(rows()).toHaveLength(4));
    const a = rows().find((r) => r.textContent!.includes('S a'))!;
    const [inLeg, outLeg] = [within(a).getByText('In').parentElement!, within(a).getByText('Out').parentElement!];
    expect(inLeg).toHaveTextContent(/18 Oct.*22:00/);        // entered the evening before: its date said
    expect(inLeg).toHaveTextContent('50.00');
    expect(outLeg).toHaveTextContent('01:00');                // closed today: the time alone
    expect(outLeg).not.toHaveTextContent(/Oct/);
    expect(outLeg).toHaveTextContent('40.00');
    expect(a).toHaveTextContent('held 3h 00m');
  });

  it('[critical] sorted: newest exit first to begin with; by entry, by money either way, by time held -- remembered on the phone', async () => {
    const order = () => rows().map((r) => /S ([abcd])/.exec(r.textContent!)![1]);
    const { unmount } = show();
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(order()).toEqual(['d', 'c', 'b', 'a']);
    const sort = screen.getByRole('combobox', { name: 'Sort' });
    for (const [label, want] of [
      ['Oldest exit first', ['a', 'b', 'c', 'd']],
      ['Newest entry first', ['d', 'c', 'b', 'a']],
      ['Most made first', ['d', 'a', 'c', 'b']],
      ['Most lost first', ['b', 'c', 'a', 'd']],
      ['Held longest first', ['a', 'd', 'c', 'b']],      // 3 h, 1 h, then the two half-hours newest first
    ] as const) {
      fireEvent.change(sort, { target: { value: within(sort).getByRole('option', { name: label }).getAttribute('value') } });
      expect(order(), label).toEqual(want);
    }
    expect(screen.getByText(/4 trades · 3 won/)).toBeInTheDocument();      // the count is the same in any order
    unmount();
    show();
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(order()).toEqual(['a', 'd', 'c', 'b']);
  });

  it('[critical] a backwards range is said and cannot be shown; Cancel keeps what was there', async () => {
    show();
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    const d = sheet();
    fireEvent.change(within(d).getByLabelText('From date'), { target: { value: '2026-10-19' } });
    fireEvent.change(within(d).getByLabelText('From time'), { target: { value: '12:00' } });
    fireEvent.change(within(d).getByLabelText('To date'), { target: { value: '2026-10-19' } });
    fireEvent.change(within(d).getByLabelText('To time'), { target: { value: '09:00' } });
    expect(within(d).getByRole('alert')).toHaveTextContent('The From must be before the To.');
    expect(within(d).getByRole('button', { name: 'Show' })).toBeDisabled();
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Custom range')).not.toBeInTheDocument();
    expect(rows()).toHaveLength(4);
  });
});
