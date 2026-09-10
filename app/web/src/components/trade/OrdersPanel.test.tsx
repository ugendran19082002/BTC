import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { OrdersPanel } from '@/components/trade/OrdersPanel';
import type { OrderRecord } from '@/types/trade';

/**
 * Looking backwards at the day.
 *
 * Two things this screen has to get right. The summary is counted from the
 * rows on screen, so it can never tell you a different story from the list
 * underneath it. And a completed trade says *why* it completed — a target that
 * filled, a stop that fired and a position squared off by hand all read as
 * "completed" and mean entirely different things.
 */

const history = vi.fn();
vi.mock('@/api/trade', () => ({ getOrderHistory: (...a: unknown[]) => history(...a) }));

const OPENED = Date.UTC(2026, 8, 9, 10, 16, 25);

const order = (over: Partial<OrderRecord> = {}): OrderRecord => ({
  tradeId: `t${Math.random()}`,
  symbol: 'P-BTC-78600-090926',
  productId: 1,
  optionSide: 'PE',
  phase: 'flat',
  position: 0,
  requestedSize: 1,
  entrySize: 1,
  entryAvgPrice: 16,
  exitSize: 1,
  exitAvgPrice: 10.4,
  protection: { takeProfit: null, stopLoss: null },
  realisedPnl: 0.0056,
  fills: [
    { orderId: '1', role: 'entry', side: 'sell', size: 1, price: 16, ts: OPENED },
    { orderId: '2', role: 'take_profit', side: 'buy', size: 1, price: 10.4, ts: OPENED + 208_000 },
  ],
  note: null,
  alarm: null,
  openedAt: OPENED,
  updatedAt: OPENED + 208_000,
  status: 'completed',
  outcome: 'sold 1, bought back at 10.40',
  plan: {
    lots: 1,
    entry: { type: 'limit', timeoutMs: 0, marketFallback: false },
    takeProfitPrice: 10.4, stopPrice: null, leverage: 200,
  },
  ...over,
}) as OrderRecord;

const show = (trades: OrderRecord[]) => {
  history.mockResolvedValue({ from: '2026-09-09', to: '2026-09-09', counts: {}, trades });
  render(<OrdersPanel />);
};

beforeEach(() => {
  vi.setSystemTime(Date.UTC(2026, 8, 9, 12, 0));
  history.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('the summary line', () => {
  it('adds up what is on screen', async () => {
    show([
      order({ realisedPnl: 1 }),
      order({ realisedPnl: 2 }),
      order({ realisedPnl: -0.5 }),
    ]);
    // 2.50 at 85 to the dollar; past ₹100 the desk drops the paise
    await waitFor(() => expect(screen.getByText('+₹213')).toBeInTheDocument());
    expect(screen.getByText(/2 won/)).toBeInTheDocument();
    expect(screen.getByText(/1 lost/)).toBeInTheDocument();
  });

  it('counts only what has actually settled', async () => {
    show([
      order({ realisedPnl: 1 }),
      order({ status: 'pending', position: -1, realisedPnl: 0 }),
      order({ status: 'rejected', realisedPnl: 0, position: 0 }),
    ]);
    await waitFor(() => expect(screen.getByText(/1 of 3 closed/)).toBeInTheDocument());
  });

  it('says nothing at all when nothing has settled', async () => {
    show([order({ status: 'pending', position: -1 })]);
    await waitFor(() => expect(screen.getByText(/78,600/)).toBeInTheDocument());
    expect(screen.queryByText(/won/)).toBeNull();
  });

  it('[critical] a losing day is not shown in the winning colour', async () => {
    show([order({ realisedPnl: -2 })]);
    const totals = await screen.findByLabelText('totals for the range');
    // the row underneath says −₹170 too, which is the whole reason this is scoped
    expect(within(totals).getByText('−₹170').className).toContain('--down');
  });
});

describe('charges', () => {
  it('nets Delta charges out of the total, and says gross and charges beside it', async () => {
    show([order({
      realisedPnl: 1,
      netRealisedUsd: 0.97,
      charges: { entryUsd: 0.02, exitUsd: 0.01, paidUsd: 0.03, toCloseUsd: 0 },
    })]);
    const totals = await screen.findByLabelText('totals for the range');
    // 0.97 x 85 = 82.45, not the 85.00 it made before charges
    expect(within(totals).getByText('+₹82.45').className).toContain('--up');
    expect(within(totals).getByText('Gross +₹85.00')).toBeInTheDocument();
    expect(within(totals).getByText('Charges −₹2.55')).toBeInTheDocument();
  });
});

describe('why a trade ended', () => {
  it('says the target filled when the target filled', async () => {
    show([order()]);
    expect(await screen.findByText('target hit')).toBeInTheDocument();
  });

  it('tells a stop apart from a target', async () => {
    show([order({
      realisedPnl: -1,
      fills: [
        { orderId: '1', role: 'entry', side: 'sell', size: 1, price: 16, ts: OPENED },
        { orderId: '2', role: 'stop_loss', side: 'buy', size: 1, price: 22, ts: OPENED + 60_000 },
      ],
    })]);
    expect(await screen.findByText('stop hit')).toBeInTheDocument();
  });

  it('and both from a position squared off by hand', async () => {
    show([order({
      fills: [
        { orderId: '1', role: 'entry', side: 'sell', size: 1, price: 16, ts: OPENED },
        { orderId: '2', role: 'exit', side: 'buy', size: 1, price: 14, ts: OPENED + 60_000 },
      ],
    })]);
    expect(await screen.findByText('closed manually')).toBeInTheDocument();
  });

  it('claims nothing about a trade that never closed', async () => {
    show([order({ status: 'pending', position: -1, exitAvgPrice: null, fills: [] })]);
    await waitFor(() => expect(screen.getByText(/78,600/)).toBeInTheDocument());
    expect(screen.queryByText('target hit')).toBeNull();
  });
});

describe('the detail', () => {
  const openFirstRow = async () => {
    // the download button exists before any row does, so wait for the row
    const row = await waitFor(() => {
      const found = screen.getAllByRole('button')
        .find((b) => b.textContent?.includes('78,600'));
      if (!found) throw new Error('no row yet');
      return found;
    });
    row.click();
  };

  it('says how long it was held, which was not on the screen before', async () => {
    show([order()]);
    await openFirstRow();
    await waitFor(() => expect(screen.getByText('Held for')).toBeInTheDocument());
    expect(screen.getByText('3m 28s')).toBeInTheDocument();
  });

  it('says contracts once when nothing was left behind', async () => {
    show([order()]);
    await openFirstRow();
    await waitFor(() => expect(screen.getByText('Contracts')).toBeInTheDocument());
    const line = screen.getByText('Contracts').closest('div')!;
    expect(within(line).getByText('1')).toBeInTheDocument();
  });

  it('spells out a partial fill, because that is when the difference matters', async () => {
    show([order({ entrySize: 3, plan: { ...order().plan!, lots: 10 } })]);
    await openFirstRow();
    await waitFor(() => expect(screen.getByText('3 of 10 filled')).toBeInTheDocument());
  });
});
