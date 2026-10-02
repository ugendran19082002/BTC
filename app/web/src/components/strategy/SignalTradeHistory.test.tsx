import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { outcomeOf, SignalTradeHistory, sortTrades, tradesCsv } from '@/components/strategy/SignalTradeHistory';
import { DEFAULT_CONFIG, type SignalTrade, type Strategy } from '@/types/strategy';

/** The signal strategies' trade history: the signal, the option, the perp SL and TGT, the exit, the result, the money. */

const AT = Date.UTC(2026, 9, 2, 5, 0);
const levels = { entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: 85_900, tp3: null };
const trade = (o: Partial<SignalTrade>): SignalTrade => ({
  id: 1, strategyId: 'sig', at: AT, method: 'breakout', mode: 'single', tf: '15m', dir: 1,
  status: 'would-place', detail: '#1 Breakout BUY | live orders off: would sell PE 84000 x1 @ 18', tradeId: null,
  levels, perp: { status: 'tp1', fillPrice: 84_990, filledAt: AT + 60_000, exitPrice: 85_500, exitAt: AT + 600_000 }, option: null,
  ...o,
});
const LIVE_WON = trade({
  id: 2, status: 'placed', tradeId: 't2', detail: '#6 BOS SELL | sell CE 86000 x1 @ 18', dir: -1, method: 'bos', mode: 'mtf', tf: '5m',
  option: { side: 'CE', strike: 86_000, size: 1, open: false, entry: 18, exit: 4.5, pnlUsd: 0.0135,
    exitReason: "BTC perp at 84500 reached the signal's target 84500", perpStop: 85_400, perpTarget: 84_500 },
});
const LIVE_OPEN = trade({
  id: 3, status: 'placed', tradeId: 't3', strategyId: 'other',
  option: { side: 'PE', strike: 84_000, size: 2, open: true, entry: 20, exit: null, pnlUsd: 0, exitReason: null, perpStop: 84_600, perpTarget: 85_500 },
});
const LOST = trade({ id: 4, perp: { status: 'stop', fillPrice: 84_990, filledAt: AT, exitPrice: 84_600, exitAt: AT + 300_000 } });
const strategies = [
  { id: 'sig', name: 'Breakout PE', enabled: true, config: DEFAULT_CONFIG },
  { id: 'other', name: 'BOS chain', enabled: true, config: DEFAULT_CONFIG },
] as unknown as Strategy[];

beforeEach(() => localStorage.clear());

