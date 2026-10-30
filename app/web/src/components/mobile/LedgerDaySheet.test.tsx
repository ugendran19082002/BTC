import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { DayTrade } from '@/api/ledger';
import { signedInr, usdToInr } from '@/lib/format';

/**
 * One ledger day's trades in a sheet (owner, 30 Oct 2026: "the entries under a day, a tap opens a popup: entry, exit,
 * charges, P&L, the strike, PE or CE, entry time, exit time -- mobile friendly").
 */
const getLedgerDay = vi.fn();
vi.mock('@/api/ledger', () => ({ getLedgerDay: (...a: unknown[]) => getLedgerDay(...a) }));
const { LedgerDaySheet } = await import('@/components/mobile/LedgerDaySheet');

const inr = (usd: number) => signedInr(usdToInr(usd));
const DAY = '2026-10-29';
const at = (t: string) => Date.parse(`${DAY}T${t}:00+05:30`);
const trade = (id: string, o: Partial<DayTrade>): DayTrade => ({
  tradeId: id, symbol: 'P-BTC-81400-291026', strike: 81_400, optionSide: 'PE', action: 'sell', contracts: 10,
  entryAt: at('07:05'), exitAt: at('09:40'), entryPrice: 42, exitPrice: 4.2, chargesUsd: 0.02, grossUsd: 0.378, netUsd: 0.358,
  exitBy: 'option-tgt', open: false, spans: false, strategy: '15m time', account: { id: 1, name: 'High' }, orderIds: [`${id}-e`, `${id}-x`], ...o,
});
const TRADES = [
  trade('a', {}),
  trade('b', { symbol: 'C-BTC-86200-291026', strike: 86_200, optionSide: 'CE', exitAt: at('11:10'), exitPrice: 150, grossUsd: -1.08, netUsd: -1.11, chargesUsd: 0.03, exitBy: 'option-sl' }),
  trade('c', { entryAt: Date.parse('2026-10-28T23:50:00+05:30'), exitAt: at('00:10'), spans: true, exitBy: 'perp-tgt', netUsd: 0.2 }),
];
const DESK = { realisedUsd: -0.32, profitUsd: 0.76, lossUsd: 1.08, chargesUsd: 0.07, netUsd: -0.39, trades: 3, open: 0 };
const onOpenTrade = vi.fn();
const onClose = vi.fn();
const show = () => render(<LedgerDaySheet day={DAY} account={null} showAccount onOpenTrade={onOpenTrade} onClose={onClose} />);
const lines = () => within(screen.getByRole('list', { name: "The day's trades" })).getAllByRole('button');

beforeEach(() => {
  window.localStorage.clear();
  getLedgerDay.mockReset().mockResolvedValue({ day: DAY, account: null, desk: DESK, trades: TRADES });
  onOpenTrade.mockReset(); onClose.mockReset();
});

describe('LedgerDaySheet', () => {
  it('[critical] the day\'s own figures, and each trade: side, strike and CE / PE, how it closed, net; In and Out with times and prices; charges and booked', async () => {
    show();
    const day = within(await screen.findByRole('region', { name: 'The day' }));
    expect(getLedgerDay).toHaveBeenCalledWith(DAY, null);
    expect(day.getByText(inr(-0.39))).toBeInTheDocument();
    expect(day.getByText('Trades').nextSibling).toHaveTextContent('3');
    expect(day.getByText('Charges').nextSibling).toHaveTextContent(inr(-0.07));
    const pe = lines().find((b) => b.getAttribute('aria-label') === '81400 PE: open the trade' && b.textContent!.includes('09:40'))!;
    expect(pe).toHaveTextContent('SELL81,400 PE×10');
    expect(pe).toHaveTextContent(inr(0.358));
    expect(within(pe).getByText('In').parentElement!.parentElement).toHaveTextContent('42.0007:05');
    expect(within(pe).getByText('Out').parentElement!.parentElement).toHaveTextContent('4.2009:40');
    expect(pe).toHaveTextContent(`Charges ${inr(-0.02)} · booked ${inr(0.378)} · held 2h 35m`);
    expect(within(pe).getByText('TGT')).toBeInTheDocument();
    expect(pe).toHaveTextContent('15m time · High');
    const over = lines().find((b) => b.textContent!.includes('Over midnight'))!;
    expect(within(over).getByText('In').parentElement!.parentElement).toHaveTextContent(/28 Oct.*23:50/);
  });

  it('[critical] CE or PE and won or lost narrow the list; the order is chosen and kept; a tap opens the trade; Escape closes', async () => {
    show();
    await screen.findByRole('list', { name: "The day's trades" });
    expect(lines()).toHaveLength(3);
    fireEvent.click(within(screen.getByRole('group', { name: 'CE or PE' })).getByRole('button', { name: 'CE 1' }));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toHaveTextContent('86,200 CE');
    fireEvent.click(within(screen.getByRole('group', { name: 'CE or PE' })).getByRole('button', { name: 'All 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lost' }));
    expect(lines()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Lost' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), { target: { value: 'net-high' } });
    expect(lines().map((b) => b.textContent!.match(/[+−-]₹[\d.,]+/)![0])).toEqual([inr(0.358), inr(0.2), inr(-1.11)]);
    fireEvent.click(lines()[0]!);
    expect(onOpenTrade).toHaveBeenCalledWith('a');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
