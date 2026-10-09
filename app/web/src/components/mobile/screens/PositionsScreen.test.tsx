import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';
import type { Trade } from '@/types/trade';
import { PositionsScreen, sortItems } from '@/components/mobile/screens/PositionsScreen';

/**
 * Positions on the phone (owner, 9 Oct 2026: "position phone la user friendly upgrades"): three tiles on top, which
 * to show with a count each, and how to sort -- with a problem always on top and a waiting order always after the
 * running ones, whatever the sort.
 */

const trade = (id: string, net: number | null, over: Partial<Trade> = {}): Trade => ({
  tradeId: id, symbol: 'P-BTC-78500-091026', productId: 1, optionSide: 'PE', phase: 'protected',
  position: -5, requestedSize: 5, entrySize: 5, entryAvgPrice: 50, exitSize: 0, exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' }, realisedPnl: 0, note: null, alarm: null, updatedAt: 0,
  fills: [{ orderId: id, role: 'entry', side: 'sell', size: 5, price: 50, ts: Number(id.replace(/\D/g, '')) * 1_000 }],
  plan: { lots: 5, strategyName: '1h time', entry: { type: 'limit', limitPrice: 50, timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 5, stopPrice: 200 },
  live: net === null ? undefined : { netIfClosedUsd: net, bid: 40, ask: 41, markPrice: 40.5 },
  ...over,
} as Trade);
const waitingOrder = (id: string) => trade(id, null, { phase: 'entry_pending', position: 0, entrySize: 0, entryAvgPrice: null, fills: [] });

const OPEN = [trade('w1', 2), trade('w2', 5), trade('l3', -1), trade('l4', -4), trade('l5', -0.5), waitingOrder('q6')];
const show = (open = OPEN, extra: Partial<PhoneData['status']> = {}) => render(
  <PhoneContext.Provider value={{
    now: 10_000_000, status: { open, alarms: [], marginUsedUsd: 70, walletUsd: 100, ...extra }, perp: null, perpLive: false,
    shown: 'one', openTrade: () => {},
  } as unknown as PhoneData}><PositionsScreen /></PhoneContext.Provider>,
);
const cards = () => screen.getAllByRole('button', { name: /what happened$/ });
const chip = (name: RegExp) => within(screen.getByRole('group', { name: 'Show positions' })).getByRole('button', { name });

beforeEach(() => window.localStorage.clear());

describe('PositionsScreen', () => {
  it('[critical] three tiles: running with the waiting beside it, the total if closed now, and the margin with its bar', () => {
    show();
    const tiles = screen.getByLabelText('positions summary');
    expect(tiles).toHaveTextContent('Running5+1 waiting');
    expect(tiles).toHaveTextContent(/Total P&L\+₹/);
    expect(tiles).toHaveTextContent('Margin used70%');
    expect(screen.getByRole('meter', { name: 'Margin used of the wallet' })).toHaveAttribute('aria-valuenow', '70');
  });

  it('[critical] the chips count each kind, and a tap shows only that kind -- a second tap, all again', () => {
    show();
    expect(chip(/^All/)).toHaveAccessibleName('All 6');
    expect(chip(/^Winning/)).toHaveAccessibleName('Winning 2');
    expect(chip(/^Losing/)).toHaveAccessibleName('Losing 3');
    expect(chip(/^Waiting/)).toHaveAccessibleName('Waiting 1');
    expect(within(screen.getByRole('group', { name: 'Show positions' })).queryByRole('button', { name: /^Alerts/ })).not.toBeInTheDocument();
    fireEvent.click(chip(/^Losing/));
    expect(cards()).toHaveLength(3);
    expect(screen.getByText(/3 of 6/)).toBeInTheDocument();
    fireEvent.click(chip(/^Losing/));
    expect(cards()).toHaveLength(6);
  });

  it('[critical] P&L high to low and low to high, remembered; the waiting order stays last', () => {
    const { unmount } = show();
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort positions by' }), { target: { value: 'pnl-desc' } });
    expect(screen.getByText('P&L high to low', { selector: 'span' })).toBeInTheDocument();
    expect(cards()).toHaveLength(6);
    expect(sortItems(OPEN.map((t) => ({ t, problem: false, room: Infinity, pnl: t.live?.netIfClosedUsd ?? null, waiting: t.position === 0 })), 'pnl-desc').map((x) => x.t.tradeId))
      .toEqual(['w2', 'w1', 'l5', 'l3', 'l4', 'q6']);
    expect(sortItems(OPEN.map((t) => ({ t, problem: false, room: Infinity, pnl: t.live?.netIfClosedUsd ?? null, waiting: t.position === 0 })), 'pnl-asc').map((x) => x.t.tradeId))
      .toEqual(['l4', 'l3', 'l5', 'w1', 'w2', 'q6']);
    unmount();
    show();
    expect(screen.getByRole('combobox', { name: 'Sort positions by' })).toHaveValue('pnl-desc');
  });

  it('[critical] a position with a problem stays on top under any sort, and gets an Alerts tile', () => {
    const items = OPEN.map((t) => ({ t, problem: t.tradeId === 'l5', room: Infinity, pnl: t.live?.netIfClosedUsd ?? null, waiting: t.position === 0 }));
    for (const s of ['risk', 'pnl-desc', 'pnl-asc', 'new', 'old'] as const) expect(sortItems(items, s)[0]!.t.tradeId).toBe('l5');
    show(OPEN, { alarms: [{ tradeId: 'l5', symbol: 'P-BTC-78500-091026', message: 'POSITION UNPROTECTED' }] } as never);
    expect(chip(/^Alerts/)).toHaveAccessibleName('Alerts 1');
  });

  it('newest and oldest by the first entry fill', () => {
    const items = OPEN.slice(0, 5).map((t) => ({ t, problem: false, room: Infinity, pnl: 0, waiting: false }));
    expect(sortItems(items, 'new').map((x) => x.t.tradeId)).toEqual(['l5', 'l4', 'l3', 'w2', 'w1']);
    expect(sortItems(items, 'old').map((x) => x.t.tradeId)).toEqual(['w1', 'w2', 'l3', 'l4', 'l5']);
  });

  it('nothing of a kind: says so, with a way back to all', () => {
    show([trade('w1', 2)]);
    fireEvent.click(chip(/^Winning/));
    fireEvent.click(chip(/^Losing/));
    expect(screen.getByText(/No losing positions right now/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(cards()).toHaveLength(1);
  });
});
