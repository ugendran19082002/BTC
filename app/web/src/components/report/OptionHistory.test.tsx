import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { optionReplayUrl } from '@/api/option-replay';
import type { OptionReplay, OptionReplayRow, ReplaySide } from '@/types/option-replay';

/**
 * The option history (owner, 3 Nov 2026): the options the desk really sold against each signal, their exits worked
 * again under the rules on the card -- skip perp SL and TGT, the option's SL and TGT -- for the expiry days, hours and
 * timeframes chosen, beside what really happened.
 */

const getOptionReplay = vi.fn();
vi.mock('@/api/option-replay', async (orig) => ({
  ...(await orig<typeof import('@/api/option-replay')>()),
  getOptionReplay: (...a: unknown[]) => getOptionReplay(...a),
}));
const { OptionHistory, LIVE_RULES, expiryDayNow, rulesProblem, shows, replayCsv } = await import('@/components/report/OptionHistory');

const side = (netUsd: number, o: Partial<ReplaySide> = {}): ReplaySide => ({ trades: 2, wins: 1, losses: 1, profitUsd: Math.max(netUsd, 0) + 0.01, lossUsd: 0.01, netUsd, ...o });
const row = (id: string, day: string, actual: number, replay: number): OptionReplayRow => ({
  tradeId: id, day, account: 1, strategyId: 's', strategyName: '5m time', method: 'pullback', methodName: '#7 Pullback', tf: '5m', side: 'PE',
  symbol: 'P-BTC-84000-201026', enteredAt: Date.parse(`${day}T09:30:00+05:30`), entry: 40, contracts: 1, perpSl: 84_400, perpTgt: 85_000,
  actual: { exitAt: null, exit: 4, netUsd: actual, why: 'option-tgt' }, replay: { exitAt: null, exit: 30, netUsd: replay, why: 'perp-sl' },
});
const answer = (o: Partial<OptionReplay> = {}): OptionReplay => ({
  from: '2026-10-28', to: '2026-11-03', rules: LIVE_RULES, oneContract: false,
  actual: side(0.03), replay: side(-0.02), exits: { 'option-sl': 1, 'option-tgt': 0, 'perp-sl': 1, 'perp-tgt': 0, close: 0 },
  open: 0, noPrices: 2,
  days: [{ key: '2026-10-20', name: '2026-10-20', trades: 1, actual: side(0.04), replay: side(0.01) }, { key: '2026-10-19', name: '2026-10-19', trades: 1, actual: side(-0.01), replay: side(-0.03) }],
  timeframes: [{ key: '5m', name: '5m', trades: 2, actual: side(0.03), replay: side(-0.02) }],
  methods: [], accounts: [],
  rows: [row('a', '2026-10-20', 0.04, 0.01), row('b', '2026-10-19', -0.01, -0.03)], rowsCut: false,
  ...o,
});

beforeEach(() => {
  localStorage.clear();
  getOptionReplay.mockReset();
  getOptionReplay.mockResolvedValue(answer());
});

