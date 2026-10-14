import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { LiveCheck as Check, LiveCheckFate, LiveCheckRow } from '@/types/signal-backtest';
import { LiveCheck, LiveCheckResult } from '@/components/report/LiveCheck';

const at = (s: string) => Date.parse(`${s}+05:30`);
const F = (o: Partial<LiveCheckFate> = {}): LiveCheckFate => ({ taken: 0, waiting: 0, notTaken: 0, skipped: 0, refused: 0, rejected: 0, expired: 0, cancelled: 0, ...o });
const FATES = { live: F(), backtest: F() };
const row = (o: Partial<LiveCheckRow> & { name: string }): LiveCheckRow => ({
  id: o.name, account: 'Savings', live: { placed: 0, refused: 0, skipped: 0 }, fate: FATES, liveWhy: { refused: [], skipped: [] },
  backtest: 0, backtestSkipped: [], same: 0, backtestOnly: [], liveOnly: [], ...o,
});
const LOSS = { why: 'the desk refused: the daily loss limit', n: 4, first: [{ at: at('2026-10-13T21:30:00'), method: 'gamma-wall', tf: '30m', dir: -1 as const }, { at: at('2026-10-13T21:38:00'), method: 'pulled-wall', tf: '30m', dir: 1 as const }] };
/** The desk: 160 filled and 2 still working, 676 skipped, 15 refused, 1 expired, 1 rejected. The backtest: 177 taken, 676 skipped. */
const DAY14 = { live: F({ taken: 160, waiting: 2, notTaken: 693, skipped: 676, refused: 15, rejected: 1, expired: 1 }), backtest: F({ taken: 177, notTaken: 676, skipped: 676 }) };
const NONE = { notCompared: { backtest: 0, desk: 0 }, notComparedWhy: { backtest: [], desk: [] } };
/** 14 Oct 2026 by the strategies' own rules: every order the desk placed is a backtest trade; the backtest's 15 more are the 15 the loss limit refused. */
const NIGHT: Check = {
  from: '2026-10-13', to: '2026-10-14', liveFrom: at('2026-10-13T21:30:04'), liveTo: at('2026-10-14T07:27:02'), until: 0,
  against: { kind: 'strategies' },
  total: { placed: 162, refused: 15, skipped: 676, backtest: 177, backtestSkipped: 676, same: 162, backtestOnly: 15, liveOnly: 0 },
  liveOnly: [], ...NONE,
  liveWhy: { refused: [{ why: 'the daily loss limit', n: 15 }], skipped: [{ why: 'its SL / TGT distance', n: 673 }, { why: 'over before it could be entered', n: 3 }] },
  money: { real: null, backtest: { n: 177, wins: 70, net: -1.62 } },
  days: [
    { day: '2026-10-13', live: false, placed: 0, backtest: 0, same: 0, real: null, bt: { n: 0, wins: 0, net: 0 }, fate: FATES },
    { day: '2026-10-14', live: true, placed: 162, backtest: 177, same: 162, real: null, bt: { n: 177, wins: 70, net: -1.62 }, fate: DAY14 },
  ],
  fate: DAY14,
  strategies: [
    row({ name: '5m time', live: { placed: 21, refused: 0, skipped: 327 }, backtest: 21, backtestSkipped: [{ why: 'its SL / TGT distance, as its rules stand now', n: 327 }], same: 21 }),
    row({ name: '30m time', live: { placed: 47, refused: 4, skipped: 25 }, backtest: 51, backtestSkipped: [{ why: 'its SL / TGT distance, as its rules stand now', n: 25 }], same: 47, backtestOnly: [LOSS] }),
    row({ name: '2h time', live: { placed: 26, refused: 11, skipped: 1 }, backtest: 37, same: 26, backtestOnly: [{ ...LOSS, n: 11, first: [LOSS.first[0]!] }] }),
  ],
};

