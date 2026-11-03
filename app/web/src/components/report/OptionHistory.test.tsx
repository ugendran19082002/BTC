import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { optionReplayCsvUrl, optionReplayUrl, type OptionReplayQuery } from '@/api/option-replay';
import type { OptionReplay, OptionReplayRow, ReplayGroup, ReplaySide } from '@/types/option-replay';

/**
 * The option history (owner, 3 Nov 2026): every signal of the signal history -- no account's rules, only the card's
 * settings -- each sold as the strategies pick a strike, its exit worked under the rules on the card: skip perp SL and
 * TGT, the option's SL and TGT, for the expiry days, hours and timeframes chosen; the desk's real order beside it where
 * there was one. Every trade is listed, a page at a time from the server; the groups ranked.
 */

const getOptionReplay = vi.fn();
vi.mock('@/api/option-replay', async (orig) => ({
  ...(await orig<typeof import('@/api/option-replay')>()),
  getOptionReplay: (...a: unknown[]) => getOptionReplay(...a),
}));
const { OptionHistory, LIVE_RULES, expiryDayNow, rulesProblem, rankGroups } = await import('@/components/report/OptionHistory');

const side = (netUsd: number, o: Partial<ReplaySide> = {}): ReplaySide => ({ trades: 2, wins: 1, losses: 1, profitUsd: Math.max(netUsd, 0) + 0.01, lossUsd: 0.01, netUsd, ...o });
const row = (id: string, day: string, actual: number | null, replay: number): OptionReplayRow => ({
  tradeId: id, day, account: null, strategyId: null, strategyName: null, method: 'pullback', methodName: '#7 Pullback', tf: '5m', side: 'PE',
  symbol: 'P-BTC-84000-201026', enteredAt: Date.parse(`${day}T09:30:00+05:30`), entry: 40, contracts: 1, perpSl: 84_400, perpTgt: 85_000,
  actual: actual === null ? null : { exitAt: null, exit: 4, netUsd: actual, why: 'option-tgt' }, replay: { exitAt: null, exit: 30, netUsd: replay, why: 'perp-sl' },
});
const group = (key: string, trades: number, actual: number, replay: number, o: Partial<ReplayGroup> = {}): ReplayGroup =>
  ({ key, name: key, trades, open: 0, traded: trades, better: 0, worse: trades, actual: side(actual), replay: side(replay), daysUp: 0, daysDown: 0, ...o });
const answer = (o: Partial<OptionReplay> = {}): OptionReplay => ({
  from: '2026-10-28', to: '2026-11-03', rules: LIVE_RULES, oneContract: true, source: 'signals',
  actual: side(0.03), replay: side(-0.02), traded: 1, better: 0, worse: 1, exits: { 'option-sl': 1, 'option-tgt': 0, 'perp-sl': 1, 'perp-tgt': 0, close: 0 },
  open: 0, noPrices: 2, noStrike: 4,
  days: [group('2026-11-03', 0, 0, 0, { open: 3, traded: 0, worse: 0 }), group('2026-10-20', 1, 0.04, 0.01), group('2026-10-19', 1, -0.01, -0.03)],
  timeframes: [group('5m', 2, 0.03, -0.02)],
  methods: [], accounts: [], hours: [group('13', 2, 0.03, -0.02, { name: '1 PM' })],
  slots: [
    group('pullback|13', 6, 0, -0.5, { name: '#7 Pullback · 1 PM', daysUp: 1, daysDown: 5 }),
    group('nr7|09', 4, 0, 0.4, { name: '#39 NR7 · 9 AM', daysUp: 4, daysDown: 0 }),
  ],
  rows: [row('a', '2026-10-20', 0.04, 0.01), row('b', '2026-10-19', null, -0.03)], rowsTotal: 2, list: { day: null, show: 'all', offset: 0, limit: 200 },
  ...o,
});
const lastAsk = () => getOptionReplay.mock.lastCall![0] as OptionReplayQuery;

beforeEach(() => {
  localStorage.clear();
  getOptionReplay.mockReset();
  getOptionReplay.mockResolvedValue(answer());
});

