import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalStrategyForm } from '@/components/strategy/SignalStrategyForm';
import { StrategyForm } from '@/components/strategy/StrategyForm';
import { combineRows, matchingSignals, profitableIds } from '@/components/strategy/SignalRuleEditor';
import { DEFAULT_CONFIG, DEFAULT_SIGNAL_RULE, type SignalRule, type Strategy } from '@/types/strategy';
import type { MethodRead, MethodReportRow } from '@/types/entry';

const saveStrategy = vi.fn();
vi.mock('@/api/strategy', () => ({
  saveStrategy: (...a: unknown[]) => saveStrategy(...a),
}));
const getEntryMethods = vi.fn();
const getMethodReport = vi.fn();
const getEntryBoard = vi.fn();
vi.mock('@/api/entry', () => ({
  getEntryMethods: (...a: unknown[]) => getEntryMethods(...a),
  getMethodReport: (...a: unknown[]) => getMethodReport(...a),
  getEntryBoard: (...a: unknown[]) => getEntryBoard(...a),
}));

/**
 * A signal strategy on the form (2 Oct 2026): the desk's entry signals sold as
 * options -- BUY sells the put, SELL the call -- with the methods picked from
 * the 81 against their record, the SL and TGT the signal's own on the BTC perp,
 * one lot by default, and live orders off until switched on.
 */

const METHODS = [
  { id: 'breakout', n: 1, name: 'Breakout', group: 'breakout', summary: 'A close through the 20-bar range', sl: 'the breakout candle' },
  { id: 'liquidity-sweep', n: 3, name: 'Liquidity sweep', group: 'reversal', summary: 'Stops taken past a swing', sl: 'the sweep extreme' },
  { id: 'bos', n: 6, name: 'BOS', group: 'breakout', summary: 'A displacement close through a swing', sl: 'the last higher low' },
  { id: 'order-flow', n: 11, name: 'Order flow', group: 'flow', summary: 'Absorption at a level', sl: 'the absorption extreme' },
];
const row = (method: string, trades: number, wins: number, netPts: number): MethodReportRow => ({
  n: null, method, name: method, signals: trades, trades, wins, losses: trades - wins,
  winPct: trades ? Math.round((wins / trades) * 100) : null, profitPts: Math.max(netPts, 0), lossPts: Math.max(-netPts, 0), netPts,
  profitR: 0, lossR: 0, netR: 0,
});
const section = (mode: 'mtf' | 'single', rows: MethodReportRow[]) => ({
  mode, label: mode, rows, total: row('total', 0, 0, 0), gatesOffSignals: 0,
});
const REPORT = {
  tf: null,
  sections: [
    section('mtf', [row('breakout', 12, 8, 900), row('liquidity-sweep', 3, 3, 400), row('bos', 9, 2, -500)]),
    section('single', []),
  ],
  singleByTf: { '15m': section('single', [row('bos', 6, 4, 300), row('order-flow', 7, 5, 250)]) },
};
const read = (o: Partial<MethodRead>): MethodRead => ({
  id: 'breakout', n: 1, code: '1', name: 'Breakout', group: 'breakout', summary: '', mode: 'mtf', tf: '5m',
  dir: 'long', state: 'TRADE', steps: [], gates: [], score: 70, scoreParts: [], alignment: null,
  plan: { entryLo: 84_950, entryHi: 85_000, stop: 84_600, tp1: 85_500, tp2: 85_900, tp3: null, tpWhy: [], rr: 1.25 },
  ...o,
} as MethodRead);
const BOARD = {
  at: 0, tf: '5m', chain: [], timeframes: [], ltp: { price: 85_010, at: 0 },
  reads: [
    read({}),
    read({ id: 'bos', n: 6, name: 'BOS', dir: 'short', plan: { entryLo: 85_000, entryHi: 85_050, stop: 85_400, tp1: 84_500, tp2: null, tp3: null, tpWhy: [], rr: 1.2 } }),
    read({ id: 'liquidity-sweep', n: 3, state: 'WAIT', plan: null }),
    read({ id: 'breakout', mode: 'single', tf: '5m' }),
  ],
};

const strategy = (over: Partial<Strategy['config']> = {}, name = 'Sig'): Strategy => ({
  id: 'sig', name, enabled: false, createdAt: 0, updatedAt: 0,
  lastRunDate: null, ranToday: false, nextEntryAt: null, status: 'off',
  config: { ...DEFAULT_CONFIG, ...over },
});
const signalStrategy = (rule: Partial<SignalRule> = {}, over: Partial<Strategy['config']> = {}) =>
  strategy({ trigger: 'signal', signal: { ...DEFAULT_SIGNAL_RULE, methods: ['breakout'], ...rule }, liveOrders: false, lots: 1, ...over });

