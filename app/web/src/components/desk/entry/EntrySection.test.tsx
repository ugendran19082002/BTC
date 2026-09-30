import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EntrySection } from './EntrySection';
import { recordText, signalOf, tickOf } from './parts';
import type { EntryBoard, EntryRecord, MethodRead } from '@/types/entry';

const priceLines: { title: string; price: number }[] = [];
vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
  CandlestickSeries: 'candles',
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({
      setData: vi.fn(),
      createPriceLine: vi.fn((o: { title: string; price: number }) => { priceLines.push(o); return o; }),
      removePriceLine: vi.fn((o: { title: string; price: number }) => { priceLines.splice(priceLines.indexOf(o), 1); }),
    })),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  })),
}));

const getEntryBoard = vi.fn();
const getEntryRecord = vi.fn();
vi.mock('@/api/entry', () => ({
  getEntryBoard: (...a: unknown[]) => getEntryBoard(...a),
  getEntryRecord: (...a: unknown[]) => getEntryRecord(...a),
}));
const getCandles = vi.fn(async () => ({ bars: [{ time: 1, open: 84_000, high: 84_200, low: 83_900, close: 84_120, volume: 1 }] }));
vi.mock('@/api/desk', () => ({ getCandles: (...a: unknown[]) => getCandles(...(a as [])) }));

/**
 * The reference layout: the twelve methods without the timeframe chain and
 * with it, side by side. What it must never do: draw levels for anything but a
 * TRADE, call a quality score a confidence, show a TAKE TRADE button, or show a
 * record that is not the paper log's.
 */

const NAMES = ['Breakout', 'Breakout + retest', 'Liquidity sweep', 'FVG retest', 'Order-block retest', 'BOS', 'MSS / CHoCH', 'Momentum', 'Pullback', 'VWAP / mean reversion', 'Order flow', 'Options / derivatives'];

function read(n: number, mode: 'mtf' | 'single', over: Partial<MethodRead> = {}): MethodRead {
  return {
    id: `m${n}`, n, name: NAMES[n - 1]!, group: 'breakout', mode, tf: '5m', dir: null, state: 'NO_TRADE',
    steps: [], gates: [], plan: null, score: null, scoreParts: [], alignment: null, reason: 'nothing forming', triggerTime: null, ...over,
  };
}

const TRADE = read(3, 'mtf', {
  state: 'TRADE', dir: 'long', score: 72, alignment: 100, reason: 'long -- Liquidity sweep with the timeframe chain', triggerTime: 1,
  plan: { entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: 84_500, tp3: null, tpWhy: ['5m swing high 84,300', 'ask wall 84,500'], rr: 1.9 },
  steps: [{ tf: '4h', label: 'macro context: with it', ok: true }, { tf: '5m', label: 'swept a swing low', ok: true }, { tf: '1m', label: 'execution: at the entry', ok: true }],
});
const WAITING = read(7, 'single', {
  state: 'WAIT', dir: 'short', score: 40, reason: 'waiting for 5m: liquidity swept first',
  steps: [{ tf: '5m', label: 'the trend was up', ok: true }, { tf: '5m', label: 'liquidity swept first', ok: false }, { tf: '5m', label: 'delta turned', ok: null }],
});

function board(): EntryBoard {
  return {
    at: Date.UTC(2026, 8, 30, 10, 0), tf: '5m', chain: [],
    reads: [
      ...Array.from({ length: 12 }, (_, i) => (i + 1 === 3 ? TRADE : read(i + 1, 'mtf'))),
      ...Array.from({ length: 12 }, (_, i) => (i + 1 === 7 ? WAITING : read(i + 1, 'single'))),
    ],
    timeframes: [
      { tf: '4h', role: 'macro context', trend: 1, label: 'Bullish', structure: 'HH / HL' },
      { tf: '1h', role: 'major structure', trend: -1, label: 'Bearish', structure: 'LH / LL' },
    ],
  };
}

const total = (mode: 'mtf' | 'single', over: Partial<EntryRecord> = {}): EntryRecord => ({
  method: 'all', mode, tf: '5m', setups: 20, trades: 10, wins: 4, expired: 6, working: 4, avgR: -0.12, sumR: -1.2,
  profitFactor: 0.8, maxDrawdownR: -3.5, avgWinR: 1.9, avgLossR: -1.1, since: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  priceLines.length = 0;
  localStorage.clear();
  getEntryBoard.mockResolvedValue(board());
  getEntryRecord.mockResolvedValue({ records: [], totals: [total('mtf'), total('single', { trades: 0, setups: 3 })], recent: [] });
});

const panel = (name: RegExp) => screen.findByRole('region', { name });