describe('the signal trade history', () => {
  it('[critical] each trade: signal, option, perp entry, option entry, perp SL, perp TGT, exit, result, P&L -- with the times', () => {
    const won = { ...LIVE_WON, option: { ...LIVE_WON.option!, perpEntry: 85_020, perpExit: 84_480, entryAt: AT + 30_000, exitAt: AT + 900_000 } };
    render(<SignalTradeHistory trades={[won, trade({})]} strategies={strategies} />);
    const [, liveRow, would] = within(screen.getByRole('table', { name: 'signal trades' })).getAllByRole('row');
    const cell = (row: HTMLElement, name: string) => within(row).getByLabelText(name);
    expect(liveRow).toHaveTextContent('#6 BOS SELL');
    expect(liveRow).toHaveTextContent('5m + TF chain');
    expect(liveRow).toHaveTextContent('CE 86,000 ×1');
    expect(cell(liveRow!, 'perp entry')).toHaveTextContent('85,020');
    expect(cell(liveRow!, 'option entry')).toHaveTextContent(/^\$18\d{2} Oct/);         // the price, and when it filled under it
    expect(cell(liveRow!, 'perp SL')).toHaveTextContent(/^85,400$/);                 // not hit: no time
    expect(cell(liveRow!, 'perp TGT')).toHaveTextContent(/^84,500\d{2} Oct/);         // hit: the exit time under it
    expect(cell(liveRow!, 'option exit')).toHaveTextContent(/^\$4\.5$/);              // the TGT was hit: its time is under the TGT
    expect(cell(liveRow!, 'perp exit')).toHaveTextContent(/^84,480\d{2} Oct/);       // where the perp was as it was bought back, and when
    expect(liveRow).toHaveTextContent('perp TGT');
    expect(liveRow).toHaveTextContent('+₹1.15');
    // a would-sell: the perp's fill and when, the zone, TGT1 hit and when
    expect(cell(would!, 'perp entry')).toHaveTextContent(/^84,990zone 84,950–85,000\d{2} Oct/);
    expect(cell(would!, 'perp TGT')).toHaveTextContent(/^85,500\d{2} Oct.*TGT2 85,900$/);
    expect(would).toHaveTextContent('PE · would sell');
    expect(would).toHaveTextContent('TGT1 hit');
    expect(would).toHaveTextContent('paper');
  });

  it('[critical] an SL hit puts the exit time under the SL', () => {
    render(<SignalTradeHistory trades={[LOST]} strategies={strategies} />);
    const [, row] = within(screen.getByRole('table', { name: 'signal trades' })).getAllByRole('row');
    expect(within(row!).getByLabelText('perp SL')).toHaveTextContent(/^84,600\d{2} Oct/);
    expect(within(row!).getByLabelText('perp TGT')).toHaveTextContent(/^85,500TGT2/);
  });

  it('[critical] ten to a page, with the way through them', () => {
    const many = Array.from({ length: 23 }, (_, i) => trade({ id: 100 + i, at: AT - i * 60_000 }));
    render(<SignalTradeHistory trades={many} strategies={strategies} />);
    const rowsNow = () => within(screen.getByRole('table', { name: 'signal trades' })).getAllByRole('row').length - 1;
    expect(rowsNow()).toBe(10);
    expect(screen.getByRole('navigation', { name: 'trade history pages' })).toHaveTextContent('1–10 of 23 · page 1 of 3');
    expect(screen.getByRole('button', { name: 'previous page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'next page' }));
    expect(rowsNow()).toBe(3);
    expect(screen.getByRole('navigation', { name: 'trade history pages' })).toHaveTextContent('21–23 of 23 · page 3 of 3');
    expect(screen.getByRole('button', { name: 'next page' })).toBeDisabled();
    // the totals are over every page, not just this one
    expect(screen.getByLabelText('history totals')).toHaveTextContent('23 trades · 23 won');
    // a filter goes back to page 1
    fireEvent.click(screen.getByRole('button', { name: /^Would sell/ }));
    expect(screen.getByRole('navigation', { name: 'trade history pages' })).toHaveTextContent('page 1 of 3');
  });

  it('[critical] the totals follow the filter: won, lost, open, win rate, live P&L', () => {
    render(<SignalTradeHistory trades={[LIVE_WON, LIVE_OPEN, trade({}), LOST]} strategies={strategies} />);
    expect(screen.getByLabelText('history totals')).toHaveTextContent('4 trades · 2 won · 1 lost · 1 open · win rate 67% · live P&L +₹1.15');
    fireEvent.click(screen.getByRole('button', { name: /^Would sell/ }));
    expect(screen.getByLabelText('history totals')).toHaveTextContent('2 trades · 1 won · 1 lost · 0 open · win rate 50%');
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByLabelText('which strategy'), { target: { value: 'other' } });
    expect(screen.getByLabelText('history totals')).toHaveTextContent('1 trade · 0 won · 0 lost · 1 open');
  });

  it('[critical] the filters are kept across a refresh', () => {
    const { unmount } = render(<SignalTradeHistory trades={[LIVE_WON, trade({})]} strategies={strategies} />);
    fireEvent.click(screen.getByRole('button', { name: /^Live orders/ }));
    unmount();
    render(<SignalTradeHistory trades={[LIVE_WON, trade({})]} strategies={strategies} />);
    expect(screen.getByRole('button', { name: /^Live orders/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('table', { name: 'signal trades' })).getAllByRole('row')).toHaveLength(2);
  });

  it('the outcome in words', () => {
    expect(outcomeOf(trade({ perp: { status: 'filled', fillPrice: 1, filledAt: 1, exitPrice: null, exitAt: null } })).word).toBe('in the trade');
    expect(outcomeOf(trade({ perp: { status: 'open', fillPrice: null, filledAt: null, exitPrice: null, exitAt: null } })).word).toBe('waiting at the zone');
    expect(outcomeOf(trade({ perp: { status: 'expired', fillPrice: null, filledAt: null, exitPrice: null, exitAt: null } })).word).toBe('never filled');
    expect(outcomeOf(LIVE_OPEN).word).toBe('open');
    expect(outcomeOf({ ...LIVE_WON, option: { ...LIVE_WON.option!, exitReason: "BTC perp at 85410 reached the signal's stop 85400", pnlUsd: -0.01 } }))
      .toMatchObject({ word: 'perp SL', tone: 'down' });
    expect(outcomeOf({ ...LIVE_WON, option: { ...LIVE_WON.option!, exitReason: 'closed at 5:29 PM, the end of its window' } }).word).toBe('window end');
  });
});

describe('the tabs', () => {
  const SKIP = trade({ id: 9, status: 'skipped', detail: '#55 Pulled wall BUY | already 2 of its trades open (at most 2)', perp: null, levels: null });
  const REFUSED = trade({ id: 10, status: 'refused', detail: '#11 Order flow BUY | refused: Last quote is 7.6s old.', perp: null, levels: null });

  it('[critical] each with its count; Skipped lists the signals not taken, with why -- and they are in no trade figure', () => {
    render(<SignalTradeHistory trades={[LIVE_WON, LIVE_OPEN, trade({}), LOST, SKIP, REFUSED]} strategies={strategies} />);
    const labels = within(screen.getByRole('group', { name: 'which trades' })).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['All 4', 'Live orders 2', 'Live open 1', 'Live closed 1', 'Would sell 2', 'Open 1', 'Won 2', 'Lost 1', 'Skipped 2']);
    expect(screen.getByLabelText('history totals')).toHaveTextContent('4 trades · 2 won · 1 lost · 1 open');

    fireEvent.click(screen.getByRole('button', { name: /^Skipped/ }));
    expect(screen.getByLabelText('history totals')).toHaveTextContent('2 signals not taken');
    const why = screen.getAllByLabelText('why not taken').map((c) => c.textContent);
    expect(why).toEqual(['skippedalready 2 of its trades open (at most 2)', 'refusedrefused: Last quote is 7.6s old.']);

    fireEvent.click(screen.getByRole('button', { name: /^Won/ }));
    expect(within(screen.getByRole('table', { name: 'signal trades' })).getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /^Lost/ }));
    expect(screen.getByLabelText('history totals')).toHaveTextContent('1 trade · 0 won · 1 lost');
  });

  it('the counts follow the strategy picked', () => {
    render(<SignalTradeHistory trades={[LIVE_WON, LIVE_OPEN, SKIP]} strategies={strategies} />);
    fireEvent.change(screen.getByLabelText('which strategy'), { target: { value: 'other' } });
    expect(screen.getByRole('button', { name: /^All/ })).toHaveTextContent('All 1');
    expect(screen.getByRole('button', { name: /^Skipped/ })).toHaveTextContent('Skipped 0');
  });
});

