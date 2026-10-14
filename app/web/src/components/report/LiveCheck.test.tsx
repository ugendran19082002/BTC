import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { LiveCheck as Check, LiveCheckRow } from '@/types/signal-backtest';
import { LiveCheck, LiveCheckResult } from '@/components/report/LiveCheck';

const at = (s: string) => Date.parse(`${s}+05:30`);
const row = (o: Partial<LiveCheckRow> & { name: string }): LiveCheckRow => ({
  id: o.name, account: 'Savings', live: { placed: 0, refused: 0, skipped: 0 }, liveWhy: { refused: [], skipped: [] },
  backtest: 0, backtestSkipped: [], same: 0, backtestOnly: [], liveOnly: [], ...o,
});
const LOSS = { why: 'the desk refused: the daily loss limit', n: 4, first: [{ at: at('2026-10-13T21:30:00'), method: 'gamma-wall', tf: '30m', dir: -1 as const }, { at: at('2026-10-13T21:38:00'), method: 'pulled-wall', tf: '30m', dir: 1 as const }] };
/** The night it was first asked: every order the desk placed is in the backtest, which has the 13 the loss limit refused besides. */
const NIGHT: Check = {
  from: '2026-10-13', to: '2026-10-14', liveFrom: at('2026-10-13T21:30:04'), liveTo: at('2026-10-14T07:27:02'), until: 0,
  against: { kind: 'strategies' },
  total: { placed: 162, refused: 13, skipped: 670, backtest: 175, backtestSkipped: 1_015, same: 162, backtestOnly: 13, liveOnly: 0 },
  liveOnly: [],
  liveWhy: { refused: [{ why: 'the daily loss limit', n: 13 }], skipped: [{ why: 'its SL / TGT distance', n: 667 }, { why: 'over before it could be entered', n: 3 }] },
  money: { real: { n: 90, wins: 17, net: -2.26, open: 72 }, backtest: { n: 175, wins: 63, net: -2.01 } },
  days: [
    { day: '2026-10-13', live: false, placed: 0, backtest: 0, same: 0, real: { n: 0, wins: 0, net: 0, open: 0 }, bt: { n: 0, wins: 0, net: 0 } },
    { day: '2026-10-14', live: true, placed: 162, backtest: 175, same: 162, real: { n: 90, wins: 17, net: -2.26, open: 72 }, bt: { n: 175, wins: 63, net: -2.01 } },
  ],
  strategies: [
    row({ name: '5m time', live: { placed: 21, refused: 0, skipped: 327 }, backtest: 21, backtestSkipped: [{ why: 'its SL / TGT distance, as its rules stand now', n: 327 }, { why: 'outside its days and hours, as its rules stand now', n: 139 }], same: 21 }),
    row({ name: '30m time', live: { placed: 47, refused: 4, skipped: 25 }, backtest: 51, backtestSkipped: [{ why: 'its SL / TGT distance, as its rules stand now', n: 25 }], same: 47, backtestOnly: [LOSS] }),
    row({ name: '2h time', live: { placed: 26, refused: 4, skipped: 1 }, backtest: 30, same: 26, backtestOnly: [{ ...LOSS, n: 9, first: [LOSS.first[0]!] }] }),
  ],
};