describe('Option history', () => {
  it('[critical] asks for the last seven expiry days as the desk runs, and sets what happened beside the replay', async () => {
    render(<OptionHistory />);
    expect(await screen.findByText('With these rules')).toBeInTheDocument();
    const q = getOptionReplay.mock.calls[0]![0];
    expect(q.rules).toEqual(LIVE_RULES);
    expect(q.tfs).toEqual([]);
    expect(q.hours).toBeNull();
    expect(q.oneContract).toBe(false);
    expect(q.to).toBe(expiryDayNow());
    expect((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000).toBe(6);
    // As traded +₹2.55, with the rules −₹1.70: the change is −₹4.25.
    expect(screen.getByText('Change', { selector: 'span' }).parentElement).toHaveTextContent('−₹4.25');
    expect(screen.getByText(/Left out: 2 without recorded prices/)).toBeInTheDocument();
    const trades = screen.getByRole('table', { name: 'Trades' });
    expect(within(trades).getAllByRole('row')).toHaveLength(3);
    expect(within(trades).getAllByRole('row')[1]).toHaveTextContent('Perp SL · 30');
  });

  it('[critical] the switches and the option SL and TGT are asked for again, half a second after the last change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<OptionHistory />);
      await screen.findByText('With these rules');
      fireEvent.click(screen.getByRole('switch', { name: /^Skip perp SL/ }));
      const sl = screen.getByLabelText('Option SL, per cent of the price sold');
      fireEvent.change(sl, { target: { value: '150' } });
      expect(getOptionReplay).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(600); });
      await waitFor(() => expect(getOptionReplay).toHaveBeenCalledTimes(2));
      expect(getOptionReplay.mock.calls[1]![0].rules).toEqual({ ...LIVE_RULES, skipPerpSl: false, stopPct: 1.5 });
      // Back as live in one tap.
      fireEvent.click(screen.getByRole('button', { name: 'As live' }));
      await act(async () => { vi.advanceTimersByTime(600); });
      await waitFor(() => expect(getOptionReplay.mock.lastCall![0].rules).toEqual(LIVE_RULES));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rule that cannot be replayed says why and asks for nothing', async () => {
    render(<OptionHistory />);
    await screen.findByText('With these rules');
    fireEvent.change(screen.getByLabelText('Option TGT, per cent of the price sold'), { target: { value: '100' } });
    expect(await screen.findByText('Option TGT must be 0 (none) to 99%.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 700));
    expect(getOptionReplay).toHaveBeenCalledTimes(1);
  });

  it('timeframes, size, a day and profit / loss narrow it', async () => {
    render(<OptionHistory />);
    await screen.findByText('With these rules');
    fireEvent.click(screen.getByRole('button', { name: 'Chain' }));
    await waitFor(() => expect(getOptionReplay.mock.lastCall![0].tfs).toEqual(['chain']));
    fireEvent.click(screen.getByRole('button', { name: '1 contract each' }));
    await waitFor(() => expect(getOptionReplay.mock.lastCall![0].oneContract).toBe(true));
    await screen.findByText('With these rules');
    // A day tapped lists its trades alone; Loss leaves those the rules lose on.
    fireEvent.click(screen.getByRole('row', { name: /2026-10-19/ }));
    expect(within(screen.getByRole('table', { name: 'Trades' })).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '2026-10-19 ✕' }));
    fireEvent.click(screen.getByRole('button', { name: 'Profit' }));
    expect(within(screen.getByRole('table', { name: 'Trades' })).getAllByRole('row')).toHaveLength(2);
    expect(within(screen.getByRole('table', { name: 'Trades' })).getAllByRole('row')[1]).toHaveTextContent('+₹0.85');
  });

  it('a refusal is said', async () => {
    getOptionReplay.mockRejectedValue(new Error('At most 31 days at a time.'));
    render(<OptionHistory />);
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 31 days at a time.');
  });
});

describe('the parts', () => {
  it('the URL carries the rules in per cents, the hours and the timeframes', () => {
    expect(optionReplayUrl({ from: '2026-10-01', to: '2026-10-31', hours: { from: '07:00', to: '11:00' }, tfs: ['5m', 'chain'], rules: { skipPerpSl: false, skipPerpTgt: true, stopPct: 1.5, targetPct: 0.95 }, oneContract: true }))
      .toBe('/api/report/option-replay?from=2026-10-01&to=2026-10-31&fromTime=07%3A00&toTime=11%3A00&tf=5m%2Cchain&skipPerpSl=0&skipPerpTgt=1&sl=150&tgt=95&size=one');
  });
  it('the rules checked, the filters, the spreadsheet', () => {
    expect(rulesProblem(LIVE_RULES)).toBeNull();
    expect(rulesProblem({ ...LIVE_RULES, stopPct: 21 })).toMatch(/Option SL/);
    const r = row('a', '2026-10-20', 0.04, 0.01);
    expect([shows(r, 'profit'), shows(r, 'loss'), shows(r, 'better'), shows(r, 'worse')]).toEqual([true, false, false, true]);
    expect(replayCsv([r]).split('\n')[1]).toContain('2026-10-20,2026-10-20 09:30,1,5m time,5m,#7 Pullback,PE,P-BTC-84000-201026,1,40,84400,85000,4,option-tgt,0.04,30,perp-sl,0.01');
  });
  it('the expiry day turns at 5:30 PM IST', () => {
    expect(expiryDayNow(Date.parse('2026-11-03T17:29:00+05:30'))).toBe('2026-11-03');
    expect(expiryDayNow(Date.parse('2026-11-03T17:30:00+05:30'))).toBe('2026-11-04');
  });
});
