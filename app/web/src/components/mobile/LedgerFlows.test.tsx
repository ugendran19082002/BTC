import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { LedgerFlows as Flows } from '@/api/ledger';

/** Money in and out on the phone's Ledger (owner, 20 Nov 2026: "total withdraw, total investment, mobile friendly"). */

const getLedgerFlows = vi.fn();
vi.mock('@/api/ledger', async (orig) => ({ ...(await orig<typeof import('@/api/ledger')>()), getLedgerFlows: (...a: unknown[]) => getLedgerFlows(...a) }));
const { LedgerFlows } = await import('@/components/mobile/LedgerFlows');
const { kindWords } = await import('@/components/mobile/FlowsSheet');

const flows = (o: Partial<Flows> = {}): Flows => ({
  account: 3, from: '2026-11-14', to: '2026-11-20', since: '2026-08-05', daysRead: 108,
  allTime: { inUsd: 1_000, outUsd: 400, netUsd: 600, moves: 12, firstMoveDay: '2026-08-05', lastMoveDay: '2026-11-19' },
  range: { inUsd: 100, outUsd: 30, netUsd: 70, moves: 3, firstMoveDay: '2026-11-15', lastMoveDay: '2026-11-19' },
  wallet: { balanceUsd: 720, asOf: '2026-11-19', accounts: 1 },
  profitUsd: 120,
  records: [
    { day: '2026-11-19', account: 3, type: 'sub_account_transfer', inUsd: 80, outUsd: 0, n: 2 },
    { day: '2026-11-19', account: 3, type: 'sub_account_transfer', inUsd: 0, outUsd: 30, n: 1 },
    { day: '2026-11-19', account: 4, type: 'deposit', inUsd: 20, outUsd: 0, n: 1 },
    { day: '2026-11-05', account: 3, type: 'withdrawal', inUsd: 0, outUsd: 370, n: 2 },
    { day: '2026-08-05', account: 3, type: 'deposit', inUsd: 900, outUsd: 0, n: 1 },
  ],
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

  describe('date wise, on a tap (20 Nov 2026)', () => {
    it('[critical] Invested opens its records day by day, newest first, each kind with its amount; the total matches the tile', async () => {
      getLedgerFlows.mockResolvedValue(flows());
      render(<LedgerFlows from="2026-11-14" to="2026-11-20" account={null} rangeWords="Last 7 days" accounts={[{ id: 3, name: 'Low' }, { id: 4, name: 'Income' }]} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Invested: show it date wise' }));
      const sheet = screen.getByRole('dialog', { name: 'Invested · date wise' });
      expect(within(sheet).getByLabelText('Total')).toHaveTextContent('3 records · 2 days');
      expect(within(sheet).getByLabelText('Total')).toHaveTextContent('₹85,000');
      const days = within(within(sheet).getByRole('list', { name: 'Invested, date wise' })).getAllByRole('listitem').filter((li) => li.getAttribute('aria-label'));
      expect(days.map((d) => d.getAttribute('aria-label'))).toHaveLength(2);
      expect(days[0]).toHaveTextContent('Moved in from another account');
      expect(days[0]).toHaveTextContent('Low · 2 entries');
      expect(days[0]).toHaveTextContent('Deposit');
      expect(days[0]).toHaveTextContent('Income · 1 entry');
      expect(days[0]).toHaveTextContent('₹8,500');                       // the day: 80 + 20 dollars
      expect(days[1]).toHaveTextContent('₹76,500');
      expect(sheet).not.toHaveTextContent('Withdrawal');
    });

    it('[critical] Withdrawn opens the money out only', async () => {
      getLedgerFlows.mockResolvedValue(flows());
      render(<LedgerFlows from="2026-11-14" to="2026-11-20" account={3} rangeWords="Last 7 days" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Withdrawn: show it date wise' }));
      const sheet = screen.getByRole('dialog', { name: 'Withdrawn · date wise' });
      expect(within(sheet).getByLabelText('Total')).toHaveTextContent('₹34,000');
      expect(sheet).toHaveTextContent('Moved out to another account');
      expect(sheet).toHaveTextContent('Withdrawal');
      expect(sheet).not.toHaveTextContent('Deposit');
      expect(sheet).not.toHaveTextContent('Low ·');                       // one account: its name is not repeated
    });

    it('closes with the cross, and with Escape', async () => {
      getLedgerFlows.mockResolvedValue(flows());
      render(<LedgerFlows from="2026-11-14" to="2026-11-20" account={3} rangeWords="Last 7 days" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Invested: show it date wise' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Withdrawn: show it date wise' }));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('the kinds in words, by direction', () => {
      expect(kindWords('sub_account_transfer', 'in')).toBe('Moved in from another account');
      expect(kindWords('sub_account_transfer', 'out')).toBe('Moved out to another account');
      expect(kindWords('deposit', 'in')).toBe('Deposit');
      expect(kindWords('withdrawal', 'out')).toBe('Withdrawal');
      expect(kindWords('withdrawal_cancellation', 'in')).toBe('Withdrawal cancelled');
      expect(kindWords('fund_wallet_deposit', 'in')).toBe('Fund deposit');
    });
  });

  describe('in the Ledger\'s totals card (20 Nov 2026: "merge, mobile responsive")', () => {
    it('[critical] bare: no card of its own -- its heading a divider inside the card it sits in, the same figures and taps', async () => {
      getLedgerFlows.mockResolvedValue(flows());
      const { container } = render(<section aria-label="Ledger totals"><LedgerFlows bare from="2026-11-14" to="2026-11-20" account={3} rangeWords="Last 7 days" /></section>);
      const box = await screen.findByRole('region', { name: 'Money in and out' });
      expect(within(box).getByText('Money in & out')).toBeInTheDocument();
      expect(within(box).getByText(/^Since /)).toBeInTheDocument();
      expect(within(box).getByText('₹85,000')).toBeInTheDocument();
      expect(container.querySelectorAll('section[aria-label="Ledger totals"] > section')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Invested: show it date wise' }));
      expect(screen.getByRole('dialog', { name: 'Invested · date wise' })).toBeInTheDocument();
    });

    it('the tiles: two across on a phone, four across from 460px', async () => {
      getLedgerFlows.mockResolvedValue(flows());
      render(<LedgerFlows bare from="2026-11-14" to="2026-11-20" account={3} rangeWords="Last 7 days" />);
      const tiles = (await screen.findByText('Invested')).closest('dl')!;
      expect(tiles.className).toContain('grid-cols-2');
      expect(tiles.className).toContain('min-[460px]:grid-cols-4');
    });
  });
});
