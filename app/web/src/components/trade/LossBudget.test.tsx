import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TradeStatus } from '@/types/trade';
import type { LossLimit } from '@/api/desk';

const getSettings = vi.fn();
const setLossLimit = vi.fn();
vi.mock('@/api/desk', () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
  setLossLimit: (...a: unknown[]) => setLossLimit(...a),
}));
const { LossBudget } = await import('@/components/trade/LossBudget');
const { lossBudget } = await import('@/lib/position-risk');
const { mergeStatuses } = await import('@/lib/merge-status');

/** $100 a day, on, nothing chosen: half of a $200 account. */
const status = (over: Partial<TradeStatus> = {}, limits: Partial<TradeStatus['limits']> = {}): TradeStatus => ({
  mode: 'live', live: true, canGoLive: true, switchBlockedBy: null,
  balanceUsd: 200, unrealisedPnlUsd: 0, realisedTodayUsd: 0,
  positions: [], open: [], alarms: [],
  limits: {
    maxLeverage: 200, maxQuoteAgeMs: 3000, maxSpreadPct: 0.04, minBookCoverage: 0.5,
    maxShortContracts: 500, maxDailyLossUsd: 100, dailyLossOn: true, minPremiumUsd: 5, allowPyramiding: false, ...limits,
  },
  ...over,
});
const limit = (over: Partial<LossLimit> = {}): LossLimit => ({ on: true, inForceUsd: 100, defaultUsd: 100, chosenUsd: null, ...over });
const answer = (l: LossLimit) => ({ ok: true as const, key: 'k', value: 'v', lossLimit: l });
const left = (c: HTMLElement) => c.querySelector('[aria-label="loss budget left"]');
const toggle = () => screen.getByRole('switch', { name: 'Daily loss limit' });

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({ settings: {}, shortCap: { inForce: 500, ceiling: null, chosen: null }, lossLimit: limit() });
  setLossLimit.mockReset();
});

