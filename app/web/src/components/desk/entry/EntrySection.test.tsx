import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EntrySection } from './EntrySection';
import { recordText, signalOf, tickOf } from './parts';
import type { EntryBoard, EntryRecord, MethodRead } from '@/types/entry';

/*
 * Each panel's chart is the desk's PriceChart, which has its own tests; here it
 * is a stub that shows what it was handed -- the timeframe, the size, and the
 * setup it was asked to draw.
 */
type Drawn = { label: string; tf: string; size?: string; bars: unknown[]; entry: { label: string; entryLo: number; tp1: number; dir: string } | null };
const charts = new Map<string, Drawn>();
vi.mock('@/components/desk/PriceChart', () => ({
  PriceChart: (p: Drawn) => {
    charts.set(p.label, p);
    return <div role="img" aria-label={p.label} data-tf={p.tf} data-size={p.size} data-entry={p.entry?.label ?? ''} />;
  },
}));
const drawnOn = (label: string) => screen.getByRole('img', { name: label }).getAttribute('data-entry');

const getEntryBoard = vi.fn();
const getEntryRecord = vi.fn();
const getEntryGates = vi.fn();
const setEntryGate = vi.fn();
const getEntryAlerts = vi.fn();
const getEntrySignals = vi.fn();
const setEntryAlert = vi.fn();
const sendEntryAlertTest = vi.fn();
vi.mock('@/api/entry', () => ({
  getEntryBoard: (...a: unknown[]) => getEntryBoard(...a),
  getEntryRecord: (...a: unknown[]) => getEntryRecord(...a),
  entrySignalsCsvUrl: () => '/api/entry/signals.csv',
  getEntryGates: (...a: unknown[]) => getEntryGates(...a),
  setEntryGate: (...a: unknown[]) => setEntryGate(...a),
  getEntryAlerts: (...a: unknown[]) => getEntryAlerts(...a),
  getEntrySignals: (...a: unknown[]) => getEntrySignals(...a),
  setEntryAlert: (...a: unknown[]) => setEntryAlert(...a),
  sendEntryAlertTest: (...a: unknown[]) => sendEntryAlertTest(...a),
}));
const ALERTS_OFF = { alerts: [{ mode: 'single', enabled: false, changedAt: null, tfs: ['5m'] }, { mode: 'mtf', enabled: false, changedAt: null, tfs: ['5m'] }], telegram: true, recent: [] };
const SETTINGS = [
  { key: 'data', label: 'Data fresh', enabled: true, locked: 'On stale candles nothing else means anything.', changedAt: null },
  { key: 'rr', label: 'R:R', enabled: true, locked: null, changedAt: null },
];
const getCandles = vi.fn(async (tf: string) => ({ tf, bars: [{ time: 1, open: 84_000, high: 84_200, low: 83_900, close: 84_120, volume: 1 }] }));
const getFlowBars = vi.fn(async (tf: string) => ({ tf, bars: [] }));
const getHeatmap = vi.fn(async (tf: string) => ({ tf, step: 10, columns: [], walls: [] }));
vi.mock('@/api/desk', () => ({
  getCandles: (tf: string) => getCandles(tf),
  getFlowBars: (tf: string) => getFlowBars(tf),
  getHeatmap: (tf: string) => getHeatmap(tf),
  getLargePrints: async () => ({ min: 200, since: 0, prints: [] }),
}));
const five = [{ time: 300, open: 84_000, high: 84_200, low: 83_900, close: 84_120, volume: 1 }];
const desk = { bars5m: five, ltp: null, strikes: null, derivs: null };

/**
 * The reference layout: the twelve methods without the timeframe chain and
 * with it, side by side. What it must never do: draw levels for anything but a
 * TRADE, call a quality score a confidence, show a TAKE TRADE button, or show a
 * record that is not the paper log's.
 */

const NAMES = ['Breakout', 'Breakout + retest', 'Liquidity sweep', 'FVG retest', 'Order-block retest', 'BOS', 'MSS / CHoCH', 'Momentum', 'Pullback', 'VWAP / mean reversion', 'Order flow', 'Options / derivatives'];

