import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EntrySection, recordText, tickOf } from './EntrySection';
import type { EntryBoard, MethodRead } from '@/types/entry';

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
  CandlestickSeries: 'candles',
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({ setData: vi.fn(), createPriceLine: vi.fn(() => ({})), removePriceLine: vi.fn() })),
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
vi.mock('@/api/desk', () => ({ getCandles: vi.fn(async () => ({ bars: [] })) }));

/**
 * The entry section shows what the server decided and draws only a TRADE.
 * TEST.md: WAIT and NO TRADE put no entry, stop or target on the chart.
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
  plan: { entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: 84_500, tp3: null, tpWhy: ['5m swing high 84,300', 'ask wall 84,500'], rr: 2.4 },
  steps: [{ tf: '4h', label: 'macro context: with it', ok: true }, { tf: '5m', label: 'swept a swing low', ok: true }, { tf: '1m', label: 'execution: at the entry', ok: true }],
});
const WAITING = read(7, 'single', {
  state: 'WAIT', dir: 'short', reason: 'waiting for 5m: liquidity swept first',
  steps: [{ tf: '5m', label: 'the trend was up', ok: true }, { tf: '5m', label: 'liquidity swept first', ok: false }, { tf: '5m', label: 'delta turned', ok: null }],
});

function board(): EntryBoard {
  const reads = [
    ...Array.from({ length: 12 }, (_, i) => (i + 1 === 3 ? TRADE : read(i + 1, 'mtf'))),
    ...Array.from({ length: 12 }, (_, i) => (i + 1 === 7 ? WAITING : read(i + 1, 'single'))),
  ];
  return { at: 0, tf: '5m', reads, chain: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getEntryBoard.mockResolvedValue(board());
  getEntryRecord.mockResolvedValue({ records: [{ method: 'm3', mode: 'mtf', tf: '5m', setups: 14, trades: 10, wins: 4, expired: 3, working: 1, avgR: -0.12, sumR: -1.2, since: 0 }], recent: [] });
});

describe('the entry section', () => {
  it('[critical] 24 setups: the twelve methods with the timeframe chain, and the twelve without', async () => {
    render(<EntrySection bars={[]} onOverlay={vi.fn()} />);
    const withTf = await screen.findByRole('region', { name: 'With timeframe entry methods' });
    const without = screen.getByRole('region', { name: 'Without timeframe entry methods' });
    expect(within(withTf).getAllByRole('row')).toHaveLength(13);
    expect(within(without).getAllByRole('row')).toHaveLength(13);
    expect(screen.getByText('1 trade · 1 wait · of 24')).toBeInTheDocument();
  });

  it('[critical] the TRADE is drawn on the chart: its entry, stop and targets', async () => {
    const onOverlay = vi.fn();
    render(<EntrySection bars={[]} onOverlay={onOverlay} />);
    await waitFor(() => expect(onOverlay).toHaveBeenLastCalledWith(expect.objectContaining({
      dir: 'long', entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: 84_500, label: '#3 Liquidity sweep (with TF)',
    })));
    expect(screen.getByText('10 trades · 40% · −0.12R', { selector: 'td' })).toBeInTheDocument();
  });

  it('[critical] Setups off: the plain chart', async () => {
    const onOverlay = vi.fn();
    render(<EntrySection bars={[]} onOverlay={onOverlay} />);
    await waitFor(() => expect(onOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ dir: 'long' })));
    fireEvent.click(screen.getByRole('switch', { name: /Setups on chart/ }));
    expect(onOverlay).toHaveBeenLastCalledWith(null);
  });

  it('[critical] a WAIT draws nothing, and says what it waits for and what could not be read', async () => {
    const onOverlay = vi.fn();
    render(<EntrySection bars={[]} onOverlay={onOverlay} />);
    const without = await screen.findByRole('region', { name: 'Without timeframe entry methods' });
    fireEvent.click(within(without).getByRole('button', { name: /MSS \/ CHoCH/ }));
    expect(onOverlay).toHaveBeenLastCalledWith(null);
    const detail = screen.getByRole('region', { name: 'chosen entry setup' });
    expect(within(detail).getByText('waiting for 5m: liquidity swept first')).toBeInTheDocument();
    expect(within(detail).getByText('delta turned (not read)')).toBeInTheDocument();
  });

  it('the grid shows the twelve of one mode as twelve charts', async () => {
    render(<EntrySection bars={[]} onOverlay={vi.fn()} />);
    await screen.findByRole('region', { name: 'With timeframe entry methods' });
    fireEvent.click(screen.getByRole('button', { name: '12 charts' }));
    expect(screen.getAllByRole('figure')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: /Without timeframe · 5m/ }));
    expect(screen.getAllByRole('figure')).toHaveLength(12);
  });

  it('the timeframe without the chain is asked for from the server', async () => {
    render(<EntrySection bars={[]} onOverlay={vi.fn()} />);
    await screen.findByRole('region', { name: 'With timeframe entry methods' });
    fireEvent.change(screen.getByRole('combobox', { name: 'timeframe without the chain' }), { target: { value: '15m' } });
    await waitFor(() => expect(getEntryBoard).toHaveBeenLastCalledWith('15m'));
  });
});

describe('the board\'s ticks and record', () => {
  it('✓ passed, ✗ failed, ? not read, · not part of the read', () => {
    expect(tickOf(TRADE, '4h')).toBe('✓');
    expect(tickOf(WAITING, '5m')).toBe('✗');
    expect(tickOf(read(1, 'mtf', { steps: [{ tf: '3m', label: 'x', ok: null }] }), '3m')).toBe('?');
    expect(tickOf(TRADE, '30m')).toBe('·');
  });
  it('a record says what it is, including that there is none yet', () => {
    expect(recordText(null)).toBe('no record yet');
    expect(recordText({ method: 'm', mode: 'mtf', tf: '5m', setups: 3, trades: 0, wins: 0, expired: 1, working: 2, avgR: null, sumR: null, since: 0 })).toBe('3 logged, none closed');
  });
});