describe('the day\'s loss limit, on the screen (13 Oct 2026)', () => {
  it('[critical] is on until it is switched off, and says what is left of it', () => {
    const { container } = render(<LossBudget status={status({ realisedTodayUsd: -25 })} />);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    expect(left(container)).toHaveTextContent('₹6,375 of ₹8,500 left');
    expect(screen.getByText(/25% used/)).toBeInTheDocument();
  });

  it('a server from before the switch says nothing of it: the limit is on, as it always was', () => {
    const s = status();
    delete s.limits.dailyLossOn;
    render(<LossBudget status={s} />);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });

  it('[critical] spent, it says so -- and that the limit can be raised or switched off', () => {
    const { container } = render(<LossBudget status={status({ realisedTodayUsd: -182 })} />);
    expect(left(container)).toHaveTextContent('₹0 of ₹8,500 left');
    expect(screen.getByText(/Limit reached\. New trades are blocked until tomorrow — or raise the limit, or switch it off\./)).toBeInTheDocument();
  });

  it('[critical] switched off, it reads Off -- no bar, no "left", and what it would be if switched on', () => {
    const { container } = render(<LossBudget status={status({ realisedTodayUsd: -182 }, { dailyLossOn: false })} />);
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    expect(left(container)).toHaveTextContent(/^Off$/);
    expect(screen.getByText(/Today's losses stop no new trade\. Switched on, the limit is ₹8,500\./)).toBeInTheDocument();
    expect(screen.queryByText(/Limit reached/)).toBeNull();
  });

  it('[critical] the switch asks the server, and shows its answer before the next poll', async () => {
    setLossLimit.mockResolvedValue(answer(limit({ on: false })));
    const { container } = render(<LossBudget status={status({ realisedTodayUsd: -182 })} />);
    fireEvent.click(toggle());
    expect(setLossLimit).toHaveBeenCalledWith({ on: false });
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
    expect(left(container)).toHaveTextContent(/^Off$/);
  });

  it('a switch the server would not make stays as it was, with the reason', async () => {
    setLossLimit.mockRejectedValue(new Error('This account is not one this desk trades.'));
    render(<LossBudget status={status()} />);
    fireEvent.click(toggle());
    expect(await screen.findByRole('alert')).toHaveTextContent('This account is not one this desk trades.');
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the amount', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Edit the daily loss limit' }));
  const field = () => screen.getByLabelText('daily loss limit in rupees') as HTMLInputElement;

  it('[critical] opens on the limit in force, in rupees, and says the default is half the account', async () => {
    render(<LossBudget status={status()} />);
    open();
    expect(field().value).toBe('8500');
    expect(await screen.findByText(/This is the default: half the account, ₹8,500\./)).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00 at ₹85 per \$1\./)).toBeInTheDocument();
    // Nothing chosen yet: there is no default to go back to.
    expect(screen.queryByRole('button', { name: 'Back to the default' })).toBeNull();
  });

  it('[critical] saved, it is sent in dollars and shown from the answer', async () => {
    setLossLimit.mockResolvedValue(answer(limit({ inForceUsd: 250, chosenUsd: 250 })));
    const { container } = render(<LossBudget status={status({ realisedTodayUsd: -182 })} />);
    open();
    fireEvent.change(field(), { target: { value: '21250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(setLossLimit).toHaveBeenCalledWith({ usd: 250 });
    // 250 less the 182 lost: 68 left, where a moment ago nothing was.
    await waitFor(() => expect(left(container)).toHaveTextContent('₹5,780 of ₹21,250 left'));
    expect(screen.queryByLabelText('daily loss limit in rupees')).toBeNull();
    expect(screen.queryByText(/Limit reached/)).toBeNull();
  });

  it('not an amount: said here, without asking the server', () => {
    render(<LossBudget status={status()} />);
    open();
    for (const bad of ['', '0', '-40']) {
      fireEvent.change(field(), { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount in rupees, above 0.');
    }
    expect(setLossLimit).not.toHaveBeenCalled();
  });

  it('an amount the server refuses: its reason, and the form stays open', async () => {
    setLossLimit.mockRejectedValue(new Error('The loss budget must be an amount above 0, up to $1,000,000.'));
    render(<LossBudget status={status()} />);
    open();
    fireEvent.change(field(), { target: { value: '999999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The loss budget must be an amount above 0, up to $1,000,000.');
    expect(field()).toBeInTheDocument();
  });

  it('[critical] with an amount chosen: back to the default is one press', async () => {
    getSettings.mockResolvedValue({ settings: {}, shortCap: { inForce: 500, ceiling: null, chosen: null }, lossLimit: limit({ inForceUsd: 250, chosenUsd: 250 }) });
    setLossLimit.mockResolvedValue(answer(limit()));
    const { container } = render(<LossBudget status={status({}, { maxDailyLossUsd: 250 })} />);
    open();
    expect(await screen.findByText(/The default is half the account, ₹8,500\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the default' }));
    expect(setLossLimit).toHaveBeenCalledWith({ usd: null });
    await waitFor(() => expect(left(container)).toHaveTextContent('₹8,500 of ₹8,500 left'));
  });

  it('cancel leaves everything as it was', () => {
    render(<LossBudget status={status()} />);
    open();
    fireEvent.change(field(), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('daily loss limit in rupees')).toBeNull();
    expect(setLossLimit).not.toHaveBeenCalled();
  });
});

describe('several accounts together, and the figures built on the limit', () => {
  const part = (id: number, s: TradeStatus) => ({ account: { id, name: `A${id}` }, status: s });

  it('[critical] "All accounts": the sum, read only -- no switch, no amount to change', () => {
    const all = mergeStatuses([part(1, status({ realisedTodayUsd: -10 })), part(2, status({}, { maxDailyLossUsd: 50 }))])!;
    const { container } = render(<LossBudget status={all} />);
    expect(left(container)).toHaveTextContent('₹11,900 of ₹12,750 left');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit the daily loss limit' })).toBeNull();
    expect(screen.getByText(/Each account's own limit, added up\. Change one on its own tab\./)).toBeInTheDocument();
  });

  it('[critical] an account with its limit off adds nothing to the sum, or to what is left', () => {
    const all = mergeStatuses([part(1, status({ realisedTodayUsd: -10 })), part(2, status({}, { maxDailyLossUsd: 50, dailyLossOn: false }))])!;
    expect(all.combined).toMatchObject({ lossLimitUsd: 100, lossLeftUsd: 90 });
    expect(all.limits.dailyLossOn).toBe(true);
    const none = mergeStatuses([part(1, status({}, { dailyLossOn: false })), part(2, status({}, { dailyLossOn: false }))])!;
    expect(none.combined).toMatchObject({ lossLimitUsd: 0, lossLeftUsd: 0 });
    expect(none.limits.dailyLossOn).toBe(false);
    const { container } = render(<LossBudget status={none} />);
    expect(left(container)).toHaveTextContent(/^Off$/);
    expect(screen.getByText('No account is keeping a loss limit today.')).toBeInTheDocument();
  });

  it('[critical] off, there is no budget to meter or to warn about', () => {
    expect(lossBudget(status({ realisedTodayUsd: -90 }))).toEqual({ limitUsd: 100, leftUsd: 10, usedPct: 0.9 });
    expect(lossBudget(status({ realisedTodayUsd: -90 }, { dailyLossOn: false }))).toBeNull();
  });
});
