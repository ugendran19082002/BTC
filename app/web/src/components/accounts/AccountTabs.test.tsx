import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AccountTabs, shownAccount } from '@/components/accounts/AccountTabs';
import { AccountSummaryCard } from '@/components/accounts/AccountSummaryCard';
import type { BrokerAccount } from '@/api/accounts';
import { accountScope, canMakeForAccount, setAccountScope, withAccount } from '@/lib/account-scope';

const getAccountSummary = vi.fn();
vi.mock('@/api/accounts', () => ({ getAccountSummary: (...a: unknown[]) => getAccountSummary(...a) }));

const account = (o: Partial<BrokerAccount> = {}): BrokerAccount => ({
  id: 1, name: 'Main', description: '', broker: 'delta-india', keyHint: '9999', active: true, isDefault: true,
  readable: true, createdAt: 0, updatedAt: 0, lastTest: null, ...o,
});
const second = account({ id: 2, name: 'Second', isDefault: false });
const off = account({ id: 3, name: 'Old', isDefault: false, active: false });

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(() => setAccountScope(null));

describe('the account tabs', () => {
  it('[critical] a tab per account, the default first and marked, then All -- and a tap chooses what is shown', () => {
    const onChange = vi.fn();
    render(<AccountTabs accounts={[second, off, account()]} value={1} onChange={onChange} />);
    const tabs = within(screen.getByRole('tablist', { name: 'Broker account' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Main default', 'Second', 'Old off', 'All accounts']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tabs[1]!);
    expect(onChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(tabs[3]!);
    expect(onChange).toHaveBeenLastCalledWith('all');
  });

  it('one account needs no All; no account, no tabs', () => {
    const { unmount } = render(<AccountTabs accounts={[account()]} value={1} onChange={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Main default']);
    unmount();
    render(<AccountTabs accounts={[]} value="all" onChange={() => {}} />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('[critical] opens on the account the desk trades on, keeps a choice that still exists, and falls back when it does not', () => {
    const list = [second, account()];
    expect(shownAccount(list, null)).toBe(1);
    expect(shownAccount(list, 2)).toBe(2);
    expect(shownAccount(list, 'all')).toBe('all');
    expect(shownAccount(list, 99)).toBe(1); // the chosen account was removed
    expect(shownAccount([account()], 'all')).toBe(1); // one account: there is no All
    expect(shownAccount([second], null)).toBe(2); // no default: the first there is
    expect(shownAccount([], null)).toBe('all'); // a desk with no account shows everything, as before
  });

  it('[critical] Strategy has no "All accounts": a remembered "all" shows the default account there', () => {
    const two = [{ id: 1, name: 'SELL', isDefault: true, active: true }, { id: 2, name: 'BUY', isDefault: false, active: true }] as never;
    expect(shownAccount(two, 'all')).toBe('all');
    expect(shownAccount(two, 'all', false)).toBe(1);
    expect(shownAccount(two, 2, false)).toBe(2);
    const { unmount } = render(<AccountTabs accounts={two} value={1} onChange={() => {}} withAll={false} />);
    expect(screen.queryByRole('tab', { name: /All accounts/ })).toBeNull();
    unmount();
    render(<AccountTabs accounts={two} value={1} onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: /All accounts/ })).toBeInTheDocument();
  });

  it('[critical] the screens\' calls ask for the account being shown, and for nothing when it is every account', () => {
    expect(withAccount('/api/strategies')).toBe('/api/strategies');
    setAccountScope(2);
    expect(accountScope()).toBe(2);
    expect(withAccount('/api/strategies')).toBe('/api/strategies?account=2');
    expect(withAccount('/api/report/days?from=a&to=b')).toBe('/api/report/days?from=a&to=b&account=2');
  });

  it('[critical] a strategy is made on an account\'s tab, never on All accounts -- and a desk with no account is not stopped', () => {
    setAccountScope(2);
    expect(canMakeForAccount()).toBe(true);
    setAccountScope(null, true); // the All accounts tab
    expect(canMakeForAccount()).toBe(false);
    expect(withAccount('/api/strategies')).toBe('/api/strategies');
    setAccountScope(null); // no account at all: as it was before there were accounts
    expect(canMakeForAccount()).toBe(true);
  });

  it('an account that is switched off, on Positions: its wallet and what it holds on Delta, and where to switch it on', async () => {
    getAccountSummary.mockResolvedValue({
      id: 2, wallet: { balance: 120.5, available: 100 }, trades: 4, strategies: 2, note: null,
      positions: [{ symbol: 'P-BTC-83800-230926', size: -3, entryPrice: 20, unrealisedPnl: 1.5 }],
    });
    render(<AccountSummaryCard account={{ ...second, active: false, trading: false }} />);
    const card = within(await screen.findByLabelText('account summary'));
    expect(card.getByText(/is switched off, so the desk places and manages nothing on it/)).toHaveTextContent(
      'Second is switched off, so the desk places and manages nothing on it. Activate it under Logs → Accounts and its own strategies trade on it, beside the other accounts.');
    const table = within(await card.findByRole('table', { name: 'positions on Second' }));
    expect(table.getByText('83,800 PE')).toBeInTheDocument();
    expect(table.getByText('short')).toBeInTheDocument();
    expect(card.getByText('Trades on record').nextSibling).toHaveTextContent('4');
    expect(getAccountSummary).toHaveBeenCalledWith(2);
  });
});