function read(n: number, mode: 'mtf' | 'single', over: Partial<MethodRead> = {}): MethodRead {
  return {
    id: `m${n}`, n, name: NAMES[n - 1]!, group: 'breakout', summary: `what ${NAMES[n - 1]} looks for`, mode, tf: '5m', dir: null, state: 'NO_TRADE',
    steps: [], gates: [], plan: null, score: null, scoreParts: [], alignment: null, reason: 'nothing forming', triggerTime: null, ...over,
  };
}

const gate = (key: string, label: string, value: string, ok: boolean | null, enabled = true) => ({ key, label, rule: `${label} rule`, value, ok, why: ok === false ? `${label} refused` : null, enabled });
const PASSING = [
  gate('data', 'Data fresh', '0.4 min old', true), gate('spread', 'Spread', '0.001%', true), gate('stop', 'Stop band', '1.10 ATR', true),
  gate('rr', 'R:R', '1.90', true), gate('htf', 'HTF alignment', '1H up · 4H up', true), gate('big-move', 'Big-move risk', 'normal', true),
  gate('em', 'Expected move', 'no option board', null), gate('settle', 'Settlement', 'no option board', null),
];

const TRADE = read(3, 'mtf', {
  gates: PASSING,
  state: 'TRADE', dir: 'long', score: 72, alignment: 100, reason: 'long -- Liquidity sweep with the timeframe chain', triggerTime: 1,
  plan: { entryLo: 84_120, entryHi: 84_160, stop: 83_980, tp1: 84_300, tp2: 84_500, tp3: null, tpWhy: ['5m swing high 84,300', 'ask wall 84,500'], rr: 1.9 },
  steps: [{ tf: '4h', label: 'macro context: with it', ok: true }, { tf: '5m', label: 'swept a swing low', ok: true }, { tf: '1m', label: 'execution: at the entry', ok: true }],
});
const WAITING = read(7, 'single', {
  gates: PASSING.map((g) => (g.key === 'rr' ? gate('rr', 'R:R', '1.20', false) : g.key === 'htf' ? gate('htf', 'HTF alignment', 'not part of this mode', null) : g)),
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
  charts.clear();
  localStorage.clear();
  getEntryBoard.mockResolvedValue(board());
  getEntryGates.mockResolvedValue({ gates: SETTINGS });
  getEntryAlerts.mockResolvedValue(ALERTS_OFF);
  getEntrySignals.mockResolvedValue({ signals: [], total: 0, summary: { trades: 0, tp1: 0, tp1Pts: 0, stops: 0, slPts: 0, timeouts: 0, netPts: 0, netR: 0, open: 0 } });
  getEntryRecord.mockResolvedValue({ records: [], totals: [total('mtf'), total('single', { trades: 0, setups: 3 })], recent: [] });
});

const panel = (name: RegExp) => screen.findByRole('region', { name });

