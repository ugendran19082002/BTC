import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalHistory, outcomeOf, startOfIstDay, stood } from './SignalHistory';
import type { EntrySignal } from '@/types/entry';

const getEntrySignals = vi.fn();
vi.mock('@/api/entry', () => ({ getEntrySignals: (...a: unknown[]) => getEntrySignals(...a) }));

const T = Date.UTC(2026, 8, 30, 14, 33);
const sig = (over: Partial<EntrySignal> = {}): EntrySignal => ({
  method: 'fvg-retest', n: 4, name: 'FVG retest', mode: 'single', tf: '3m', dir: -1, state: 'TRADE',
  triggerAt: 1, firstSeen: T, lastSeen: T + 12 * 60_000, score: 50, reason: 'short -- FVG retest on 3m',
  entryLo: 84_391, entryHi: 84_523, stop: 84_825, tp1: 84_288, rr: 1.9, gatesOff: [],
  outcome: { status: 'tp1', fillPrice: 84_391, exitPrice: 84_288, exitAt: T + 30 * 60_000, rNet: 0.21 }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getEntrySignals.mockResolvedValue({ signals: [sig(), sig({ state: 'WAIT', dir: 1, method: 'bos', n: 6, name: 'BOS', mode: 'mtf', tf: '5m', entryLo: null, entryHi: null, stop: null, tp1: null, rr: null, outcome: null, gatesOff: ['rr'] })] });
});

describe('the signal history', () => {
  it('[critical] each signal in full: when (IST), method, way and timeframe, side, how long it stood, levels, and what became of it', async () => {
    render(<SignalHistory />);
    const table = await screen.findByRole('table', { name: 'signals' });
    const [trade, wait] = within(table).getAllByRole('row').slice(1);
    expect(trade).toHaveTextContent('20:03');
    expect(trade).toHaveTextContent('#4 FVG retest');
    expect(trade).toHaveTextContent('Without · 3m');
    expect(trade).toHaveTextContent('SELL');
    expect(trade).toHaveTextContent('12 min');
    expect(trade).toHaveTextContent('84,391–84,523');
    expect(trade).toHaveTextContent('84,825');
    expect(trade).toHaveTextContent('TP1 ✓ +0.21R');
    expect(wait).toHaveTextContent('WAIT BUY');
    expect(wait).toHaveTextContent('With TF · 5m');
    expect(wait).toHaveTextContent('gates off');
    expect(wait).toHaveTextContent('waited');
    expect(screen.getByRole('region', { name: 'signal history' })).toHaveTextContent('2 shown · 1 TRADE');
  });

  it('[critical] filters go to the server: way, state, timeframe, today; and are remembered', async () => {
    render(<SignalHistory />);
    await screen.findByRole('table', { name: 'signals' });
    expect(getEntrySignals).toHaveBeenLastCalledWith(expect.objectContaining({ since: startOfIstDay(Date.now()), limit: 200 }));
    fireEvent.click(within(screen.getByRole('group', { name: 'history way' })).getByRole('button', { name: 'With TF' }));
    await waitFor(() => expect(getEntrySignals).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'mtf' })));
    fireEvent.click(within(screen.getByRole('group', { name: 'history state' })).getByRole('button', { name: 'TRADE' }));
    await waitFor(() => expect(getEntrySignals).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'mtf', state: 'TRADE' })));
    fireEvent.click(within(screen.getByRole('group', { name: 'history timeframe' })).getByRole('button', { name: '15m' }));
    await waitFor(() => expect(getEntrySignals).toHaveBeenLastCalledWith(expect.objectContaining({ tf: '15m' })));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(getEntrySignals).toHaveBeenLastCalledWith(expect.objectContaining({ since: undefined })));
    expect(JSON.parse(localStorage.getItem('btc-desk:entry:history-filter')!)).toEqual({ mode: 'mtf', tf: '15m', state: 'TRADE', today: false });
  });

  it('with nothing for the filters, it says so in words', async () => {
    getEntrySignals.mockResolvedValue({ signals: [] });
    render(<SignalHistory />);
    expect(await screen.findByText(/No signals for these filters yet/)).toBeInTheDocument();
  });

  it('the pieces: how long it stood, what became of it, and the desk\'s day', () => {
    expect([stood(20_000), stood(4 * 60_000), stood(72 * 60_000)]).toEqual(['just now', '4 min', '1 h 12 min']);
    expect(outcomeOf(sig({ outcome: { status: 'open', fillPrice: null, exitPrice: null, exitAt: null, rNet: null } })).text).toBe('waiting for price');
    expect(outcomeOf(sig({ outcome: { status: 'stop', fillPrice: 1, exitPrice: 2, exitAt: 3, rNet: -1.1 } })).text).toBe('stop ✗ −1.10R');
    expect(outcomeOf(sig({ outcome: { status: 'expired', fillPrice: null, exitPrice: null, exitAt: null, rNet: null } })).text).toBe('expired, never filled');
    expect(outcomeOf(sig({ outcome: null })).text).toBe('not logged');
    // 00:00 IST on 1 Oct 2026 is 18:30 UTC on 30 Sep.
    expect(startOfIstDay(Date.UTC(2026, 8, 30, 20, 0))).toBe(Date.UTC(2026, 8, 30, 18, 30));
  });
});