describe('the live check, inside a result (owner, 14 Oct 2026: "a table that compares them -- no tab of its own")', () => {
  it('[critical] the day table: the desk beside the backtest -- count, money, won -- and how many are the same signal', () => {
    render(<LiveCheckResult r={NIGHT} />);
    expect(screen.getByRole('status', { name: 'Whether they match' })).toHaveTextContent(
      'The desk placed 162 orders, the backtest makes 175 trades: 162 are the same signal. 13 are in the backtest only. Why is under the table.');
    const table = within(screen.getByRole('table', { name: 'Live check by expiry day' }));
    expect(table.getAllByRole('columnheader').map((x) => x.textContent)).toEqual(['Expiry day', 'Desk', 'Backtest', 'Same']);
    // a day with nothing on either side is left out; the day in progress says so
    const rows = table.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    const cells = within(rows[0]!).getAllByRole('cell').map((x) => x.textContent);
    expect(within(rows[0]!).getByRole('rowheader')).toHaveTextContent('Wed 14 Oct · so far');
    // the desk: 162 placed, the 90 closed made −$2.26 (−₹192), 19% of them won, 72 still open
    expect(cells[0]).toBe('162−₹192won 19%72 still open');
    expect(cells[1]).toBe('175−₹171won 36%');
    expect(cells[2]).toBe('162+13 backtest');
    expect(screen.getByText(/The desk's record runs 13 Oct, 9:30 PM → 14 Oct, 7:27 AM IST\./)).toBeInTheDocument();
  });

  it('[critical] why they differ: every signal on one side only under its reason, added up across the rows, with the desk\'s refused and skipped counted', () => {
    render(<LiveCheckResult r={NIGHT} />);
    const only = within(screen.getByRole('list', { name: 'In the backtest only' })).getAllByRole('listitem');
    expect(only).toHaveLength(1);
    expect(only[0]).toHaveTextContent('13 — the desk refused: the daily loss limit');
    expect(only[0]).toHaveTextContent('13 Oct, 9:30 PM · gamma-wall · 30m · SELL | 13 Oct, 9:38 PM · pulled-wall · 30m · BUY | 13 Oct, 9:30 PM · gamma-wall · 30m · SELL | and 10 more');
    expect(screen.queryByRole('list', { name: 'On the desk only' })).toBeNull();
    expect(within(screen.getByRole('list', { name: 'The desk refused · 13' })).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['13the daily loss limit']);
    expect(within(screen.getByRole('list', { name: 'The desk skipped · 670' })).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['667its SL / TGT distance', '3over before it could be entered']);
    // each strategy, behind a fold: its counts on both sides, and "Matches" or what differs
    const each = within(screen.getByRole('list', { name: 'Each strategy' }));
    const five = within(each.getByRole('listitem', { name: '5m time' }));
    expect(five.getByText('Matches')).toBeInTheDocument();
    expect(five.getByText(/Backtest/).closest('p')).toHaveTextContent('Desk 21 placed · 0 refused · 327 skipped · Backtest 21 traded · 466 not traded · same signal 21');
    const thirty = within(each.getByRole('listitem', { name: '30m time' }));
    expect(thirty.getByText('4 differ')).toBeInTheDocument();
    expect(thirty.getByText(/in the backtest only/).closest('p')).toHaveTextContent('4 in the backtest only — the desk refused: the daily loss limit');
    // what it is and is not, said once
    expect(screen.getByText(/The backtest replays the rules, not the account/)).toBeInTheDocument();
  });

  it('[critical] a range on which they agree says so in one line, with nothing to explain', () => {
    render(<LiveCheckResult r={{ ...NIGHT, total: { ...NIGHT.total, refused: 0, skipped: 0, backtest: 162, backtestOnly: 0 }, liveWhy: { refused: [], skipped: [] }, strategies: [NIGHT.strategies[0]!], days: [{ ...NIGHT.days[1]!, backtest: 162 }] }} />);
    expect(screen.getByRole('status', { name: 'Whether they match' })).toHaveTextContent('They match: all 162 orders the desk placed are trades in the backtest, and the backtest has no other.');
    expect(screen.queryByText(/Why they differ/)).toBeNull();
    expect(within(screen.getByRole('table', { name: 'Live check by expiry day' })).getAllByRole('cell')[2]).toHaveTextContent(/^162$/);
  });

  it('[critical] against saved backtests: the desk\'s orders none of them trades are listed too, and a row is a saved backtest', () => {
    const folio: Check = {
      ...NIGHT, against: { kind: 'portfolio', name: 'High Win%' },
      total: { ...NIGHT.total, backtest: 179, same: 158, backtestOnly: 21, liveOnly: 4 },
      liveOnly: [{ why: 'no saved backtest of the portfolio has that method ticked on that time frame', n: 4, first: [{ at: at('2026-10-14T01:05:00'), method: 'mss', tf: '30m', dir: 1 }] }],
      strategies: [
        row({ name: '2h time', account: null, backtest: 36, same: 26, backtestOnly: [{ why: 'no strategy on the desk has a record of it: none takes that method on that time frame, or the desk was not running', n: 6, first: [] }, { ...LOSS, n: 4 }] }),
        row({ name: '30m time', account: null, backtest: 47, same: 43, backtestOnly: [{ ...LOSS, n: 4 }] }),
      ],
      days: [{ ...NIGHT.days[1]!, backtest: 179, same: 158 }],
    };
    render(<LiveCheckResult r={folio} />);
    expect(screen.getByRole('status', { name: 'Whether they match' })).toHaveTextContent('The desk placed 162 orders, the backtest makes 179 trades: 158 are the same signal. 21 are in the backtest only. 4 are on the desk only.');
    expect(within(screen.getByRole('table', { name: 'Live check by expiry day' })).getAllByRole('cell')[2]).toHaveTextContent('158+21 backtest · +4 desk');
    expect(within(screen.getByRole('list', { name: 'On the desk only' })).getByRole('listitem')).toHaveTextContent('4 — no saved backtest of the portfolio has that method ticked on that time frame');
    expect(within(screen.getByRole('list', { name: 'In the backtest only' })).getAllByRole('listitem').map((x) => x.textContent!.split(' — ')[0])).toEqual(['8', '6']);
    // a saved backtest has no orders of its own on the desk: its row says the backtest's side and the match
    const two = within(within(screen.getByRole('list', { name: 'Each saved backtest' })).getByRole('listitem', { name: '2h time' }));
    expect(two.getByText(/Backtest/).closest('p')).toHaveTextContent(/^Backtest 36 traded · 0 not traded · same signal 26$/);
    expect(screen.getByText(/looked up in what the desk did with that signal under any of its strategies/)).toBeInTheDocument();
  });

  it('nothing on either side, and an answer that could not be read, are said -- never a blank', async () => {
    const none: Check = { ...NIGHT, liveFrom: null, liveTo: null, strategies: [], total: { placed: 0, refused: 0, skipped: 0, backtest: 0, backtestSkipped: 0, same: 0, backtestOnly: 0, liveOnly: 0 }, liveWhy: { refused: [], skipped: [] }, days: [] };
    const { unmount } = render(<LiveCheck askKey="a" read={() => Promise.resolve(none)} />);
    expect(await screen.findByText('The desk has no order, and the backtest no trade, in these days.')).toBeInTheDocument();
    unmount();
    const failing = vi.fn().mockRejectedValue(new Error('The backtest took too long and was stopped.'));
    render(<LiveCheck askKey="b" read={failing} />);
    expect(await screen.findByText('Could not read the live check: The backtest took too long and was stopped.')).toBeInTheDocument();
  });
});
