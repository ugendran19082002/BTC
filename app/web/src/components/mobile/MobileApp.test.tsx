import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderRecord, Trade, TradeStatus } from '@/types/trade';
import type { Glance } from '@/api/glance';
import { routeOf, searchOf } from '@/components/mobile/phone-context';
import { quickPicks } from '@/lib/custom-range';
import { todayIst } from '@/lib/report';

/**
 * The phone (6 Oct 2026): signs in view only, then five tabs -- Home, P&L, Positions, Orders, More -- every one
 * reading the desk and none able to change it, and any trade's journal one tap away or one Telegram link away.
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
const post = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig<typeof import('@/api/client')>()),
  json: (...a: unknown[]) => json(...a),
  post: (...a: unknown[]) => post(...a),
}));
const phone = {
  getOrders: vi.fn(), getStats: vi.fn(), getDaysFor: vi.fn(), getActivity: vi.fn(), getTradeDetail: vi.fn(),
  getTelegramLog: vi.fn(), methodNames: vi.fn(),
};
vi.mock('@/api/phone', () => ({
  getOrders: (...a: unknown[]) => phone.getOrders(...a),
  getStats: (...a: unknown[]) => phone.getStats(...a),
  getDaysFor: (...a: unknown[]) => phone.getDaysFor(...a),
  getActivity: (...a: unknown[]) => phone.getActivity(...a),
  getTradeDetail: (...a: unknown[]) => phone.getTradeDetail(...a),
  getTelegramLog: (...a: unknown[]) => phone.getTelegramLog(...a),
  methodNames: () => phone.methodNames(),
}));

const { default: MobileApp } = await import('@/components/mobile/MobileApp');

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1', symbol: 'C-BTC-80000-071026', productId: 1, optionSide: 'CE', phase: 'protected',
  position: -100, requestedSize: 100, entrySize: 100, entryAvgPrice: 10, exitSize: 0, exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: 'sl' }, realisedPnl: 0, fills: [], note: null, alarm: null, updatedAt: 0,
  plan: { lots: 100, entry: { type: 'limit', limitPrice: 10, timeoutMs: 5000, marketFallback: false }, takeProfitPrice: 1, stopPrice: 25 },
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
    passes: { count: 300, late: 0, maxMs: 400 }, errors: { open: 0, lastAt: null }, schedulerOn: true, mode: 'live',
  },
  btc: { spot: 62_000, perpMark: 62_010, perp: null },
  ...over,
});

const order = (over: Partial<OrderRecord> = {}): OrderRecord => ({
  ...trade(), status: 'completed', outcome: 'Filled 100 @ 10.00', openedAt: Date.now() - 60_000, ...over,
} as OrderRecord);

const emptyGroup = { key: 'all', trades: 0, wins: 0, losses: 0, winRate: null, grossProfitUsd: 0, grossLossUsd: 0, profitFactor: null, avgWinUsd: null, avgLossUsd: null, netUsd: 0, bestUsd: null, worstUsd: null };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/m');
  getAccounts.mockResolvedValue({ accounts: [{ id: 1, name: 'SELL', active: true, trading: true, readable: true }], max: 5, canStore: true, mode: 'live' });
  getGlance.mockResolvedValue(glance());
  json.mockResolvedValue({ mode: 'live', day: '2026-10-06', samples: [], stats: { nowUsd: null, min: null, max: null, maxDrawdown: null }, days: [] });
  getTradeStatus.mockResolvedValue(status([trade()]));
  phone.getOrders.mockResolvedValue({ from: '', to: '', counts: {}, trades: [order(), order({ tradeId: 't2', status: 'rejected', outcome: 'Rejected: margin' })] });
  phone.getStats.mockResolvedValue({ mode: 'live', from: '', to: '', overall: { ...emptyGroup, trades: 4, wins: 3, losses: 1, winRate: 0.75 }, byStrategy: [], byAccount: [] });
  phone.getDaysFor.mockResolvedValue({ from: '', to: '', days: [], totals: { realisedUsd: 0, chargesUsd: 0, netUsd: 0, tradingDays: 0, winDays: 0, lossDays: 0, best: null, worst: null } });
  phone.getActivity.mockResolvedValue({ today: '2026-10-06', schedulerOn: true, mode: 'live', balanceUsd: 0, spot: null, strategies: [], runs: [], signalRuns: [] });
  phone.getTelegramLog.mockResolvedValue({ configured: true, on: true, entries: [] });
  phone.methodNames.mockResolvedValue(new Map());
  phone.getTradeDetail.mockResolvedValue({
    trade: trade(),
    events: [
      { t: 'entry_submitted', clientOrderId: 'c', size: 100, limitPrice: 10, at: 1_000 },
      { t: 'fill', role: 'entry', side: 'sell', size: 100, price: 10, orderId: 'o', at: 2_000 },
      { t: 'protection_placed', takeProfit: 'tp', stopLoss: 'sl', size: 100, at: 3_000 },
    ],
  });
});

const signedIn = () => getMe.mockResolvedValue({ required: true, signedIn: true, username: 'desk', stage: 'full', scope: 'view' });
const tab = (name: string) => fireEvent.click(within(screen.getByRole('navigation', { name: 'Screens' })).getByRole('button', { name: new RegExp(`^${name}`) }));

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
  beforeEach(signedIn);

  it('Home: the desk\'s state, today\'s money and the open positions on one screen', async () => {
    render(<MobileApp />);
    expect(await screen.findByText('Today\'s P&L')).toBeInTheDocument();
    expect(screen.getByText('Scheduler')).toBeInTheDocument();
    expect(screen.getByText('API usage')).toBeInTheDocument();
    expect(await screen.findByText('−₹429')).toBeInTheDocument(); // −$5.05 at ₹85
    expect(await screen.findByText('75%')).toBeInTheDocument(); // win rate
    expect(screen.getByText('Open positions · 1')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Daily loss limit used' })).toHaveAttribute('aria-valuenow', '20');
  });

  it('[critical] no screen has a button that could change the desk', async () => {
    render(<MobileApp />);
    await screen.findByText('Today\'s P&L');
    const forbidden = /\b(close|cancel (the|this)|place|square|edit|add lots|delete|remove|go live|switch (on|off)|turn (on|off)|arm|disarm)\b/i;
    for (const t of ['Home', 'P&L', 'Positions', 'Orders', 'More']) {
      tab(t);
      await waitFor(() => expect(screen.getByRole('navigation', { name: 'Screens' })).toBeInTheDocument());
      const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
      for (const n of names) expect(n, `${t}: "${n}"`).not.toMatch(forbidden);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('[critical] Positions puts a position with a problem first and says what the problem is', async () => {
    getTradeStatus.mockResolvedValue(status([
      trade({ tradeId: 'calm', symbol: 'C-BTC-82000-071026' }),
      trade({ tradeId: 'bare', symbol: 'P-BTC-60000-071026', onBook: { target: 1, stop: null }, plan: { ...trade().plan!, stopPrice: null } }),
    ]));
    render(<MobileApp />);
    await screen.findByText('Today\'s P&L');
    tab('Positions');
    const alert = await screen.findByText('No stop behind this position.');
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    const cards = screen.getAllByText(/^\d{2},\d{3} (CE|PE)$/).map((n) => n.textContent);
    expect(cards).toEqual(['60,000 PE', '82,000 CE']);
  });

  it('a position opens its whole story, and Back closes it', async () => {
    render(<MobileApp />);
    await screen.findByText('Today\'s P&L');
    tab('Positions');
    fireEvent.click(await screen.findByRole('button', { name: /what happened/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Trade detail' });
    expect(await within(dialog).findByText('Entry order sent: 100 contracts at 10.00')).toBeInTheDocument();
    expect(within(dialog).getByText('Target and stop placed at the exchange')).toBeInTheDocument();
    expect(window.location.search).toBe('?tab=positions&trade=t1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('[critical] the Telegram link /m?trade=<id> opens that trade', async () => {
    window.history.replaceState(null, '', '/m?trade=t1');
    render(<MobileApp />);
    expect(await screen.findByRole('dialog', { name: 'Trade detail' })).toBeInTheDocument();
    await waitFor(() => expect(phone.getTradeDetail).toHaveBeenCalledWith('t1'));
  });

  it('Orders filters by status and counts each', async () => {
    render(<MobileApp />);
    await screen.findByText('Today\'s P&L');
    tab('Orders');
    const filters = await screen.findByRole('group', { name: 'Order status' });
    await waitFor(() => expect(within(filters).getByRole('button', { name: 'Rejected · 1' })).toBeInTheDocument());
    fireEvent.click(within(filters).getByRole('button', { name: 'Rejected · 1' }));
    const list = screen.getByRole('list', { name: 'Orders' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText(/Rejected: margin/)).toBeInTheDocument();
  });

  it('says what needs a look when the desk is not all right', async () => {
    getGlance.mockResolvedValue(glance({ health: 'down', issues: [{ level: 'down', text: 'Option prices stopped 90 s ago.' }] }));
    render(<MobileApp />);
    expect(await screen.findAllByText('Option prices stopped 90 s ago.')).not.toHaveLength(0);
  });

  it('offers each trading account, and every account together', async () => {
    getAccounts.mockResolvedValue({
      accounts: [{ id: 1, name: 'SELL', active: true, trading: true, readable: true }, { id: 2, name: 'BUY', active: true, trading: true, readable: true }, { id: 3, name: 'OFF', active: false, readable: true }],
      max: 5, canStore: true, mode: 'live',
    });
    getStatusOfAccounts.mockResolvedValue(status([]));
    render(<MobileApp />);
    const chips = await screen.findByRole('group', { name: 'Accounts' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All accounts', 'SELL', 'BUY']);
    await waitFor(() => expect(getStatusOfAccounts).toHaveBeenCalled());
    fireEvent.click(within(chips).getByRole('button', { name: 'BUY' }));
    await waitFor(() => expect(getTradeStatus).toHaveBeenCalledWith(2));
  });
});

describe('switching to the desk', () => {
  it('[critical] a view-only phone says why the desk needs a full sign-in, and offers it; "Stay here" stays', async () => {
    signedIn();
    window.history.replaceState(null, '', '/m?tab=more');
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to desk view' }));
    const ask = screen.getByRole('dialog', { name: 'Switch to desk view' });
    expect(within(ask).getByText(/needs a full sign-in/)).toBeInTheDocument();
    expect(within(ask).getByRole('button', { name: 'Sign in to the desk' })).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Stay here' }));
    expect(screen.queryByRole('dialog', { name: 'Switch to desk view' })).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });
});

describe('P&L: the day\'s high and low (owner, 6 Oct 2026)', () => {
  it('today shows the high, the low and the deepest fall with their times; over days, the best and worst day', async () => {
    signedIn();
    const at = (h: number, m: number) => Date.UTC(2026, 9, 6, h - 5, m - 30);
    json.mockResolvedValue({
      mode: 'live', day: '2026-10-06', days: [],
      samples: [{ at: at(9, 0), day: '2026-10-06', realisedUsd: 0, unrealisedUsd: 0, chargesUsd: 0, netUsd: -4 }, { at: at(14, 0), day: '2026-10-06', realisedUsd: 0, unrealisedUsd: 0, chargesUsd: 0, netUsd: 30 }],
      stats: { nowUsd: 30, max: { at: at(13, 5), netUsd: 36 }, min: { at: at(9, 40), netUsd: -6 }, maxDrawdown: { usd: 8, at: at(13, 50) } },
    });
    phone.getDaysFor.mockResolvedValue({ from: '', to: '', days: [], totals: { realisedUsd: 0, chargesUsd: 0, netUsd: 0, tradingDays: 2, winDays: 1, lossDays: 1, best: { day: '2026-10-02', netUsd: 12 }, worst: { day: '2026-10-04', netUsd: -5 } } });
    window.history.replaceState(null, '', '/m?tab=pnl');
    render(<MobileApp />);
    const high = (await screen.findByText('Day high')).parentElement!;
    expect(high).toHaveTextContent('+₹3,060');
    expect(high).toHaveTextContent('13:05');
    expect(screen.getByText('Day low').parentElement!).toHaveTextContent('−₹510');
    expect(screen.getByText('Drawdown').parentElement!).toHaveTextContent('−₹680');
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    const best = (await screen.findByText('Best day')).parentElement!;
    expect(best).toHaveTextContent('+₹1,020');
    expect(best).toHaveTextContent('2026-10-02');
    expect(screen.getByText('Worst day').parentElement!).toHaveTextContent('−₹425');
  });
});

describe('P&L: a custom From and To (owner, 6 Oct 2026)', () => {
  beforeEach(() => { signedIn(); window.history.replaceState(null, '', '/m?tab=pnl'); });

  it('[critical] Custom, last in the row, opens a sheet; a quick pick and Show read exactly that range', async () => {
    render(<MobileApp />);
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((r) => r.textContent).at(-1)).toBe('Custom');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    const sheet = screen.getByRole('dialog', { name: 'Custom range' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Last week' }));
    const week = quickPicks(todayIst()).find((q) => q.label === 'Last week')!.range;
    expect(within(sheet).getByLabelText('From')).toHaveValue(week.from);
    expect(within(sheet).getByLabelText('To')).toHaveValue(week.to);
    expect(within(sheet).getByRole('status')).toHaveTextContent('7 days');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Custom range' })).toBeNull());
    await waitFor(() => expect(phone.getStats).toHaveBeenCalledWith(week.from, week.to, null));
    expect(screen.getByRole('radio', { name: 'Custom' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('a backwards range says why and cannot be shown; Cancel keeps the range there was', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Custom' }));
    const sheet = screen.getByRole('dialog', { name: 'Custom range' });
    fireEvent.change(within(sheet).getByLabelText('From'), { target: { value: '2026-10-05' } });
    fireEvent.change(within(sheet).getByLabelText('To'), { target: { value: '2026-10-01' } });
    expect(within(sheet).getByRole('alert')).toHaveTextContent('on or before');
    expect(within(sheet).getByRole('button', { name: 'Show' })).toBeDisabled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Custom range' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Today' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the back button', () => {
  it('[critical] each move leaves one step, and tapping the tab already open leaves none', async () => {
    signedIn();
    render(<MobileApp />);
    await screen.findByText('Today\'s P&L');
    const before = window.history.length;
    tab('Orders');
    await waitFor(() => expect(window.location.search).toBe('?tab=orders'));
    tab('Orders');
    expect(window.history.length).toBe(before + 1);
    tab('P&L');
    expect(window.history.length).toBe(before + 2);
  });
});

describe('the route in the address', () => {
  it('reads and writes tab, sub-screen and trade, and ignores anything else', () => {
    expect(routeOf('')).toEqual({ tab: 'home', sub: null, trade: null });
    expect(routeOf('?tab=more&sub=alerts')).toEqual({ tab: 'more', sub: 'alerts', trade: null });
    expect(routeOf('?tab=orders&sub=alerts')).toEqual({ tab: 'orders', sub: null, trade: null });
    expect(routeOf('?tab=nonsense&trade=C-BTC-1')).toEqual({ tab: 'home', sub: null, trade: 'C-BTC-1' });
    expect(searchOf({ tab: 'more', sub: 'account', trade: null })).toBe('?tab=more&sub=account');
    expect(searchOf({ tab: 'home', sub: null, trade: null })).toBe('');
  });
});
