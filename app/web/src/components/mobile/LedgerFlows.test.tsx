import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { LedgerFlows as Flows } from '@/api/ledger';

/** Money in and out on the phone's Ledger (owner, 20 Nov 2026: "total withdraw, total investment, mobile friendly"). */

const getLedgerFlows = vi.fn();
vi.mock('@/api/ledger', async (orig) => ({ ...(await orig<typeof import('@/api/ledger')>()), getLedgerFlows: (...a: unknown[]) => getLedgerFlows(...a) }));
const { LedgerFlows } = await import('@/components/mobile/LedgerFlows');

const flows = (o: Partial<Flows> = {}): Flows => ({
  account: 3, from: '2026-11-14', to: '2026-11-20', since: '2026-08-05', daysRead: 108,
  allTime: { inUsd: 1_000, outUsd: 400, netUsd: 600, moves: 12, firstMoveDay: '2026-08-05', lastMoveDay: '2026-11-19' },
  range: { inUsd: 100, outUsd: 30, netUsd: 70, moves: 3, firstMoveDay: '2026-11-15', lastMoveDay: '2026-11-19' },
  wallet: { balanceUsd: 720, asOf: '2026-11-19', accounts: 1 },
  profitUsd: 120,
  ...o,
});

beforeEach(() => { getLedgerFlows.mockReset(); });

describe('Money in & out', () => {
  it('[critical] invested, withdrawn, net invested and the wallet, in rupees, since the first ledger day', async () => {
    getLedgerFlows.mockResolvedValue(flows());
    render(<LedgerFlows from="2026-11-14" to="2026-11-20" account={3} rangeWords="Last 7 days" />);
    const box = await screen.findByRole('region', { name: 'Money in and out' });
    expect(within(box).getByText('Invested')).toBeInTheDocument();
    expect(within(box).getByText('₹85,000')).toBeInTheDocument();      // $1,000 at ₹85
    expect(within(box).getByText('Withdrawn')).toBeInTheDocument();
    expect(within(box).getByText('₹34,000')).toBeInTheDocument();
    expect(within(box).getByText('Net invested')).toBeInTheDocument();
    expect(within(box).getByText('₹51,000')).toBeInTheDocument();
    expect(within(box).getByText(/^Wallet · /)).toBeInTheDocument();
    expect(within(box).getByText('₹61,200')).toBeInTheDocument();
    expect(within(box).getByText(/^Since /)).toBeInTheDocument();
    expect(getLedgerFlows).toHaveBeenCalledWith('2026-11-14', '2026-11-20', 3);
  });

  it('[critical] what the money made: the wallet less the net put in, signed', async () => {
    getLedgerFlows.mockResolvedValue(flows());
    render(<LedgerFlows from="2026-11-14" to="2026-11-20" account={3} rangeWords="Last 7 days" />);
    const made = await screen.findByLabelText('Made');
    expect(made).toHaveTextContent('wallet − net invested');
    expect(made).toHaveTextContent('10,200');
  });

  it('the range picked above: money in and out over it, and its net', async () => {
    getLedgerFlows.mockResolvedValue(flows());
    render(<LedgerFlows from="2026-11-14" to="2026-11-20" account={3} rangeWords="Last 7 days" />);
    const row = await screen.findByLabelText('In the range');
    expect(row).toHaveTextContent('Last 7 days');
    expect(row).toHaveTextContent('in ₹8,500');
    expect(row).toHaveTextContent('out ₹2,550');
    expect(row).toHaveTextContent('net');
  });

  it('every account says so; nothing moved says so, without empty tiles', async () => {
    getLedgerFlows.mockResolvedValue(flows({ account: null, allTime: { inUsd: 0, outUsd: 0, netUsd: 0, moves: 0, firstMoveDay: null, lastMoveDay: null }, profitUsd: null }));
    render(<LedgerFlows from="2026-11-14" to="2026-11-20" account={null} rangeWords="Last 7 days" />);
    expect(await screen.findByText(/every account/)).toBeInTheDocument();
    expect(screen.getByText(/No money put in or taken out/)).toBeInTheDocument();
    expect(screen.queryByText('Invested')).toBeNull();
    expect(screen.queryByLabelText('Made')).toBeNull();
  });

  it('a read that fails says so in the panel, never a blank screen', async () => {
    getLedgerFlows.mockRejectedValue(new Error('offline'));
    render(<LedgerFlows from="2026-11-14" to="2026-11-20" account={3} rangeWords="Last 7 days" />);
    expect(await screen.findByText(/offline|money in and out/i)).toBeInTheDocument();
  });
});
