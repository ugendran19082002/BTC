import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LiveCheck as Check, LiveCheckRow } from '@/types/signal-backtest';

const getLiveCheck = vi.fn();
vi.mock('@/api/signal-backtest', () => ({ getLiveCheck: (...a: unknown[]) => getLiveCheck(...a) }));
const { LiveCheck } = await import('@/components/report/LiveCheck');

/** 14 Oct 2026, 7:27 AM IST: the 14 Oct expiry day in progress (it began 5:30 PM on the 13th). */
const NOW = Date.parse('2026-10-14T07:27:00+05:30');
const at = (s: string) => Date.parse(`${s}+05:30`);
const row = (o: Partial<LiveCheckRow> & { name: string }): LiveCheckRow => ({
  id: o.name, account: 'Savings', live: { placed: 0, refused: 0, skipped: 0 }, liveWhy: { refused: [], skipped: [] },
  backtest: 0, backtestSkipped: [], same: 0, backtestOnly: [], liveOnly: [], ...o,
});
/** The night it was first asked: every order the desk placed is in the backtest, which has the 13 the loss limit refused besides. */
const NIGHT: Check = {
  from: '2026-10-14', to: '2026-10-14', liveFrom: at('2026-10-13T21:30:04'), liveTo: at('2026-10-14T07:27:02'), until: NOW - 120_000,
  total: { placed: 162, refused: 13, skipped: 670, backtest: 175, backtestSkipped: 1_015, same: 162, backtestOnly: 13, liveOnly: 0 },
  liveWhy: { refused: [{ why: 'the daily loss limit', n: 13 }], skipped: [{ why: 'its SL / TGT distance', n: 667 }, { why: 'over before it could be entered', n: 3 }] },
  days: [{ day: '2026-10-14', placed: 162, backtest: 175, same: 162 }],
  strategies: [
    row({ name: '5m time', live: { placed: 21, refused: 0, skipped: 327 }, liveWhy: { refused: [], skipped: [{ why: 'its SL / TGT distance', n: 327 }] }, backtest: 21, backtestSkipped: [{ why: 'its SL / TGT distance, as its rules stand now', n: 327 }, { why: 'outside its days and hours, as its rules stand now', n: 139 }], same: 21 }),
    row({
      name: '30m time', live: { placed: 47, refused: 4, skipped: 25 }, liveWhy: { refused: [{ why: 'the daily loss limit', n: 4 }], skipped: [{ why: 'its SL / TGT distance', n: 25 }] },
      backtest: 51, backtestSkipped: [{ why: 'its SL / TGT distance, as its rules stand now', n: 25 }], same: 47,
      backtestOnly: [{ why: 'the desk refused: the daily loss limit', n: 4, first: [{ at: at('2026-10-13T21:30:00'), method: 'gamma-wall', tf: '30m', dir: -1 }, { at: at('2026-10-13T21:30:00'), method: 'nr7', tf: '30m', dir: -1 }, { at: at('2026-10-13T21:38:00'), method: 'pulled-wall', tf: '30m', dir: 1 }] }],
    }),
    row({ name: 'Idle one', account: null }),
  ],
};

beforeEach(() => { window.localStorage.clear(); getLiveCheck.mockReset().mockResolvedValue(NIGHT); });