describe('Option history', () => {
  it('[critical] every signal, the last seven expiry days as the desk runs; the real orders beside them', async () => {
    render(<OptionHistory />);
    expect(await screen.findByText('With these rules')).toBeInTheDocument();
    const q = lastAsk();
    expect([q.source, q.oneContract]).toEqual(['signals', true]);
    expect(q.rules).toEqual(LIVE_RULES);
    expect([q.tfs, q.hours]).toEqual([[], null]);
    // No day tapped: no trades asked for, the figures alone.
    expect(q.list).toEqual({ day: null, show: 'all', offset: 0, limit: 1 });
    expect(screen.queryByRole('table', { name: 'Trades' })).toBeNull();
    expect(screen.getByText('Tap a day in the Days list to see its trades.')).toBeInTheDocument();
    expect(q.to).toBe(expiryDayNow());
    expect((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000).toBe(6);
    // Nothing on the card is an account's or the desk's: no source to choose, no size.
    expect(screen.queryByRole('button', { name: "Desk's orders" })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Size' })).toBeNull();
    expect(screen.getByText(/Desk's real orders · 1 of 2/)).toBeInTheDocument();
    // As traded +₹2.55, with the rules −₹1.70: the change is −₹4.25.
    expect(screen.getByText('Change', { selector: 'span' }).parentElement).toHaveTextContent('−₹4.25');
    expect(screen.getByText(/Left out: 2 without recorded prices, 4 signals with no strike inside the rule/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('row', { name: /2026-10-20/ }));
    await waitFor(() => expect(lastAsk().list).toEqual({ day: '2026-10-20', show: 'all', offset: 0, limit: 200 }));
    const trades = within(screen.getByRole('table', { name: 'Trades' })).getAllByRole('row');
    expect(trades[1]).toHaveTextContent('Perp SL · 30');
    expect(trades[2]).toHaveTextContent('Not traded');
    // The option once, not "PE … PE".
    expect(trades[1]!.textContent!.match(/PE/g)).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: 'Accounts' })).toBeNull();
  });

  it('[critical] the switches and the option SL and TGT are asked for again, half a second after the last change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<OptionHistory />);
      await screen.findByText('With these rules');
      fireEvent.click(screen.getByRole('switch', { name: /^Skip perp SL/ }));
      fireEvent.change(screen.getByLabelText('Option SL, per cent of the price sold'), { target: { value: '150' } });
      expect(getOptionReplay).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(600); });
      await waitFor(() => expect(getOptionReplay).toHaveBeenCalledTimes(2));
      expect(lastAsk().rules).toEqual({ ...LIVE_RULES, skipPerpSl: false, stopPct: 1.5 });
      fireEvent.click(screen.getByRole('button', { name: 'As live' }));
      await act(async () => { vi.advanceTimersByTime(600); });
      await waitFor(() => expect(lastAsk().rules).toEqual(LIVE_RULES));
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

  it('[critical] every day of the range has its line: one with no trade says so, and its open trades', async () => {
    render(<OptionHistory />);
    await screen.findByText('With these rules');
    fireEvent.change(screen.getByRole('combobox', { name: 'Rank by' }), { target: { value: 'date' } });
    expect(within(screen.getByRole('table', { name: 'By days' })).getByRole('row', { name: /2026-11-03/ })).toHaveTextContent('No trades · 3 still open');
  });

  it('[critical] the list: a day, profit / loss, and every page asked of the server', async () => {
    getOptionReplay.mockResolvedValue(answer({ rowsTotal: 450 }));
    render(<OptionHistory />);
    await screen.findByText('With these rules');
    expect(screen.queryByText('1–200 of 450 trades')).toBeNull();
    fireEvent.click(screen.getByRole('row', { name: /2026-10-20/ }));
    expect(await screen.findAllByText('1–200 of 450 trades')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]!);
    await waitFor(() => expect(lastAsk().list.offset).toBe(200));
    fireEvent.click(screen.getAllByRole('button', { name: 'Last' })[0]!);
    await waitFor(() => expect(lastAsk().list.offset).toBe(400));
    // A filter or a day starts the list again from its first page.
    fireEvent.click(screen.getByRole('button', { name: /^Loss/ }));
    await waitFor(() => expect(lastAsk().list).toEqual({ day: '2026-10-20', show: 'loss', offset: 0, limit: 200 }));
    fireEvent.click(screen.getByRole('row', { name: /2026-10-19/ }));
    await waitFor(() => expect(lastAsk().list).toEqual({ day: '2026-10-19', show: 'loss', offset: 0, limit: 200 }));
    // The spreadsheet is every trade the list holds, written by the server.
    const csv = screen.getByRole('link', { name: 'CSV' }).getAttribute('href')!;
    expect(csv).toContain('/api/report/option-replay.csv?');
    expect(csv).toContain('day=2026-10-19&show=loss');
  });

  it('[critical] the counts as badges, overall and of the day tapped; a badge ranks the lists by it', async () => {
    render(<OptionHistory />);
    await screen.findByText('With these rules');
    const badges = screen.getByRole('group', { name: 'Show trades' });
    // Overall: 2 replayed, 1 in profit, 1 in loss; 0 better, 1 worse.
    expect(within(badges).getByRole('button', { name: /^All/ })).toHaveTextContent('All2');
    expect(within(badges).getByRole('button', { name: /^Worse/ })).toHaveTextContent('Worse1');
    expect(badges).toHaveTextContent('overall');
    fireEvent.click(within(badges).getByRole('button', { name: /^Worse/ }));
    expect(screen.getByRole('combobox', { name: 'Rank by' })).toHaveValue('worse');
    await waitFor(() => expect(lastAsk().list.show).toBe('worse'));
    // The day tapped: its own counts.
    fireEvent.click(screen.getByRole('row', { name: /2026-10-20/ }));
    await waitFor(() => expect(badges).toHaveTextContent('on 2026-10-20'));
    expect(within(badges).getByRole('button', { name: /^All/ })).toHaveTextContent('All1');
  });

  it('[critical] method × hour over every day chosen: profit days and loss days counted, ranked by them, found by name', async () => {
    render(<OptionHistory />);
    await screen.findByText('With these rules');
    fireEvent.click(screen.getByRole('tab', { name: 'Method × hour' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Rank by' }), { target: { value: 'daysDown' } });
    let lines = within(screen.getByRole('table', { name: 'By slots' })).getAllByRole('row');
    expect(lines[1]).toHaveTextContent('1#7 Pullback · 1 PM615');
    fireEvent.change(screen.getByRole('combobox', { name: 'Rank by' }), { target: { value: 'daysUp' } });
    lines = within(screen.getByRole('table', { name: 'By slots' })).getAllByRole('row');
    expect(lines[1]).toHaveTextContent('#39 NR7 · 9 AM');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in the list' }), { target: { value: 'pullback' } });
    lines = within(screen.getByRole('table', { name: 'By slots' })).getAllByRole('row');
    expect(lines).toHaveLength(3); // the head, one line, the total
  });

  it('timeframes narrow it', async () => {
    render(<OptionHistory />);
    await screen.findByText('With these rules');
    fireEvent.click(screen.getByRole('button', { name: 'Chain' }));
    await waitFor(() => expect(lastAsk().tfs).toEqual(['chain']));
  });

  it('a refusal is said', async () => {
    getOptionReplay.mockRejectedValue(new Error('At most 31 days at a time.'));
    render(<OptionHistory />);
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 31 days at a time.');
  });
});

describe('the parts', () => {
  it('the URL carries the rules in per cents, the hours, the timeframes, the source and the page', () => {
    const q: OptionReplayQuery = {
      from: '2026-10-01', to: '2026-10-31', hours: { from: '07:00', to: '11:00' }, tfs: ['5m', 'chain'],
      rules: { skipPerpSl: false, skipPerpTgt: true, stopPct: 1.5, targetPct: 0.95 }, oneContract: true, source: 'signals',
      list: { day: '2026-10-12', show: 'worse', offset: 400, limit: 200 },
    };
    expect(optionReplayUrl(q)).toBe('/api/report/option-replay?from=2026-10-01&to=2026-10-31&fromTime=07%3A00&toTime=11%3A00&tf=5m%2Cchain&skipPerpSl=0&skipPerpTgt=1&sl=150&tgt=95&size=one&source=signals&day=2026-10-12&show=worse&offset=400&limit=200');
    expect(optionReplayCsvUrl(q)).toMatch(/^\/api\/report\/option-replay\.csv\?from=2026-10-01/);
  });
  it('ranked best first by what is asked, a day with no trade last', () => {
    const gs = [group('a', 0, 0, 0), group('b', 5, 1, 2, { better: 4, worse: 1 }), group('c', 9, 1, 5, { better: 1, worse: 8 })];
    expect(rankGroups(gs, 'net').map((g) => g.key)).toEqual(['c', 'b', 'a']);
    expect(rankGroups(gs, 'better').map((g) => g.key)).toEqual(['b', 'c', 'a']);
    expect(rankGroups(gs, 'worse').map((g) => g.key)).toEqual(['c', 'b', 'a']);
    expect(rankGroups(gs, 'losses').map((g) => g.key)).toEqual(['b', 'c', 'a']);
    expect(rankGroups(gs, 'date').map((g) => g.key)).toEqual(['a', 'b', 'c']);
  });
  it('the rules checked', () => {
    expect(rulesProblem(LIVE_RULES)).toBeNull();
    expect(rulesProblem({ ...LIVE_RULES, stopPct: 21 })).toMatch(/Option SL/);
  });
  it('the expiry day turns at 5:30 PM IST', () => {
    expect(expiryDayNow(Date.parse('2026-11-03T17:29:00+05:30'))).toBe('2026-11-03');
    expect(expiryDayNow(Date.parse('2026-11-03T17:30:00+05:30'))).toBe('2026-11-04');
  });
});
