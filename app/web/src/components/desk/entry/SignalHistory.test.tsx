import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalHistory, exitOf, outcomeOf, startOfIstDay, stood } from './SignalHistory';
import type { EntrySignal, EntrySignalPage } from '@/types/entry';

const getEntrySignals = vi.fn();
vi.mock('@/api/entry', () => ({ getEntrySignals: (...a: unknown[]) => getEntrySignals(...a) }));

const T = Date.UTC(2026, 8, 30, 14, 33);
const sig = (over: Partial<EntrySignal> = {}): EntrySignal => ({
  method: 'fvg-retest', n: 4, name: 'FVG retest', mode: 'single', tf: '3m', dir: -1, state: 'TRADE',
  triggerAt: 1, firstSeen: T, lastSeen: T + 12 * 60_000, score: 50, reason: 'short -- FVG retest on 3m',
  entryLo: 84_391, entryHi: 84_523, stop: 84_825, tp1: 84_288, rr: 1.9, gatesOff: [], ltp: 84_402.5, indexPrice: 84_380.1,
  outcome: { status: 'tp1', fillPrice: 84_391, exitPrice: 84_288, exitAt: T + 30 * 60_000, rNet: 0.21 }, ...over,
});
const SUMMARY = { trades: 9, tp1: 4, tp1Pts: 1_210, stops: 3, slPts: 960, timeouts: 1, netPts: 180, netR: 0.42, open: 1 };
const page = (signals: EntrySignal[], total = signals.length): EntrySignalPage => ({ signals, total, summary: SUMMARY });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getEntrySignals.mockResolvedValue(page([
    sig(),
    sig({ state: 'WAIT', dir: 1, method: 'bos', n: 6, name: 'BOS', mode: 'mtf', tf: '5m', entryLo: null, entryHi: null, stop: null, tp1: null, rr: null, outcome: null, gatesOff: ['rr'], triggerAt: 2 }),
    sig({ dir: 1, triggerAt: 3, entryLo: 84_000, entryHi: 84_040, stop: 83_800, tp1: 84_300, outcome: { status: 'stop', fillPrice: 84_040, exitPrice: 83_800, exitAt: T, rNet: -1.1 } }),
  ], 60));
});