describe('the entry section, side by side', () => {
  it('[critical] 24 setups: twelve without the timeframe chain, twelve with it', async () => {
    render(<EntrySection desk={desk} />);
    const without = await panel(/12 methods · without timeframe/);
    const withTf = screen.getByRole('region', { name: /12 methods \+ timeframe/ });
    expect(within(withTf).getByRole('table', { name: 'with timeframe methods' }).querySelectorAll('tbody tr')).toHaveLength(12);
    expect(within(without).getByRole('table', { name: 'without timeframe methods' }).querySelectorAll('tbody tr')).toHaveLength(12);
    expect(await screen.findByText(/1 trade · 1 wait · 22 no trade/)).toBeInTheDocument();
  });

  it('[critical] a TRADE: BUY, LONG SETUP with entry, stop, targets in R, risk and reward -- and no TAKE TRADE', async () => {
    render(<EntrySection desk={desk} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    const card = await within(withTf).findByRole('region', { name: 'selected setup' });
    expect(within(card).getByText('LONG SETUP')).toBeInTheDocument();
    expect(within(card).getByText('84,120 – 84,160')).toBeInTheDocument();
    // Measured from where a long fills, the top of the zone (84,160): risk 180, reward 140.
    expect(within(card).getByText('84,300 (0.8R)')).toBeInTheDocument();
    expect(within(card).getByText('180 (0.21%)')).toBeInTheDocument();
    expect(within(card).getByText('140 (0.17%)')).toBeInTheDocument();
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(within(card).getByText('72/100')).toBeInTheDocument();
    expect(within(card).getByText(/Paper-logged and graded on 1m candles · no order is placed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take trade/i })).toBeNull();
    expect(screen.queryByText(/confidence/i)).toBeNull();
    expect(within(withTf).getAllByText('BUY').length).toBe(1);
  });

  it('[critical] each panel has the desk\'s price chart, drawing that panel\'s TRADE; Setups off draws none', async () => {
    render(<EntrySection desk={desk} />);
    await waitFor(() => expect(drawnOn('12 methods + timeframe chart')).toBe('#3 Liquidity sweep (with TF)'));
    const drawn = charts.get('12 methods + timeframe chart')!;
    expect(drawn).toMatchObject({ tf: '5m', size: 'panel', entry: { dir: 'long', entryLo: 84_120, tp1: 84_300 } });
    // The 5m chart is the desk's own live candles, not a second poll.
    expect(drawn.bars).toBe(five);
    // The other panel's choice is a WAIT: nothing to draw.
    expect(drawnOn('12 methods · without timeframe chart')).toBe('');
    fireEvent.click(screen.getByRole('switch', { name: /Setups on chart/ }));
    expect(drawnOn('12 methods + timeframe chart')).toBe('');
  });

  it('[critical] there is no other chart: the desk\'s main chart is gone, the two panels carry it', async () => {
    render(<EntrySection desk={desk} />);
    await panel(/12 methods \+ timeframe/);
    expect(screen.getAllByRole('img').map((c) => c.getAttribute('aria-label'))).toEqual(['12 methods · without timeframe chart', '12 methods + timeframe chart']);
  });

  it('with the chain, the chart looks at any of the chain\'s timeframes; the reads stay at 5m', async () => {
    render(<EntrySection desk={desk} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    fireEvent.click(within(within(withTf).getByRole('group', { name: 'chart timeframe' })).getByRole('button', { name: '1h' }));
    expect(screen.getByRole('img', { name: '12 methods + timeframe chart' }).getAttribute('data-tf')).toBe('1h');
    await waitFor(() => expect(getCandles).toHaveBeenCalledWith('1h'));
    expect(getEntryBoard).not.toHaveBeenCalledWith('1h');
    // The book and the flow are read for 1m and 5m only, and only while one is shown.
    expect(getHeatmap.mock.calls.map((c) => c[0])).not.toContain('1m');
  });

  it('[critical] a WAIT shows what it waits for and what was not read, and draws no levels', async () => {
    render(<EntrySection desk={desk} />);
    const without = await panel(/12 methods · without timeframe/);
    const card = await within(without).findByRole('region', { name: 'selected setup' });
    expect(within(card).getByText('WAIT · short forming')).toBeInTheDocument();
    expect(within(card).getByText('waiting for 5m: liquidity swept first')).toBeInTheDocument();
    expect(within(card).queryByText('Stop loss')).toBeNull();
    const reasons = within(without).getByRole('region', { name: 'key reasons' });
    expect(within(reasons).getByText('delta turned (not read)')).toBeInTheDocument();
    fireEvent.click(within(without).getByRole('button', { name: /MSS \/ CHoCH/ }));
    expect(drawnOn('12 methods · without timeframe chart')).toBe('');
  });

  it('the timeframe analysis is handed up for the card under the Big move catch, and is no longer in a panel', async () => {
    const onTimeframes = vi.fn();
    render(<EntrySection desk={desk} onTimeframes={onTimeframes} />);
    await panel(/12 methods \+ timeframe/);
    await waitFor(() => expect(onTimeframes).toHaveBeenCalledWith(board().timeframes));
    expect(screen.queryByLabelText('timeframe analysis')).toBeNull();
  });

  it('[critical] no paper-record strip and no with-vs-without comparison: removed at the owner\'s request', async () => {
    render(<EntrySection desk={desk} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    const without = await panel(/12 methods · without timeframe/);
    expect(within(withTf).queryByRole('region', { name: 'paper record' })).toBeNull();
    expect(within(without).queryByRole('region', { name: 'paper record' })).toBeNull();
    expect(screen.queryByText(/Paper record · all 12/)).toBeNull();
    expect(screen.queryByText(/taken with a gate off/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'with and without timeframe compared' })).toBeNull();
  });

  it('the timeframe without the chain is asked for from the server', async () => {
    render(<EntrySection desk={desk} />);
    await panel(/12 methods · without timeframe/);
    fireEvent.click(within(screen.getByRole('group', { name: 'timeframe without the chain' })).getByRole('button', { name: '15m' }));
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('img', { name: '12 methods · without timeframe chart' }).getAttribute('data-tf')).toBe('15m');
    await waitFor(() => expect(getEntryBoard).toHaveBeenLastCalledWith('15m'));
  });

  it('[critical] 1m without the chain is chart-only: the chart shows, no methods table, no 1m alert or history chip', async () => {
    render(<EntrySection desk={desk} />);
    const without = await panel(/12 methods · without timeframe/);
    fireEvent.click(within(within(without).getByRole('group', { name: 'timeframe without the chain' })).getByRole('button', { name: '1m' }));
    expect(screen.getByRole('img', { name: '12 methods · without timeframe chart' }).getAttribute('data-tf')).toBe('1m');
    expect(within(without).getByRole('note', { name: 'view only' })).toHaveTextContent('1m is chart-only. No signals, no Telegram alerts');
    expect(within(without).queryByRole('table', { name: 'without timeframe methods' })).toBeNull();
    // The other panel is untouched: the chain reads on as ever.
    expect(within(await panel(/12 methods \+ timeframe/)).getByRole('table')).toBeInTheDocument();
    const chips = within(without).queryByRole('group', { name: 'alert timeframes' });
    if (chips) expect(within(chips).queryByRole('button', { name: '1m' })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'history timeframe' })).queryByRole('button', { name: '1m' })).toBeNull();
  });

  it('12 charts: one mode at a time', async () => {
    render(<EntrySection desk={desk} />);
    await panel(/12 methods \+ timeframe/);
    fireEvent.click(screen.getByRole('button', { name: '12 charts' }));
    expect(screen.getAllByRole('figure')).toHaveLength(12);
    // Small price charts, each drawing its own method's TRADE.
    expect(screen.getAllByRole('img').every((c) => c.getAttribute('data-size') === 'compact')).toBe(true);
    expect(drawnOn('Liquidity sweep price chart')).toBe('#3 Liquidity sweep (with TF)');
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

describe('the method table: names once, numbers on both sides', () => {
  it('[critical] the twelve names are written once, by number; the two panels show the number only', async () => {
    render(<EntrySection desk={desk} />);
    const legend = await screen.findByRole('table', { name: 'entry methods by number' });
    const rows = within(legend).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(within(r).getAllByRole('cell')[1]!).getByRole('button').textContent)).toEqual(NAMES);
    // Twice: under the name on a phone, in its own column on a wider screen (CSS shows one).
    expect(within(rows[2]!).getAllByText('what Liquidity sweep looks for')).toHaveLength(2);
    expect(within(rows[2]!).getAllByText(/BUY|SELL|WAIT|NO/).map((c) => c.textContent)).toEqual(['NO', 'BUY']); // without, then with
    const withTf = screen.getByRole('table', { name: 'with timeframe methods' });
    const firstCell = withTf.querySelector('tbody tr td')!;
    expect(firstCell.textContent).toBe('1');
    expect(within(withTf).queryByText('Breakout')).toBeNull();
    expect(within(withTf).getByRole('button', { name: '3 Liquidity sweep' })).toBeInTheDocument();
  });

  it('choosing a method by name chooses it on both sides', async () => {
    render(<EntrySection desk={desk} />);
    const legend = await screen.findByRole('table', { name: 'entry methods by number' });
    fireEvent.click(within(legend).getByRole('button', { name: 'Momentum' }));
    for (const name of [/12 methods · without timeframe/, /12 methods \+ timeframe/]) {
      const card = within(screen.getByRole('region', { name })).getByRole('region', { name: 'selected setup' });
      expect(within(card).getByText('#8 Momentum')).toBeInTheDocument();
    }
  });
});