describe('the perp points', () => {
  it('[critical] approximate points (a trade from before they were kept) are marked ≈; a would-sell not filled says so', () => {
    const old = { ...LIVE_WON, id: 21, option: { ...LIVE_WON.option!, perpEntry: 85_870, perpEntryApprox: true, perpExit: 84_500, perpExitApprox: true, entryAt: AT, exitAt: AT + 60_000 } };
    const waiting = trade({ id: 22, perp: { status: 'open', fillPrice: null, filledAt: null, exitPrice: null, exitAt: null } });
    const never = trade({ id: 23, perp: { status: 'expired', fillPrice: null, filledAt: null, exitPrice: null, exitAt: null } });
    render(<SignalTradeHistory trades={[old, waiting, never]} strategies={strategies} />);
    const [, a, b, c] = within(screen.getByRole('table', { name: 'signal trades' })).getAllByRole('row');
    expect(within(a!).getByLabelText('perp entry')).toHaveTextContent(/^≈85,870/);
    expect(within(a!).getByLabelText('perp exit')).toHaveTextContent(/^≈84,500/);
    expect(within(b!).getByLabelText('perp entry')).toHaveTextContent(/^waitingzone/);
    expect(within(c!).getByLabelText('perp entry')).toHaveTextContent(/^never filledzone/);
  });
});