describe('the live check (owner, 14 Oct 2026: "the real trades and the backtest\'s do not match in number")', () => {
  it('[critical] says how many are the same signal, how many more each side has, and the desk\'s refused and skipped by reason', async () => {
    render(<LiveCheck now={NOW} />);
    const verdict = await screen.findByRole('status', { name: 'Whether they match' });
    // asked for the expiry day in progress to begin with
    expect(getLiveCheck).toHaveBeenLastCalledWith({ from: '2026-10-14', to: '2026-10-14' });
    expect(verdict).toHaveTextContent('162 signals are an order on the desk and a trade in the backtest. The backtest has 13 more (175 against 162). Each is under its reason below.');
    expect(screen.getByText(/Wed 14 Oct expiry · the desk's record runs 13 Oct, 9:30 PM → 14 Oct, 7:27 AM IST/)).toBeInTheDocument();
    const fig = (label: string) => screen.getByText(label).parentElement!;
    expect([fig('Desk · placed'), fig('Desk · refused'), fig('Desk · skipped')].map((x) => x.textContent)).toEqual(['Desk · placed162', 'Desk · refused13', 'Desk · skipped670']);
    expect([fig('Backtest · traded'), fig('Backtest · not traded'), fig('Same signal')].map((x) => x.textContent)).toEqual(['Backtest · traded175', 'Backtest · not traded1,015', 'Same signal162']);
    expect(within(screen.getByRole('list', { name: 'Why the desk refused' })).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['13the daily loss limit']);
    expect(within(screen.getByRole('list', { name: 'Why the desk skipped' })).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['667its SL / TGT distance', '3over before it could be entered']);
    // what it is and is not, said once
    expect(screen.getByText(/The backtest replays the rules, not the account/)).toBeInTheDocument();
  });

  it('[critical] each strategy: its counts on both sides, "every order matches" or what differs under its reason, with signals to look up', async () => {
    render(<LiveCheck now={NOW} />);
    const each = within(await screen.findByRole('list', { name: 'Each strategy' }));
    const five = within(each.getByRole('listitem', { name: '5m time' }));
    expect(five.getByText('Every order matches')).toBeInTheDocument();
    expect(five.getByText('Desk').nextElementSibling).toHaveTextContent('21 placed · 0 refused · 327 skipped');
    expect(five.getByText('Backtest').nextElementSibling).toHaveTextContent('21 traded · 466 not traded');
    expect(five.queryByRole('list', { name: 'In the backtest only' })).toBeNull();
    // behind a fold: the refused, the skipped and the backtest's own not-traded, by reason -- the same rule on both sides, the same count
    expect(within(five.getByRole('list', { name: 'The desk skipped' })).getByRole('listitem')).toHaveTextContent('327its SL / TGT distance');
    expect(within(five.getByRole('list', { name: 'The backtest did not trade' })).getAllByRole('listitem').map((x) => x.textContent))
      .toEqual(['327its SL / TGT distance, as its rules stand now', '139outside its days and hours, as its rules stand now']);

    const thirty = within(each.getByRole('listitem', { name: '30m time' }));
    expect(thirty.getByText('4 differ')).toBeInTheDocument();
    const only = within(thirty.getByRole('list', { name: 'In the backtest only' })).getByRole('listitem');
    expect(only).toHaveTextContent('4 in the backtest only — the desk refused: the daily loss limit');
    expect(only).toHaveTextContent('13 Oct, 9:30 PM · gamma-wall · 30m · SELL | 13 Oct, 9:30 PM · nr7 · 30m · SELL | 13 Oct, 9:38 PM · pulled-wall · 30m · BUY | and 1 more');
    expect(within(thirty.getByRole('list', { name: 'The desk refused' })).getByRole('listitem')).toHaveTextContent('4the daily loss limit');
    // one with no signal of its methods says so, with no counts to read as zeros
    const idle = within(each.getByRole('listitem', { name: 'Idle one' }));
    expect(idle.getByText('No signal of its methods')).toBeInTheDocument();
    expect(idle.queryByText('Desk')).toBeNull();
  });

  it('[critical] a day on which they agree says so in one line', async () => {
    getLiveCheck.mockResolvedValue({ ...NIGHT, total: { ...NIGHT.total, refused: 0, backtest: 162, backtestOnly: 0 }, liveWhy: { refused: [], skipped: NIGHT.liveWhy.skipped }, strategies: [NIGHT.strategies[0]!] });
    render(<LiveCheck now={NOW} />);
    expect(await screen.findByRole('status', { name: 'Whether they match' })).toHaveTextContent('They match: all 162 orders the desk placed are trades in the backtest, and the backtest has no other.');
    expect(screen.queryByRole('list', { name: 'Why the desk refused' })).toBeNull();
  });

  it('more days: asked for, remembered, and listed day by day; a desk with no record says so', async () => {
    getLiveCheck.mockResolvedValue({ ...NIGHT, from: '2026-10-13', days: [{ day: '2026-10-13', placed: 101, backtest: 597, same: 85 }, ...NIGHT.days] });
    render(<LiveCheck now={NOW} />);
    await screen.findByRole('status', { name: 'Whether they match' });
    fireEvent.click(screen.getByRole('radio', { name: 'The expiry day in progress and the one before it' }));
    await waitFor(() => expect(getLiveCheck).toHaveBeenLastCalledWith({ from: '2026-10-13', to: '2026-10-14' }));
    const days = within(await screen.findByRole('table', { name: 'By expiry day' })).getAllByRole('row').slice(1).map((x) => x.textContent);
    expect(days).toEqual(['Wed 14 Oct162175162', 'Tue 13 Oct10159785']);
    fireEvent.click(screen.getByRole('radio', { name: 'The last 7 expiry days' }));
    await waitFor(() => expect(getLiveCheck).toHaveBeenLastCalledWith({ from: '2026-10-08', to: '2026-10-14' }));
    expect(JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.endsWith('signalBacktest.live.days'))!)!)).toBe('7');

    getLiveCheck.mockResolvedValue({ ...NIGHT, liveFrom: null, liveTo: null, strategies: [], total: { placed: 0, refused: 0, skipped: 0, backtest: 0, backtestSkipped: 0, same: 0, backtestOnly: 0, liveOnly: 0 }, liveWhy: { refused: [], skipped: [] } });
    fireEvent.click(screen.getByRole('radio', { name: 'The expiry day in progress' }));
    expect(await screen.findByText(/the desk has no record in these days/)).toBeInTheDocument();
    expect(screen.getByText('No signal of any strategy\'s methods in these days yet.')).toBeInTheDocument();
  });

  it('an answer that could not be read is said, not left blank', async () => {
    getLiveCheck.mockRejectedValue(new Error('The backtest took too long and was stopped.'));
    render(<LiveCheck now={NOW} />);
    expect(await screen.findByText('Could not read the live check (each strategy is backtested: a moment the first time): The backtest took too long and was stopped.')).toBeInTheDocument();
  });
});