describe('the hard gates', () => {
  it('[critical] the methods table has a gates column for each way: "✓ 6/6" when none refuses, the refusing gate when one does', async () => {
    render(<EntrySection desk={desk} />);
    const legend = await screen.findByRole('table', { name: 'entry methods by number' });
    expect(within(legend).getByRole('columnheader', { name: 'Gates · without' })).toBeInTheDocument();
    expect(within(legend).getByRole('columnheader', { name: 'Gates · with' })).toBeInTheDocument();
    expect(within(legend).getByLabelText('Liquidity sweep gates with timeframe')).toHaveTextContent('✓ 6/6');
    expect(within(legend).getByLabelText('MSS / CHoCH gates without timeframe')).toHaveTextContent('✗ R:R');
    expect(within(legend).getByLabelText('Breakout gates with timeframe')).toHaveTextContent('–');
  });

  it('[critical] beside the methods table, one checklist: every gate\'s rule, what was read, ✓ / ✗ / – (not read, never "passed"), either way', async () => {
    render(<EntrySection desk={desk} />);
    const list = await screen.findByRole('region', { name: 'hard gates' });
    expect(screen.getAllByRole('region', { name: 'hard gates' })).toHaveLength(1);
    // With the chain by default: #3 Liquidity sweep, the TRADE.
    await waitFor(() => expect(list).toHaveTextContent('#3 Liquidity sweep'));
    const rows = within(list).getAllByRole('row');
    expect(rows).toHaveLength(8);
    expect(within(rows[3]!).getByText('R:R')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('1.90')).toBeInTheDocument();
    expect(within(rows[3]!).getByLabelText('passed')).toHaveTextContent('✓');
    expect(within(rows[6]!).getByLabelText('not read')).toHaveTextContent('–');
    // Switched to without the chain: #7 MSS, refused on R:R.
    fireEvent.click(within(list).getByRole('button', { name: 'Without TF' }));
    expect(list).toHaveTextContent('#7 MSS / CHoCH');
    const refused = within(list).getAllByLabelText('refused');
    expect(refused.map((c) => c.closest('tr')!.textContent)).toEqual([expect.stringContaining('R:R')]);
  });

  it('with nothing forming there is nothing to check, and it says so', async () => {
    render(<EntrySection desk={desk} />);
    await panel(/12 methods \+ timeframe/);
    fireEvent.click(within(screen.getByRole('table', { name: 'entry methods by number' })).getByRole('button', { name: 'Breakout' }));
    expect(within(screen.getByRole('region', { name: 'hard gates' })).getByText(/Read once a setup forms/)).toBeInTheDocument();
  });
});