describe('search, sort, and the live tabs', () => {
  const rowsText = () => within(screen.getByRole('table', { name: 'signal trades' })).getAllByRole('row').slice(1).map((r) => r.textContent ?? '');

  it('[critical] Live open and Live closed split the live orders', () => {
    render(<SignalTradeHistory trades={[LIVE_WON, LIVE_OPEN, trade({})]} strategies={strategies} />);
    fireEvent.click(screen.getByRole('button', { name: /^Live open/ }));
    expect(rowsText()).toHaveLength(1);
    expect(rowsText()[0]).toMatch(/PE 84,000 ×2/);
    fireEvent.click(screen.getByRole('button', { name: /^Live closed/ }));
    expect(rowsText()).toHaveLength(1);
    expect(rowsText()[0]).toMatch(/CE 86,000 ×1/);
  });

  it('[critical] search: by method, strike, strategy or result -- every word must match; kept across a refresh', () => {
    const { unmount } = render(<SignalTradeHistory trades={[LIVE_WON, LIVE_OPEN, trade({}), LOST]} strategies={strategies} />);
    const box = screen.getByLabelText('search trades');
    fireEvent.change(box, { target: { value: '#6 bos' } });   // the method (the strategy "BOS chain" matches 'bos' alone)
    expect(rowsText()).toHaveLength(1);
    fireEvent.change(box, { target: { value: '86000' } });      // a strike
    expect(rowsText()).toHaveLength(1);
    fireEvent.change(box, { target: { value: 'breakout sl' } });
    expect(rowsText()).toHaveLength(1);                     // the one stopped out
    fireEvent.change(box, { target: { value: 'nothing-like-this' } });
    expect(screen.getByText(/Nothing matches “nothing-like-this”/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'BOS chain' } });  // the strategy's name
    unmount();
    render(<SignalTradeHistory trades={[LIVE_WON, LIVE_OPEN, trade({}), LOST]} strategies={strategies} />);
    expect(screen.getByLabelText('search trades')).toHaveValue('BOS chain');
  });

  it('[critical] click a header to sort, again to reverse; blanks stay last; time is the default, newest first', () => {
    const a = { ...LIVE_WON, id: 31, at: AT + 3_000, option: { ...LIVE_WON.option!, pnlUsd: -0.2 } };
    const b = { ...LIVE_WON, id: 32, at: AT + 2_000, option: { ...LIVE_WON.option!, pnlUsd: 0.5 } };
    const c = { ...LIVE_OPEN, id: 33, at: AT + 1_000 };                 // open: no P&L yet
    render(<SignalTradeHistory trades={[c, b, a]} strategies={strategies} />);
    fireEvent.click(screen.getByRole('button', { name: /^Live orders/ }));
    const pnl = () => rowsText().map((t) => t.match(/[+\-−]₹[\d.]+|—$/)?.[0]?.replace('−', '-'));
    expect(pnl()).toEqual(['-₹17.00', '+₹42.50', '—']);           // time, newest first
    fireEvent.click(screen.getByRole('button', { name: 'sort by P&L' }));
    expect(screen.getByRole('columnheader', { name: /P&L/ })).toHaveAttribute('aria-sort', 'descending');
    expect(pnl()).toEqual(['+₹42.50', '-₹17.00', '—']);
    fireEvent.click(screen.getByRole('button', { name: 'sort by P&L' }));
    expect(pnl()).toEqual(['-₹17.00', '+₹42.50', '—']);           // reversed; the open one still last
    fireEvent.click(screen.getByRole('button', { name: 'sort by time' }));
    expect(pnl()).toEqual(['-₹17.00', '+₹42.50', '—']);           // back to newest first
  });

  it('sortTrades: numbers by value, words alphabetically, blanks last both ways', () => {
    const x = [trade({ id: 1, at: 1, levels: { ...levels, stop: 300 } }), trade({ id: 2, at: 2, levels: null, perp: null }), trade({ id: 3, at: 3, levels: { ...levels, stop: 100 } })];
    expect(sortTrades(x, { key: 'sl', asc: true }).map((t) => t.id)).toEqual([3, 1, 2]);
    expect(sortTrades(x, { key: 'sl', asc: false }).map((t) => t.id)).toEqual([1, 3, 2]);
  });
});

describe('the Excel download', () => {
  it('[critical] one row per trade, every figure, plain numbers, IST times', () => {
    const won = { ...LIVE_WON, option: { ...LIVE_WON.option!, perpEntry: 85_020, perpExit: 84_480, entryAt: AT + 30_000, exitAt: AT + 900_000 } };
    const csv = tradesCsv([won, trade({})], (id) => (id === 'sig' ? 'Breakout PE' : id));
    const [head, live, would] = csv.split('\r\n');
    const h = head!.split(',');
    const at = (line: string, col: string) => line.split(',')[h.indexOf(col)];
    expect(h.slice(0, 4)).toEqual(['Signal time (IST)', 'Strategy', 'Kind', 'Signal']);
    expect(at(live!, 'Signal time (IST)')).toBe('2026-10-02 10:30:00');      // 05:00 UTC
    expect(at(live!, 'Kind')).toBe('live order');
    expect(at(live!, 'Strike')).toBe('86000');
    expect(at(live!, 'Perp entry')).toBe('85020');
    expect(at(live!, 'Option entry ($)')).toBe('18');
    expect(at(live!, 'Perp TGT')).toBe('84500');
    expect(at(live!, 'Hit')).toBe('TGT');
    expect(at(live!, 'Perp exit')).toBe('84480');
    expect(at(live!, 'Exit time (IST)')).toBe('2026-10-02 10:45:00');
    expect(at(live!, 'P&L (₹)')).toBe('1.15');
    expect(at(would!, 'Kind')).toBe('would sell');
    expect(at(would!, 'Result')).toBe('TGT1 hit');
    expect(at(would!, 'P&L ($)')).toBe('');
  });

  it('the button downloads what is shown, and is off with nothing to download', () => {
    render(<SignalTradeHistory trades={[trade({})]} strategies={strategies} />);
    expect(screen.getByRole('button', { name: 'download as a spreadsheet' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^Live orders/ }));
    expect(screen.getByRole('button', { name: 'download as a spreadsheet' })).toBeDisabled();
  });
});