describe('the signal history table', () => {
  it('[critical] each signal in full: when, the price then (LTP · index), levels, fill → exit and why, the result in points and R', async () => {
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const [trade, wait, stopped] = within(table).getAllByRole('row').slice(1);
    expect(trade).toHaveTextContent('20:03');
    expect(trade).toHaveTextContent('#4 FVG retest');
    expect(trade).toHaveTextContent('Without · 3m');
    expect(trade).toHaveTextContent('SELL');
    expect(trade).toHaveTextContent('84,403 · 84,380');
    expect(trade).toHaveTextContent('84,391 → 84,288 TGT');
    expect(trade).toHaveTextContent('TP1 ✓ +0.21R (+103 pts)');
    expect(wait).toHaveTextContent('WAIT BUY');
    expect(wait).toHaveTextContent('gates off');
    expect(wait).toHaveTextContent('waited');
    expect(stopped).toHaveTextContent('84,040 → 83,800 SL');
    expect(stopped).toHaveTextContent('stop ✗ −1.10R (−240 pts)');
  });

  it('[critical] the totals over every match, not just the page: TP1 hits and target pts, stops and SL pts, net pts and R', async () => {
    render(<SignalHistory />);
    const t = await screen.findByLabelText('history totals');
    expect(t).toHaveTextContent('TRADEs9 · 1 open');
    expect(t).toHaveTextContent('TP1 hits · target pts4 · +1,210');
    expect(t).toHaveTextContent('Stops · SL pts3 · −960');
    expect(t).toHaveTextContent('Net pts+180');
    expect(t).toHaveTextContent('Net R (after fees)+0.42R');
  });

  it('[critical] signal tabs: All, TRADING, BUY & SELL, BUY, SELL, WAIT -- each asks the server for exactly that', async () => {
    render(<SignalHistory />);
    await screen.findByRole('table', { name: 'signals' });
    const tabs = screen.getByRole('tablist', { name: 'signal tabs' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['All', 'TRADING', 'BUY & SELL', 'BUY', 'SELL', 'WAIT']);
    const last = () => getEntrySignals.mock.lastCall![0];
    fireEvent.click(within(tabs).getByRole('tab', { name: 'TRADING' }));
    await waitFor(() => expect(last()).toMatchObject({ state: 'TRADE', live: true })); // in play now: at the zone or filled
    fireEvent.click(within(tabs).getByRole('tab', { name: 'BUY' }));
    await waitFor(() => { expect(last()).toMatchObject({ state: 'TRADE', dir: 1 }); expect(last().live).toBeUndefined(); });
    fireEvent.click(within(tabs).getByRole('tab', { name: 'SELL' }));
    await waitFor(() => expect(last()).toMatchObject({ state: 'TRADE', dir: -1 }));
    fireEvent.click(within(tabs).getByRole('tab', { name: 'BUY & SELL' }));
    await waitFor(() => { expect(last()).toMatchObject({ state: 'TRADE' }); expect(last().dir).toBeUndefined(); });
    fireEvent.click(within(tabs).getByRole('tab', { name: 'WAIT' }));
    await waitFor(() => expect(last()).toMatchObject({ state: 'WAIT' }));
    expect(within(tabs).getByRole('tab', { name: 'WAIT' })).toHaveAttribute('aria-selected', 'true');
  });

  it('[critical] pages: "1–25 of 60", next and previous ask for the right offset, the page size is a choice', async () => {
    render(<SignalHistory />);
    const nav = await screen.findByRole('navigation', { name: 'history pages' });
    expect(nav).toHaveTextContent('1–25 of 60');
    expect(nav).toHaveTextContent('Page 1 of 3');
    expect(within(nav).getByRole('button', { name: 'previous page' })).toBeDisabled();
    fireEvent.click(within(nav).getByRole('button', { name: 'next page' }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ offset: 25, limit: 25 }));
    await waitFor(() => expect(nav).toHaveTextContent('26–50 of 60'));
    fireEvent.click(within(within(nav).getByRole('group', { name: 'rows per page' })).getByRole('button', { name: '50' }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ offset: 0, limit: 50 })); // a new size starts at the first page
  });

  it('[critical] sorting is on the server, so it is right across every page: time, R:R, quality', async () => {
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    expect(within(table).getByRole('columnheader', { name: /Time \(IST\)/ })).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(within(table).getByRole('button', { name: /^R:R/ }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ sort: 'rr' }));
    fireEvent.click(within(await screen.findByRole('table', { name: 'signals' })).getByRole('button', { name: /^R:R/ }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ sort: 'rr', asc: true }));
  });

  it('filters -- way, timeframe, today -- go to the server and are remembered', async () => {
    render(<SignalHistory />);
    await screen.findByRole('table', { name: 'signals' });
    expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ since: startOfIstDay(Date.now()) });
    fireEvent.click(within(screen.getByRole('group', { name: 'history way' })).getByRole('button', { name: 'With TF' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'history timeframe' })).getByRole('button', { name: '15m' }));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(getEntrySignals.mock.lastCall![0]).toMatchObject({ mode: 'mtf', tf: '15m', since: undefined }));
    expect(JSON.parse(localStorage.getItem('btc-desk:entry:history-table')!)).toMatchObject({ mode: 'mtf', tf: '15m', today: false });
  });

  it('with nothing for the filters, it says so in words', async () => {
    getEntrySignals.mockResolvedValue(page([], 0));
    render(<SignalHistory />);
    expect(await screen.findByText(/No signals for these filters yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'TRADING' }));
    expect(await screen.findByText(/Nothing in play right now/)).toBeInTheDocument();
  });

  it('the pieces: how long it stood, what became of it, the exit and why, the desk\'s day', () => {
    expect([stood(20_000), stood(4 * 60_000), stood(72 * 60_000)]).toEqual(['just now', '4 min', '1 h 12 min']);
    expect(outcomeOf(sig({ outcome: { status: 'open', fillPrice: null, exitPrice: null, exitAt: null, rNet: null } })).text).toBe('waiting for price');
    expect(outcomeOf(sig({ outcome: { status: 'expired', fillPrice: null, exitPrice: null, exitAt: null, rNet: null } })).text).toBe('expired, never filled');
    expect(exitOf(sig())).toEqual({ price: '84,288', why: 'TGT', pts: 103 });
    expect(exitOf(sig({ outcome: { status: 'timeout', fillPrice: 84_391, exitPrice: 84_400, exitAt: T, rNet: -0.1 } }))).toEqual({ price: '84,400', why: 'time', pts: -9 });
    expect(exitOf(sig({ outcome: { status: 'filled', fillPrice: 84_391, exitPrice: null, exitAt: null, rNet: null } }))).toBeNull();
    // 00:00 IST on 1 Oct 2026 is 18:30 UTC on 30 Sep.
    expect(startOfIstDay(Date.UTC(2026, 8, 30, 20, 0))).toBe(Date.UTC(2026, 8, 30, 18, 30));
  });
});
