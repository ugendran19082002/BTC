import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Trade, TradeStatus } from '@/types/trade';
import type { Glance } from '@/api/glance';

/**
 * The phone (6 Oct 2026): signs in view only, then shows the desk's health, today and the open positions --
 * the riskiest first -- with no button that could change anything.
 */

const getMe = vi.fn();
const login = vi.fn();
const logout = vi.fn();
vi.mock('@/api/session', async (orig) => ({
  ...(await orig<typeof import('@/api/session')>()),
  getMe: () => getMe(),
  login: (...a: unknown[]) => login(...a),
  logout: () => logout(),
}));
const getAccounts = vi.fn();
vi.mock('@/api/accounts', () => ({ getAccounts: () => getAccounts() }));
const getTradeStatus = vi.fn();
const getStatusOfAccounts = vi.fn();
vi.mock('@/api/trade', () => ({
  getTradeStatus: (...a: unknown[]) => getTradeStatus(...a),
  getStatusOfAccounts: (...a: unknown[]) => getStatusOfAccounts(...a),
}));
const getGlance = vi.fn();
vi.mock('@/api/glance', () => ({ getGlance: () => getGlance() }));
const json = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig<typeof import('@/api/client')>()),
  json: (...a: unknown[]) => json(...a),
}));

const { default: MobileApp } = await import('@/components/mobile/MobileApp');

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1', symbol: 'C-BTC-80000-071026', productId: 1, optionSide: 'CE', phase: 'protected',
  position: -100, requestedSize: 100, entrySize: 100, entryAvgPrice: 10, exitSize: 0, exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' }, realisedPnl: 0, fills: [], note: null, alarm: null, updatedAt: 0,
  plan: { lots: 100, entry: { type: 'limit', timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 1, stopPrice: 25 },
  onBook: { target: 1, stop: 25 },
  live: { markPrice: 8, bid: 7.5, ask: 8.5, unrealisedPnl: 0.2, decayed: 0.2, liquidationPrice: 300, netIfClosedUsd: 0.15 },
  ifExits: { target: 0.85, stop: -1.6 },
  ...over,
});

const status = (open: Trade[]): TradeStatus => ({
  mode: 'live', live: true, canGoLive: true, switchBlockedBy: null, balanceUsd: 100, walletUsd: 120, marginUsedUsd: 30,
  positions: [], open, alarms: [], realisedTodayUsd: -5,
  today: { realisedUsd: -5, unrealisedUsd: 0.35, chargesUsd: 0.4, netUsd: -5.05 },
  limits: { maxLeverage: 200, maxQuoteAgeMs: 0, maxSpreadPct: 0, minBookCoverage: 0, maxShortContracts: 0, maxDailyLossUsd: 25, minPremiumUsd: 0, allowPyramiding: false },
});

const glance = (over: Partial<Glance> = {}): Glance => ({
  at: Date.now(), health: 'ok', issues: [], boardAgeMs: 1_000, tapeAgeMs: 2_000,
  readings: {
    db: { ok: true, latencyMs: 3 }, board: { source: 'socket', connected: true, lastAt: Date.now() },
    tape: { source: 'socket', connected: true, lastAt: Date.now() }, delta: { usedPct: 12, rateLimited: 0, failed: 0 },
    latePasses: 0, errors: { open: 0, lastAt: null }, schedulerOn: true, mode: 'live',
  },
  btc: { spot: 62_000, perpMark: 62_010 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getAccounts.mockResolvedValue({ accounts: [{ id: 1, name: 'SELL', active: true, trading: true }], max: 5, canStore: true, mode: 'live' });
  getGlance.mockResolvedValue(glance());
  json.mockResolvedValue({ mode: 'live', day: '2026-10-06', samples: [], stats: { nowUsd: null, min: null, max: null, maxDrawdown: null }, days: [] });
  getTradeStatus.mockResolvedValue(status([trade()]));
});

describe('signing in', () => {
  it('[critical] asks for a view-only sign-in, and says what that means', async () => {
    getMe.mockResolvedValue({ required: true, signedIn: false, username: null, stage: 'none' });
    login.mockResolvedValue({ ok: true, next: 'code' });
    render(<MobileApp />);
    await screen.findByText(/will only/i);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'desk' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('desk', 'pw', { view: true }));
  });
});

describe('signed in', () => {
  beforeEach(() => getMe.mockResolvedValue({ required: true, signedIn: true, username: 'desk', stage: 'full', scope: 'view' }));

  it('shows the desk\'s health, today against the loss limit, and each position\'s room to its exits', async () => {
    render(<MobileApp />);
    expect(await screen.findByText('All OK')).toBeInTheDocument();
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.getByText('LIVE', { selector: 'span' })).toBeInTheDocument();
    // limit $25 less $5 booked: $20 left, at ₹85
    expect(await screen.findByText('₹1,700')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Daily loss limit used' })).toHaveAttribute('aria-valuenow', '20');
    // the stop 25, bought back at the offer 8.5: 16.5 points of room
    expect(await screen.findByText(/16\.50 pts away/)).toBeInTheDocument();
    expect(screen.getByText('Open positions · 1')).toBeInTheDocument();
  });

  it('[critical] has no button that could change the desk', async () => {
    render(<MobileApp />);
    await screen.findByText('All OK');
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names.sort()).toEqual(['Refresh now', 'Sign out']);
  });

  it('[critical] puts a position with a problem first and says what the problem is', async () => {
    getTradeStatus.mockResolvedValue(status([
      trade({ tradeId: 'calm', symbol: 'C-BTC-82000-071026' }),
      trade({ tradeId: 'bare', symbol: 'P-BTC-60000-071026', onBook: { target: 1, stop: null }, plan: { ...trade().plan!, stopPrice: null } }),
    ]));
    render(<MobileApp />);
    const alert = await screen.findByText('No stop behind this position.');
    const cards = screen.getAllByText(/^\d{2},\d{3} (CE|PE)$/).map((n) => n.textContent);
    expect(cards).toEqual(['60,000 PE', '82,000 CE']);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
  });

  it('says what needs a look when the desk is not all right', async () => {
    getGlance.mockResolvedValue(glance({ health: 'down', issues: [{ level: 'down', text: 'Option prices stopped 90 s ago.' }] }));
    render(<MobileApp />);
    expect(await screen.findByText('Something is down')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'What needs a look' })).getByText('Option prices stopped 90 s ago.')).toBeInTheDocument();
  });

  it('with no open positions, says so', async () => {
    getTradeStatus.mockResolvedValue(status([]));
    render(<MobileApp />);
    expect(await screen.findByText('No open positions.')).toBeInTheDocument();
  });

  it('offers each trading account, and every account together', async () => {
    getAccounts.mockResolvedValue({
      accounts: [{ id: 1, name: 'SELL', active: true, trading: true }, { id: 2, name: 'BUY', active: true, trading: true }, { id: 3, name: 'OFF', active: false }],
      max: 5, canStore: true, mode: 'live',
    });
    getStatusOfAccounts.mockResolvedValue(status([]));
    render(<MobileApp />);
    const nav = await screen.findByRole('navigation', { name: 'Accounts' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['All accounts', 'SELL', 'BUY']);
    await waitFor(() => expect(getStatusOfAccounts).toHaveBeenCalled());
    fireEvent.click(within(nav).getByRole('button', { name: 'BUY' }));
    await waitFor(() => expect(getTradeStatus).toHaveBeenCalledWith(2));
  });
});