const show = (s: Strategy | null) =>
  render(<SignalStrategyForm editing={s} open onOpenChange={() => {}} onSaved={() => {}} balanceUsd={228} spot={85_000} />);
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));
const radio = (group: string, name: string | RegExp) =>
  fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name }));
const saveButton = () => screen.getByRole('button', { name: /^(Save|Fix \d+ to save)$/ });
const saved = () => saveStrategy.mock.calls.at(-1)![0] as { name: string; config: Strategy['config'] };

beforeEach(() => {
  vi.clearAllMocks();
  saveStrategy.mockResolvedValue({ ok: true });
  getEntryMethods.mockResolvedValue({ methods: METHODS });
  getMethodReport.mockResolvedValue(REPORT);
  getEntryBoard.mockResolvedValue(BOARD);
});

describe('a form of its own: only what a signal strategy has', () => {
  it('[critical] a new one opens on Signals: four tabs, one lot, live orders off -- nothing a clock strategy has', () => {
    show(null);
    expect(screen.getByRole('dialog', { name: 'New signal strategy' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Signals', 'Strike & lots', 'Entry & exit', 'When']);
    expect(screen.getByRole('tab', { name: /^Signals/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('switch', { name: /Live orders/ })).toHaveAttribute('aria-checked', 'false');
    // none of the clock strategy's settings
    expect(screen.queryByRole('radiogroup', { name: 'trigger' })).toBeNull();
    tab('Strike & lots');
    expect(screen.getByLabelText('lots')).toHaveValue('1');
    expect(screen.queryByRole('radiogroup', { name: 'legs' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'By open interest' })).toBeNull();
    tab('Entry & exit');
    expect(screen.queryByRole('radio', { name: 'My price' })).toBeNull();
    tab('When');
    expect(screen.getByRole('button', { name: /^Take signals from:/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('late entry window')).toBeNull();
    expect(screen.queryByText('Trade monitoring')).toBeNull();
  });

  it('[critical] the leg is the signal\'s: BUY sells the PE, SELL the CE -- and the strike by premium or by strike', () => {
    show(signalStrategy());
    tab('Strike & lots');
    const legs = screen.getByLabelText('leg from the signal');
    expect(legs).toHaveTextContent(/BUY signal → sells PE/);
    expect(legs).toHaveTextContent(/SELL signal → sells CE/);
    expect(screen.getByRole('radio', { name: 'At least' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'At most' })).toBeInTheDocument();
    radio('strike rule', 'By strike');
    fireEvent.click(screen.getByRole('button', { name: 'one strike further out' }));
    expect(screen.getByRole('status', { name: 'which strike' })).toHaveTextContent('OTM 1');
    expect(screen.getByLabelText('lots')).toHaveValue('1');
    expect(screen.getByText('Lots per signal')).toBeInTheDocument();
  });

  it('the clock strategy\'s form has none of it: no signals, no live-orders switch', () => {
    render(<StrategyForm editing={null} open onOpenChange={() => {}} onSaved={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['When', 'Sell', 'Entry & exit']);
    expect(screen.queryByRole('radiogroup', { name: 'trigger' })).toBeNull();
    expect(screen.queryByRole('switch', { name: /Live orders/ })).toBeNull();
  });
});

describe('picking the methods', () => {
  it('[critical] the 81 come from the server, each with its record in the chosen way', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    const list = await screen.findByRole('list', { name: 'methods' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(4);
    await waitFor(() => expect(within(list).getByText(/67% · 12t ·/)).toBeInTheDocument());
    expect(within(list).getByText('+900 pts')).toBeInTheDocument();
    expect(screen.getByText(/0 of 4 picked/)).toBeInTheDocument();
    expect(getMethodReport).toHaveBeenCalledWith(null);
  });

  it('search by name or number, and by family', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    await screen.findByRole('checkbox', { name: '#1 Breakout' });
    fireEvent.change(screen.getByLabelText('search methods'), { target: { value: 'sweep' } });
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#3 Liquidity sweep']);
    fireEvent.change(screen.getByLabelText('search methods'), { target: { value: '11' } });
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#11 Order flow']);
    fireEvent.change(screen.getByLabelText('search methods'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Breakout', pressed: false }));
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#1 Breakout', '#6 BOS']);
    fireEvent.click(screen.getByRole('button', { name: /Pick all shown \(2\)/ }));
    expect(screen.getByText(/2 of 4 picked/)).toBeInTheDocument();
  });

  it('[critical] "profitable so far" picks only a positive net over at least 5 trades', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    const pick = await screen.findByRole('button', { name: /Pick profitable so far \(1\)/ });
    fireEvent.click(pick);
    // breakout: 12 trades, +900. The sweep's +400 is 3 trades -- too few. BOS lost.
    expect(screen.getByRole('checkbox', { name: '#1 Breakout' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#3 Liquidity sweep' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#6 BOS' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText(/0 of 4 picked/)).toBeInTheDocument();
  });

  it('[critical] without the chain: several timeframes, the record added up over them, a board read for each', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    expect(screen.queryByRole('group', { name: 'signal timeframes' })).toBeNull();
    radio('signal way', 'Without the chain');
    const tfs = within(screen.getByRole('group', { name: 'signal timeframes' }));
    expect(tfs.getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tfs.getByRole('button', { name: '15m' }));
    fireEvent.click(tfs.getByRole('button', { name: '5m' }));
    fireEvent.click(tfs.getByRole('button', { name: '1h' }));
    expect(screen.getByText('Takes signals on 15m, 1h. The record beside each method is added up over these.')).toBeInTheDocument();
    await waitFor(() => expect(getEntryBoard).toHaveBeenCalledWith('1h'));
    expect(getEntryBoard).toHaveBeenCalledWith('15m');
    // 15m has BOS +300 over 6 and order flow +250 over 7; 1h has nothing
    await waitFor(() => expect(screen.getByRole('button', { name: /Pick profitable so far \(2\)/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'No timeframes' }));
    expect(screen.getByText('Pick at least one timeframe.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All timeframes' }));
    expect(tfs.getAllByRole('button', { pressed: true })).toHaveLength(6);
  });

  it('the win rate is a whole number, added up from the sums', () => {
    const rows = combineRows([{ rows: [row('a', 3, 1, 10)] }, { rows: [row('a', 6, 3, -4), row('b', 1, 1, 2)] }]);
    expect(rows.find((r) => r.method === 'a')).toMatchObject({ trades: 9, wins: 4, netPts: 6 });
    expect(rows.find((r) => r.method === 'a')!.winPct).toBeCloseTo(44.44, 1);
  });

  it('[critical] the record shows a whole-number win rate, never 33.333…%', async () => {
    getMethodReport.mockResolvedValue({ ...REPORT, sections: [section('mtf', [{ ...row('breakout', 15, 5, -379), winPct: 33.333333333333336 }]), section('single', [])] });
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    expect(await screen.findByText(/33% · 15t ·/)).toBeInTheDocument();
  });
});

describe('the SL and TGT on the BTC perp, from the live signal', () => {
  it('[critical] the picked methods\' TRADE signals standing now, read as the order each would be', async () => {
    show(signalStrategy({ methods: ['breakout', 'bos', 'liquidity-sweep'] }));
    tab('Signals');
    const box = screen.getByLabelText('live signals');
    await waitFor(() => expect(within(box).getAllByRole('listitem')).toHaveLength(2));
    const [buy, sell] = within(box).getAllByRole('listitem');
    expect(buy).toHaveTextContent('#1 Breakout BUY → sells PE · perp SL 84,600 · TGT1 85,500 · TGT2 85,900');
    expect(sell).toHaveTextContent('#6 BOS SELL → sells CE · perp SL 85,400 · TGT1 84,500');
    expect(box).toHaveTextContent('BTC perp 85,010');
  });

  it('target and how many at once are chosen on Entry & exit; the option exits are the backstop', () => {
    show(signalStrategy());
    tab('Entry & exit');
    expect(screen.getByText(/Still unfilled 5 minutes\s+later, it is cancelled/)).toBeInTheDocument();
    expect(screen.getByLabelText('exits on the BTC perp')).toHaveTextContent(/the signal's own levels on the BTC perpetual/);
    expect(screen.getByText(/Backstop on the option at Delta/)).toBeInTheDocument();
    // the entry is still priced the same way: at the offer, at the bid after 5 s
    expect(screen.getByRole('radio', { name: 'Offer' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('cross after seconds')).toHaveValue('5');
    radio('signal target', 'TGT2');
    // typed, or a quick pick
    fireEvent.change(screen.getByLabelText('max open'), { target: { value: '7' } });
    expect(screen.getByLabelText('max open')).toHaveValue('7');
    fireEvent.click(screen.getByRole('button', { name: '25' }));
    expect(screen.getByRole('button', { name: '25' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(saveButton());
    expect(saved().config.signal).toMatchObject({ target: 'tp2', maxOpen: 25 });
  });

  it('[critical] at most open: 0 or 101 is refused in words', () => {
    show(signalStrategy());
    tab('Entry & exit');
    fireEvent.change(screen.getByLabelText('max open'), { target: { value: '101' } });
    expect(screen.getByText('At most 1 to 100 of its trades open at once.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('max open'), { target: { value: '0' } });
    expect(screen.getByText('At most 1 to 100 of its trades open at once.')).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('[critical] no method picked: said under the field, the Signals tab marked, nothing sent', async () => {
    show(signalStrategy({ methods: [] }));
    expect(screen.getByRole('tab', { name: /^Signals/ })).toContainElement(screen.getByLabelText('has a problem'));
    expect(saveButton()).toHaveTextContent('Fix 1 to save');
    fireEvent.click(saveButton());
    expect(saveStrategy).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /^Signals/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one method whose signals to take.');
  });

  it('[critical] what is sent: the trigger, the whole rule, and live orders off', async () => {
    show(signalStrategy({ mode: 'single', tf: '15m', tfs: ['15m', '4h'], methods: ['bos'] }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalledTimes(1));
    expect(saved().config).toMatchObject({
      trigger: 'signal', liveOrders: false, lots: 1,
      signal: { mode: 'single', tf: '15m', tfs: ['15m', '4h'], methods: ['bos'], target: 'tp1', maxOpen: 1 },
    });
  });

  it('[critical] live orders: off says nothing is sent; on says real orders, and is saved on', async () => {
    show(signalStrategy());
    const sw = screen.getByRole('switch', { name: /Live orders/ });
    expect(screen.getByText(/Nothing is sent/)).toBeInTheDocument();
    fireEvent.click(sw);
    expect(screen.getByText(/each signal places a real order at Delta/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.liveOrders).toBe(true);
  });

  it('the rule read back as a sentence says what it does', () => {
    show(signalStrategy({ methods: ['breakout', 'bos'] }));
    expect(screen.getByText(/takes the TRADE signals of 2 methods with the timeframe chain: a BUY sells a put, a SELL a call/)).toBeInTheDocument();
    expect(screen.getByText(/Live orders off/)).toBeInTheDocument();
  });
});

describe('the helpers', () => {
  const rule: SignalRule = { mode: 'mtf', tf: '5m', methods: ['breakout', 'bos'], target: 'tp1', maxOpen: 1 };
  it('matchingSignals: its way, its timeframe without the chain, its methods, TRADE only', () => {
    expect(matchingSignals(BOARD.reads, rule).map((r) => r.id)).toEqual(['breakout', 'bos']);
    expect(matchingSignals(BOARD.reads, { ...rule, mode: 'single', tf: '5m' }).map((r) => `${r.id}|${r.mode}`)).toEqual(['breakout|single']);
    expect(matchingSignals(BOARD.reads, { ...rule, mode: 'single', tf: '15m' })).toEqual([]);
  });
  it('profitableIds: net above zero over at least five trades', () => {
    expect(profitableIds([row('a', 5, 3, 1), row('b', 4, 4, 100), row('c', 20, 5, -1), row('d', 6, 3, 0)])).toEqual(['a']);
  });
});

describe('when the option is sold', () => {
  it('[critical] "In the trade" (the perp at the entry zone) by default; "At the signal" by choice -- and saved', async () => {
    show(null);
    tab('Entry & exit');
    expect(screen.getByRole('radio', { name: 'In the trade' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/the fill the signal history counts/)).toBeInTheDocument();
    expect(screen.getByText(/within a second of the perp reaching the zone/)).toBeInTheDocument();
    radio('enter on', 'At the signal');
    expect(screen.getByText(/within a second of the candle that makes the signal/)).toBeInTheDocument();
  });

  it('a saved strategy enters in the trade unless it said otherwise', async () => {
    show(signalStrategy({ mode: 'mtf' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.signal!.enterOn).toBe('zone');
    expect(screen.getByText(/When the BTC perp trades into the signal's entry zone it rests at the offer/)).toBeInTheDocument();
  });
});