describe('the entry section, side by side', () => {
  it('[critical] 24 setups: twelve without the timeframe chain, twelve with it', async () => {
    render(<EntrySection onOverlay={vi.fn()} />);
    const without = await panel(/12 methods · without timeframe/);
    const withTf = screen.getByRole('region', { name: /12 methods \+ timeframe/ });
    expect(within(without).getAllByRole('button', { pressed: false }).filter((b) => NAMES.some((n) => b.textContent?.includes(n))).length).toBeGreaterThanOrEqual(11);
    expect(within(withTf).getByRole('table', { name: 'with timeframe methods' }).querySelectorAll('tbody tr')).toHaveLength(12);
    expect(within(without).getByRole('table', { name: 'without timeframe methods' }).querySelectorAll('tbody tr')).toHaveLength(12);
    expect(await screen.findByText(/1 trade · 1 wait · 22 no trade/)).toBeInTheDocument();
  });

  it('[critical] a TRADE: BUY, LONG SETUP with entry, stop, targets in R, risk and reward -- and no TAKE TRADE', async () => {
    render(<EntrySection onOverlay={vi.fn()} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    const card = await within(withTf).findByRole('region', { name: 'selected setup' });
    expect(within(card).getByText('LONG SETUP')).toBeInTheDocument();
    expect(within(card).getByText('84,120 – 84,160')).toBeInTheDocument();
    expect(within(card).getByText('84,300 (1.0R)')).toBeInTheDocument();
    expect(within(card).getAllByText('160 (0.19%)')).toHaveLength(2); // risk and reward: a 1.0R target
    expect(within(card).getByText('72/100')).toBeInTheDocument();
    expect(within(card).getByText(/Paper-logged and graded after fees · no order is placed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take trade/i })).toBeNull();
    expect(screen.queryByText(/confidence/i)).toBeNull();
    expect(within(withTf).getAllByText('BUY').length).toBe(1);
  });

  it('[critical] the TRADE is drawn on its panel\'s chart and on the desk chart above; Setups off clears both', async () => {
    const onOverlay = vi.fn();
    render(<EntrySection onOverlay={onOverlay} />);
    await waitFor(() => expect(onOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ dir: 'long', entryLo: 84_120, tp1: 84_300, label: '#3 Liquidity sweep (with TF)' })));
    await waitFor(() => expect(priceLines.map((l) => l.title)).toEqual(expect.arrayContaining(['ENTRY 84,120–84,160', 'SL 83,980', 'TP1 84,300', 'TP2 84,500'])));
    fireEvent.click(screen.getByRole('switch', { name: /Setups on chart/ }));
    expect(onOverlay).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(priceLines).toHaveLength(0));
  });

  it('[critical] a WAIT shows what it waits for and what was not read, and draws no levels', async () => {
    const onOverlay = vi.fn();
    render(<EntrySection onOverlay={onOverlay} />);
    const without = await panel(/12 methods · without timeframe/);
    const card = await within(without).findByRole('region', { name: 'selected setup' });
    expect(within(card).getByText('WAIT · short forming')).toBeInTheDocument();
    expect(within(card).getByText('waiting for 5m: liquidity swept first')).toBeInTheDocument();
    expect(within(card).queryByText('Stop loss')).toBeNull();
    const reasons = within(without).getByRole('region', { name: 'key reasons' });
    expect(within(reasons).getByText('delta turned (not read)')).toBeInTheDocument();
    fireEvent.click(within(without).getByRole('button', { name: /MSS \/ CHoCH/ }));
    expect(onOverlay).toHaveBeenLastCalledWith(null);
  });

  it('the timeframe analysis is on the with-timeframe side only', async () => {
    render(<EntrySection onOverlay={vi.fn()} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    const tfs = within(withTf).getByRole('region', { name: 'timeframe analysis' });
    expect(within(tfs).getByText('↑ Bullish')).toBeInTheDocument();
    expect(within(tfs).getByText('LH / LL')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: /12 methods · without timeframe/ })).queryByRole('region', { name: 'timeframe analysis' })).toBeNull();
  });

  it('[critical] the records are the paper log\'s, and "no record" where there is none', async () => {
    render(<EntrySection onOverlay={vi.fn()} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    const rec = await within(withTf).findByRole('region', { name: 'paper record' });
    await waitFor(() => expect(within(rec).getByText('40%')).toBeInTheDocument());
    expect(within(rec).getByText('0.80')).toBeInTheDocument();
    expect(within(rec).getByText('−1.2R')).toBeInTheDocument();
    const cmp = screen.getByRole('region', { name: 'with and without timeframe compared' });
    const trades = within(cmp).getByRole('row', { name: /Trades closed/ });
    expect(within(trades).getAllByRole('cell').map((c) => c.textContent)).toEqual(['–', '10']);
  });

  it('the timeframe without the chain is asked for from the server', async () => {
    render(<EntrySection onOverlay={vi.fn()} />);
    await panel(/12 methods · without timeframe/);
    fireEvent.change(screen.getByRole('combobox', { name: 'timeframe without the chain' }), { target: { value: '15m' } });
    await waitFor(() => expect(getEntryBoard).toHaveBeenLastCalledWith('15m'));
  });

  it('12 charts: one mode at a time', async () => {
    render(<EntrySection onOverlay={vi.fn()} />);
    await panel(/12 methods \+ timeframe/);
    fireEvent.click(screen.getByRole('button', { name: '12 charts' }));
    expect(screen.getAllByRole('figure')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: /Without timeframe · 5m/ }));
    expect(screen.getAllByRole('figure')).toHaveLength(12);
  });
});

describe('the pieces', () => {
  it('BUY / SELL only for a TRADE', () => {
    expect(signalOf({ state: 'TRADE', dir: 'long' })).toBe('BUY');
    expect(signalOf({ state: 'TRADE', dir: 'short' })).toBe('SELL');
    expect(signalOf({ state: 'WAIT', dir: 'long' })).toBe('WAIT');
    expect(signalOf({ state: 'NO_TRADE', dir: null })).toBe('NO');
  });
  it('✓ passed, ✗ failed, ? not read, · not part of the read', () => {
    expect(tickOf(TRADE, '4h')).toBe('✓');
    expect(tickOf(WAITING, '5m')).toBe('✗');
    expect(tickOf(read(1, 'mtf', { steps: [{ tf: '3m', label: 'x', ok: null }] }), '3m')).toBe('?');
    expect(tickOf(TRADE, '30m')).toBe('·');
  });
  it('a record says what it is, including that there is none yet', () => {
    expect(recordText(null)).toBe('no record yet');
    expect(recordText(total('mtf', { trades: 0, setups: 3 }))).toBe('3 logged, none closed');
    expect(recordText(total('mtf'))).toBe('10 trades · 40% · −0.12R');
  });
});