describe('switching gates on and off', () => {
  it('[critical] the switches: Data fresh locked on, a gate turned off is saved on the server and the board read again', async () => {
    setEntryGate.mockResolvedValue({ gates: [SETTINGS[0], { ...SETTINGS[1], enabled: false, changedAt: Date.UTC(2026, 8, 30, 13, 0) }] });
    render(<EntrySection desk={desk} />);
    const button = await screen.findByRole('button', { name: 'hard gate switches' });
    await waitFor(() => expect(button).toHaveTextContent('Hard gates · all on'));
    fireEvent.click(button);
    expect(await screen.findByLabelText('locked on')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Data fresh/ })).toBeNull();
    const reads = getEntryBoard.mock.calls.length;
    fireEvent.click(screen.getByRole('switch', { name: /^R:R/ }));
    await waitFor(() => expect(setEntryGate).toHaveBeenCalledWith('rr', false));
    await waitFor(() => expect(screen.getByRole('button', { name: 'hard gate switches' })).toHaveTextContent('1 off'));
    await waitFor(() => expect(getEntryBoard.mock.calls.length).toBeGreaterThan(reads));
  });

  it('[critical] a gate that is off is marked off in the checklist -- "would refuse" -- and refuses nothing in the chip', async () => {
    const offRead = { ...TRADE, gates: PASSING.map((g) => (g.key === 'rr' ? gate('rr', 'R:R', '1.20', false, false) : g)) };
    getEntryBoard.mockResolvedValue({ ...board(), reads: board().reads.map((r) => (r === TRADE ? offRead : r)) });
    render(<EntrySection desk={desk} />);
    const list = await screen.findByRole('region', { name: 'hard gates' });
    await waitFor(() => expect(within(list).getByLabelText('off, would refuse')).toBeInTheDocument());
    expect(within(list).getByText('would refuse')).toBeInTheDocument();
    const legend = screen.getByRole('table', { name: 'entry methods by number' });
    expect(within(legend).getByLabelText('Liquidity sweep gates with timeframe')).toHaveTextContent('✓ 5/5');
  });

});