describe('the live check, inside a result (owner, 14 Oct 2026: decisions, not finished orders; the live rules with the backtest\'s settings)', () => {
  it('[critical] by a strategy: the desk\'s decisions beside the backtest\'s trades -- counts only on the desk\'s side, never its fills', () => {
    render(<LiveCheckResult r={NIGHT} />);
    expect(screen.getByText('Live check · the desk beside this backtest')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Whether they match' })).toHaveTextContent(
      'The desk placed 162 orders, the backtest makes 177 trades: 162 are the same signal. 15 are in the backtest only. Why is under the table.');
    const table = within(screen.getByRole('table', { name: 'Live check by expiry day' }));
    expect(table.getAllByRole('columnheader').map((x) => x.textContent)).toEqual(['Side', 'Taken', 'Not taken', 'Skipped', 'Refused', 'Rejected', 'Expired']);
    // one day with anything on it: no "all days" block over a table of one
    const day = within(table.getByRole('rowgroup', { name: 'Wed 14 Oct · so far' }));
    expect(table.queryByRole('rowgroup', { name: /^All / })).toBeNull();
    const cells = (side: string) => within(day.getByRole('rowheader', { name: side }).closest('tr')!).getAllByRole('cell').map((x) => x.textContent);
    // the desk: what it entered, and each way it did not -- its refused, rejected and expired among them
    expect(cells('Desk')).toEqual(['1602 waiting', '693', '676', '15', '1', '1']);
    // the backtest: what it took and skipped; the desk's own kinds of not taken are a dash, not a zero
    expect(cells('Backtest')).toEqual(['177', '676', '676', '—', '—', '—']);
    expect(day.getByText(/^Same signal 162/).closest('td')).toHaveTextContent('Same signal 162 · +15 backtestBacktest −₹138, won 40%');
    expect(screen.getByText(/its decisions, not their fills/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Not compared')).toBeNull();
  });

  it('[critical] why they differ: by reason, added up across the strategies, with the desk\'s refused and skipped counted', () => {
    render(<LiveCheckResult r={NIGHT} />);
    const only = within(screen.getByRole('list', { name: 'In the backtest only' })).getAllByRole('listitem');
    expect(only.map((x) => x.textContent!.split(' — ')[0])).toEqual(['15']);
    expect(only[0]).toHaveTextContent('15 — the desk refused: the daily loss limit');
    expect(within(screen.getByRole('list', { name: 'The desk refused · 15' })).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['15the daily loss limit']);
    expect(within(screen.getByRole('list', { name: 'The desk skipped · 676' })).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['673its SL / TGT distance', '3over before it could be entered']);
    const each = within(screen.getByRole('list', { name: 'Each strategy' }));
    expect(within(each.getByRole('listitem', { name: '5m time' })).getByText('Matches')).toBeInTheDocument();
    expect(within(each.getByRole('listitem', { name: '30m time' })).getByText('4 differ')).toBeInTheDocument();
  });

  it('[critical] what cannot be compared is set apart and named, not counted against either side', () => {
    const apart: Check = {
      ...NIGHT, notCompared: { backtest: 3_587, desk: 1 },
      notComparedWhy: {
        backtest: [{ why: 'the desk has no record of the signal: the strategy was off, not yet made, or its rules were different then', n: 3_587, first: [] }],
        desk: [{ why: 'outside the strategy\'s rules as they stand now', n: 1, first: [] }],
      },
    };
    render(<LiveCheckResult r={apart} />);
    expect(screen.getByLabelText('Not compared')).toHaveTextContent('Not compared: 3,587 backtest trades of signals the desk has no record of · 1 desk order outside the rules as they stand now.');
    expect(within(screen.getByRole('list', { name: "Not compared: the backtest's" })).getByRole('listitem')).toHaveTextContent('3,587 — the desk has no record of the signal');
    expect(within(screen.getByRole('list', { name: "Not compared: the desk's" })).getByRole('listitem')).toHaveTextContent('1 — outside the strategy\'s rules as they stand now');
  });

  it('[critical] by settings or a portfolio: the live rules run with them -- a match says so, with the money', () => {
    const folio: Check = {
      ...NIGHT, against: { kind: 'portfolio', name: 'High Win%' }, liveFrom: null, liveTo: null,
      total: { placed: 181, refused: 0, skipped: 708, backtest: 181, backtestSkipped: 708, same: 181, backtestOnly: 0, liveOnly: 0 },
      liveWhy: { refused: [], skipped: [{ why: 'its SL / TGT distance, as its rules stand now', n: 708 }] },
      money: { real: { n: 181, wins: 73, net: -3.21 }, backtest: { n: 181, wins: 73, net: -3.21 } },
      days: [{ day: '2026-10-14', live: true, placed: 181, backtest: 181, same: 181, real: { n: 181, wins: 73, net: -3.21 }, bt: { n: 181, wins: 73, net: -3.21 }, fate: { live: F({ taken: 181, notTaken: 708, skipped: 708 }), backtest: F({ taken: 181, notTaken: 708, skipped: 708 }) } }],
      fate: { live: F({ taken: 181, notTaken: 708, skipped: 708 }), backtest: F({ taken: 181, notTaken: 708, skipped: 708 }) },
      strategies: [row({ name: '15m time', account: null, live: { placed: 33, refused: 0, skipped: 115 }, backtest: 33, same: 33 })],
    };
    render(<LiveCheckResult r={folio} />);
    expect(screen.getByText('Live check · the live rules with these settings')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Whether they match' })).toHaveTextContent('They match: the live rules with these settings take the same 181 trades as the backtest, and make the same money.');
    const day = within(within(screen.getByRole('table', { name: 'Live check by expiry day' })).getByRole('rowgroup', { name: 'Wed 14 Oct · so far' }));
    const cells = (side: string) => within(day.getByRole('rowheader', { name: side }).closest('tr')!).getAllByRole('cell').map((x) => x.textContent);
    expect(cells('Live rules')).toEqual(['181', '708', '708', '—', '—', '—']);
    expect(cells('Backtest')).toEqual(['181', '708', '708', '—', '—', '—']);
    expect(day.getByText(/^Same signal 181/).closest('td')).toHaveTextContent('Same signal 181 · all matchBacktest −₹273, won 40% · live rules −₹273');
    expect(screen.getByText(/through the same rules the desk trades by, and compared signal for signal/)).toBeInTheDocument();
  });

  it('a difference with the live rules is said as theirs, not the desk\'s', () => {
    const differ: Check = {
      ...NIGHT, against: { kind: 'portfolio', name: 'these settings' },
      total: { placed: 10, refused: 0, skipped: 0, backtest: 11, backtestSkipped: 0, same: 9, backtestOnly: 2, liveOnly: 1 },
      days: [{ day: '2026-10-14', live: true, placed: 10, backtest: 11, same: 9, real: { n: 10, wins: 5, net: 1 }, bt: { n: 11, wins: 5, net: 1 }, fate: { live: F({ taken: 10 }), backtest: F({ taken: 11 }) } }],
      strategies: [row({ name: 'These settings', account: null, backtest: 11, same: 9, backtestOnly: [{ why: 'the live rules would not: its SL / TGT distance, as its rules stand now', n: 2, first: [] }], liveOnly: [{ why: 'the backtest would not: no strike its rule could sell on the recorded prices', n: 1, first: [] }] })],
    };
    render(<LiveCheckResult r={differ} />);
    expect(screen.getByRole('status', { name: 'Whether they match' })).toHaveTextContent('The live rules take 10 trades, the backtest makes 11 trades: 9 are the same signal. 2 are in the backtest only. 1 are the live rules\' only.');
    expect(screen.getByText(/^Same signal 9/).closest('td')).toHaveTextContent('Same signal 9 · +2 backtest · +1 live');
    expect(within(screen.getByRole('list', { name: 'The live rules only' })).getByRole('listitem')).toHaveTextContent('1 — the backtest would not: no strike its rule could sell on the recorded prices');
  });

  it('more than one day: the whole range first, then each day, newest first', () => {
    const two: Check = { ...NIGHT, days: [{ ...NIGHT.days[1]!, day: '2026-10-13', live: false, fate: { live: F({ taken: 50, notTaken: 9, skipped: 9 }), backtest: F({ taken: 50, notTaken: 9, skipped: 9 }) } }, NIGHT.days[1]!] };
    render(<LiveCheckResult r={two} />);
    const groups = within(screen.getByRole('table', { name: 'Live check by expiry day' })).getAllByRole('rowgroup').filter((g) => g.tagName === 'TBODY').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['All 2 days', 'Wed 14 Oct · so far', 'Tue 13 Oct']);
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