describe('auto-select and Telegram', () => {
  const rowOf = (panelName: RegExp, n: number) => {
    const p = screen.getByRole('region', { name: panelName });
    return within(p).getByRole('button', { name: new RegExp(`^${n} `) }).closest('tr')!;
  };

  it('[critical] a signal chooses itself: the TRADE row is selected, highlighted, and marked AUTO', async () => {
    render(<EntrySection desk={desk} />);
    await panel(/12 methods \+ timeframe/);
    await waitFor(() => expect(rowOf(/12 methods \+ timeframe/, 3)).toHaveAttribute('aria-selected', 'true'));
    expect(within(rowOf(/12 methods \+ timeframe/, 3)).getByText('AUTO')).toBeInTheDocument();
  });

  it('[critical] a row picked by hand stays picked: the same signal does not pull the panel back', async () => {
    render(<EntrySection desk={desk} />);
    await panel(/12 methods \+ timeframe/);
    await waitFor(() => expect(within(rowOf(/12 methods \+ timeframe/, 3)).getByText('AUTO')).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole('region', { name: /12 methods \+ timeframe/ })).getByRole('button', { name: '8 Momentum' }));
    expect(rowOf(/12 methods \+ timeframe/, 8)).toHaveAttribute('aria-selected', 'true');
    expect(within(rowOf(/12 methods \+ timeframe/, 3)).queryByText('AUTO')).toBeNull();
  });

  it('with auto-select off, a signal does not take over a choice made by hand', async () => {
    localStorage.setItem('btc-desk:entry:auto-select', 'false');
    localStorage.setItem('btc-desk:entry:chosen-2', JSON.stringify({ single: null, mtf: 'mtf:m8' }));
    render(<EntrySection desk={desk} />);
    await panel(/12 methods \+ timeframe/);
    await waitFor(() => expect(rowOf(/12 methods \+ timeframe/, 8)).toHaveAttribute('aria-selected', 'true'));
    expect(screen.queryByText('AUTO')).toBeNull();
    expect(screen.getByRole('switch', { name: /Auto-select signals/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('[critical] each section has its own Telegram switch: off until turned on, saved on the server', async () => {
    setEntryAlert.mockResolvedValue({ ...ALERTS_OFF, alerts: [ALERTS_OFF.alerts[0], { mode: 'mtf', enabled: true, changedAt: 1, tfs: ['5m'] }] });
    render(<EntrySection desk={desk} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    const sw = await within(withTf).findByRole('switch', { name: 'Telegram alerts with timeframe' });
    await waitFor(() => expect(sw).toHaveTextContent('Telegram off'));
    expect(within(screen.getByRole('region', { name: /12 methods · without timeframe/ })).getByRole('switch', { name: 'Telegram alerts without timeframe' })).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(setEntryAlert).toHaveBeenCalledWith('mtf', true));
    await waitFor(() => expect(within(withTf).getByRole('switch', { name: 'Telegram alerts with timeframe' })).toHaveTextContent('Telegram on'));
    sendEntryAlertTest.mockResolvedValue({ ok: true });
    fireEvent.click(within(withTf).getByRole('button', { name: 'test' }));
    await waitFor(() => expect(within(withTf).getByRole('status')).toHaveTextContent('test sent'));
  });

  it('when Telegram is not set up on the server, the switch says so', async () => {
    getEntryAlerts.mockResolvedValue({ ...ALERTS_OFF, telegram: false });
    render(<EntrySection desk={desk} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    await waitFor(() => expect(within(withTf).getByText('not set up')).toBeInTheDocument());
  });
});

describe('a TRADE that stands only because a gate is off', () => {
  it('[critical] says so on the card, with the refusing values: with every gate on it is NO TRADE', async () => {
    const offRead = { ...TRADE, gates: PASSING.map((g) => (g.key === 'rr' ? gate('rr', 'R:R', '0.16', false, false) : g)) };
    getEntryBoard.mockResolvedValue({ ...board(), reads: board().reads.map((r) => (r === TRADE ? offRead : r)) });
    render(<EntrySection desk={desk} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    const card = await within(withTf).findByRole('region', { name: 'selected setup' });
    await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent('Only a TRADE because R:R is switched off'));
    expect(within(card).getByRole('alert')).toHaveTextContent('R:R 0.16');
  });
});

describe('the live price on the card', () => {
  it('[critical] a TRADE\'s card follows the stream\'s last trade: LTP, where it is against the zone, points to entry, SL, TP1', async () => {
    render(<EntrySection desk={{ ...desk, ltp: { price: 84_140, at: Date.now(), side: 'buy', bars: { '1m': null, '5m': null } } }} />);
    const withTf = await panel(/12 methods \+ timeframe/);
    const strip = await within(withTf).findByLabelText('live price');
    expect(strip).toHaveTextContent('LTP 84,140');
    expect(strip).toHaveTextContent('IN THE ENTRY ZONE');
    expect(strip).toHaveTextContent('to SL 160 pts');
  });

  it('a WAIT has no levels, so no live strip', async () => {
    render(<EntrySection desk={desk} />);
    const without = await panel(/12 methods · without timeframe/);
    await within(without).findByRole('region', { name: 'selected setup' });
    expect(within(without).queryByLabelText('live price')).toBeNull();
  });
});

describe('which timeframes alert, and the last alert', () => {
  it('[critical] without the chain, the owner picks the timeframes that reach the phone; the pick is saved on the server', async () => {
    getEntryAlerts.mockResolvedValue({ ...ALERTS_OFF, alerts: [{ mode: 'single', enabled: true, changedAt: 1, tfs: ['5m'] }, ALERTS_OFF.alerts[1]] });
    setEntryAlert.mockResolvedValue({ ...ALERTS_OFF, alerts: [{ mode: 'single', enabled: true, changedAt: 2, tfs: ['3m', '5m'] }, ALERTS_OFF.alerts[1]] });
    render(<EntrySection desk={desk} />);
    const without = await panel(/12 methods · without timeframe/);
    const chips = await within(without).findByRole('group', { name: 'alert timeframes' });
    expect(within(chips).getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(chips).getByRole('button', { name: '3m' }));
    await waitFor(() => expect(setEntryAlert).toHaveBeenCalledWith('single', true, ['3m', '5m']));
    await waitFor(() => expect(within(within(without).getByRole('group', { name: 'alert timeframes' })).getByRole('button', { name: '3m' })).toHaveAttribute('aria-pressed', 'true'));
    // With the chain there is no pick: its entry is 5m.
    expect(within(screen.getByRole('region', { name: /12 methods \+ timeframe/ })).queryByRole('group', { name: 'alert timeframes' })).toBeNull();
  });

  it('[critical] the last alert each way tried to send, from the server log: sent ✓, or failed ✗ and why', async () => {
    getEntryAlerts.mockResolvedValue({
      ...ALERTS_OFF,
      alerts: [{ mode: 'single', enabled: true, changedAt: 1, tfs: ['5m'] }, { mode: 'mtf', enabled: true, changedAt: 1, tfs: ['5m'] }],
      recent: [
        { at: Date.UTC(2026, 8, 30, 14, 30), mode: 'single', tf: '5m', method: 'breakout-retest', n: 2, name: 'Breakout + retest', dir: -1, status: 'sent', error: null },
        { at: Date.UTC(2026, 8, 30, 14, 0), mode: 'mtf', tf: '5m', method: 'bos', n: 6, name: 'BOS', dir: 1, status: 'failed', error: 'Telegram did not accept it' },
      ],
    });
    render(<EntrySection desk={desk} />);
    const without = await panel(/12 methods · without timeframe/);
    await waitFor(() => expect(within(without).getByLabelText('last alert')).toHaveTextContent('last: 20:00 · #2 SELL 5m · sent ✓'));
    const withTf = screen.getByRole('region', { name: /12 methods \+ timeframe/ });
    expect(within(withTf).getByLabelText('last alert')).toHaveTextContent('#6 BUY 5m · failed ✗ -- Telegram did not accept it');
  });
});

