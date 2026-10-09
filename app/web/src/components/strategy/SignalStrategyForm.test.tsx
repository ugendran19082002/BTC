import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalStrategyForm } from '@/components/strategy/SignalStrategyForm';
import { copySources } from '@/components/strategy/SignalRuleEditor';
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

// The order sides are this file's own, so the Buy / Sell filter has both to show.
const METHODS = [
  { id: 'breakout', n: 1, name: 'Breakout', group: 'breakout', orderSide: 'BUY', summary: 'A close through the 20-bar range', sl: 'the breakout candle' },
  { id: 'liquidity-sweep', n: 3, name: 'Liquidity sweep', group: 'reversal', orderSide: 'SELL', summary: 'Stops taken past a swing', sl: 'the sweep extreme' },
  { id: 'bos', n: 6, name: 'BOS', group: 'breakout', orderSide: 'SELL', summary: 'A displacement close through a swing', sl: 'the last higher low' },
  { id: 'order-flow', n: 11, name: 'Order flow', group: 'flow', orderSide: 'BUY', summary: 'Absorption at a level', sl: 'the absorption extreme' },
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
    expect(screen.getByRole('radio', { name: '≥ Greater or equal' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '≤ Less or equal' })).toBeInTheDocument();
    radio('strike rule', 'By strike');
    fireEvent.click(screen.getByRole('button', { name: 'one strike further out' }));
    expect(screen.getByRole('status', { name: 'which strike' })).toHaveTextContent('OTM 1');
    expect(screen.getByLabelText('lots')).toHaveValue('1');
    expect(screen.getByText('Lots per signal')).toBeInTheDocument();
  });

});

describe('picking the methods', () => {
  it('[critical] the 81 come from the server, each with its record in the chosen way', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    const list = await screen.findByRole('list', { name: 'methods' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(4);
    await waitFor(() => expect(list).toHaveTextContent(/67% win · 12t · \+900 pts/));
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
    const pick = await screen.findByRole('button', { name: /Pick profitable with the chain \(1\)/ });
    fireEvent.click(pick);
    // breakout: 12 trades, +900. The sweep's +400 is 3 trades -- too few. BOS lost.
    expect(screen.getByRole('checkbox', { name: '#1 Breakout' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#3 Liquidity sweep' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#6 BOS' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText(/0 of 4 picked/)).toBeInTheDocument();
  });

  it('[critical] copy the methods of another strategy of the account: they replace the pick, are saved, and can be undone (9 Oct 2026)', async () => {
    const other = { ...signalStrategy({ methods: ['bos', 'order-flow', 'retired-method'], mode: 'single', tf: '15m', tfs: ['15m', '1h'] }), id: 'o1', name: '1h time', enabled: true };
    const third = { ...signalStrategy({ methods: ['liquidity-sweep'] }), id: 'o2', name: 'Asleep' };
    render(<SignalStrategyForm editing={signalStrategy({ methods: ['breakout'] })} open onOpenChange={() => {}} onSaved={() => {}}
                               balanceUsd={228} spot={85_000} copyFrom={copySources([third, other, signalStrategy()], 'sig')} />);
    tab('Signals');
    await screen.findByRole('checkbox', { name: '#1 Breakout' });
    const pickFrom = screen.getByRole('combobox', { name: 'copy methods from a strategy' });
    // By name, the strategy being edited left out, each with what its pick is.
    expect(within(pickFrom).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Copy methods from a strategy…', 'Asleep — 1 method · with the chain · off', '1h time — 3 methods · 15m + 1h',
    ]);
    fireEvent.change(pickFrom, { target: { value: 'o1' } });
    // The retired id is not carried: the save would refuse it.
    expect(screen.getByRole('checkbox', { name: '#6 BOS' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#11 Order flow' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#1 Breakout' })).not.toBeChecked();
    expect(screen.getByText(/2 of 4 picked/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Took the 2 methods of 1h time, in place of the 1 picked before.');
    expect(pickFrom).toHaveValue('');
    // Only the methods: this strategy's way and timeframes stay its own.
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.signal!.methods).toEqual(['bos', 'order-flow']);
    expect(saved().config.signal!.mode).toBe('mtf');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('checkbox', { name: '#1 Breakout' })).toBeChecked();
    expect(screen.getByText(/1 of 4 picked/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a change made after a copy is the owner\'s own: the Undo goes, so it cannot throw that change away', async () => {
    const other = { ...signalStrategy({ methods: ['bos'] }), id: 'o1', name: 'Other' };
    render(<SignalStrategyForm editing={null} open onOpenChange={() => {}} onSaved={() => {}} balanceUsd={228} spot={85_000} copyFrom={[other]} />);
    tab('Signals');
    await screen.findByRole('checkbox', { name: '#1 Breakout' });
    fireEvent.change(screen.getByRole('combobox', { name: 'copy methods from a strategy' }), { target: { value: 'o1' } });
    expect(screen.getByRole('status')).toHaveTextContent('Took the 1 method of Other.');
    fireEvent.click(screen.getByRole('checkbox', { name: '#1 Breakout' }));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('no other strategy with methods: no copy list', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    await screen.findByRole('checkbox', { name: '#1 Breakout' });
    expect(screen.queryByRole('combobox', { name: 'copy methods from a strategy' })).not.toBeInTheDocument();
    expect(copySources([{ ...signalStrategy({ methods: [] }), id: 'x' }, strategy({}, 'Clock')], null)).toEqual([]);
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
    await waitFor(() => expect(screen.getByRole('button', { name: /Pick profitable on 15m \+ 1h \(2\)/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'No timeframes' }));
    expect(screen.getByText('Pick at least one timeframe.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All timeframes' }));
    // Seven since 2h joined (6 Oct 2026), in the desk's order.
    expect(tfs.getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual(['3m', '5m', '15m', '30m', '1h', '2h', '4h']);
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
    await waitFor(() => expect(screen.getByRole('list', { name: 'methods' })).toHaveTextContent(/33% win · 15t ·/));
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

  it('target and how many at once are chosen on Entry & exit; the option exits are optional', () => {
    show(signalStrategy());
    tab('Entry & exit');
    expect(screen.getByText(/Still unfilled 5 minutes\s+later, it is cancelled/)).toBeInTheDocument();
    expect(screen.getByLabelText('exits on the BTC perp')).toHaveTextContent(/the signal's own levels on the BTC perpetual/);
    expect(screen.getByText(/Option TP \/ SL — optional, 0 is off\. Sold: the target is a buy-back under the entry, up to 99%, resting at Delta/)).toBeInTheDocument();
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
    expect(screen.getByText(/each signal places a real sell order at Delta/)).toBeInTheDocument();
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

describe('"pick profitable" over the timeframes picked', () => {
  // order flow: +300 on 15m, -400 on 1h. BOS: -100 on 15m, +500 on 1h. Breakout: +50 on 15m only.
  const R = {
    ...REPORT,
    singleByTf: {
      '15m': section('single', [row('order-flow', 6, 4, 300), row('bos', 6, 2, -100), row('breakout', 5, 3, 50)]),
      '1h': section('single', [row('order-flow', 6, 1, -400), row('bos', 7, 5, 500)]),
    },
  };
  const pickOn = async (tfs: string[]) => {
    getMethodReport.mockResolvedValue(R);
    show(signalStrategy({ mode: 'single', tf: tfs[0] as never, tfs: tfs as never, methods: [] }));
    tab('Signals');
    return screen.findByRole('button', { name: new RegExp(`^Pick profitable on ${tfs.join(' \\+ ')}`) });
  };

  it('[critical] every timeframe picked counts, added together -- not the last one clicked', async () => {
    const btn = await pickOn(['15m', '1h']);
    await waitFor(() => expect(btn).toHaveTextContent('(2)'));
    fireEvent.click(btn);
    // order flow nets -100 over both: out. BOS +400: in. Breakout +50 over 5: in.
    expect(screen.getByRole('checkbox', { name: '#11 Order flow' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#6 BOS' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#1 Breakout' })).toBeChecked();
  });

  it('on 15m alone, it is 15m\'s record', async () => {
    const btn = await pickOn(['15m']);
    await waitFor(() => expect(btn).toHaveTextContent('(2)'));
    fireEvent.click(btn);
    expect(screen.getByRole('checkbox', { name: '#11 Order flow' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '#6 BOS' })).not.toBeChecked();
  });

  it('[critical] each method shows its record on every timeframe picked, under the sum', async () => {
    await pickOn(['15m', '1h']);
    expect(await screen.findByLabelText('#11 by timeframe')).toHaveTextContent('15m 67% +300 (6t) · 1h 17% -400 (6t)');
    expect(screen.getByLabelText('#1 by timeframe')).toHaveTextContent('15m 60% +50 (5t) · 1h —');
  });
});

describe('the method list: profitable by a rule you can see, and filtered by result', () => {
  it('[critical] the minimum trades is shown and set; a profitable method under it says why it is left out', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    // with the chain: breakout +900 over 12, the sweep +400 over 3, BOS -500 over 9
    const btn = await screen.findByRole('button', { name: /^Pick profitable with the chain \(1\)/ });
    expect(screen.getByLabelText('minimum trades')).toHaveValue('5');
    expect(await screen.findByText('· 3 of 5 trades')).toBeInTheDocument();     // the sweep: profitable, too few
    fireEvent.click(screen.getByRole('button', { name: '3', pressed: false }));
    expect(btn).toHaveTextContent('(2)');
    expect(screen.queryByText(/of 3 trades/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1', pressed: false }));
    expect(screen.getByText(/one or two trades is luck, not a record/)).toBeInTheDocument();
  });

  it('[critical] Profit / Loss / No trades, with counts that follow the search and family', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    const by = await screen.findByRole('group', { name: 'methods by result' });
    await waitFor(() => expect(within(by).getAllByRole('button').map((b) => b.textContent)).toEqual(['All 4', 'Profit 2', 'Loss 1', 'No trades 1']));
    fireEvent.click(within(by).getByRole('button', { name: /^Loss/ }));
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#6 BOS']);
    fireEvent.click(within(by).getByRole('button', { name: /^Profit/ }));
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#1 Breakout', '#3 Liquidity sweep']);
    fireEvent.click(screen.getByRole('button', { name: 'Reversal', pressed: false }));
    expect(within(by).getAllByRole('button').map((b) => b.textContent)).toEqual(['All 1', 'Profit 1', 'Loss 0', 'No trades 0']);
  });

  it('[critical] Order side: Both / Buy / Sell under the result filter, each row marked, the counts of both rows following each other', async () => {
    show(signalStrategy({ methods: [] }));
    tab('Signals');
    const sides = await screen.findByRole('group', { name: 'methods by order side' });
    const results = screen.getByRole('group', { name: 'methods by result' });
    const labels = (g: HTMLElement) => within(g).getAllByRole('button').map((b) => b.textContent);
    // The result filter is remembered from the last look; start from every method.
    fireEvent.click(within(results).getByRole('button', { name: /^All/ }));
    await waitFor(() => expect(labels(sides)).toEqual(['Both 4', 'Buy 2', 'Sell 2']));
    expect(within(sides).getByRole('button', { name: /^Both/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('#1 order side')).toHaveTextContent('BUY');
    expect(screen.getByLabelText('#3 order side')).toHaveTextContent('SELL');

    fireEvent.click(within(sides).getByRole('button', { name: /^Sell/ }));
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#3 Liquidity sweep', '#6 BOS']);
    expect(labels(results)).toEqual(['All 2', 'Profit 1', 'Loss 1', 'No trades 0']); // the record's counts, of the SELL ones

    // With a result chosen too, both hold: the profitable SELL ones -- and the side's counts are of the profitable ones.
    fireEvent.click(within(results).getByRole('button', { name: /^Profit/ }));
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#3 Liquidity sweep']);
    expect(labels(sides)).toEqual(['Both 2', 'Buy 1', 'Sell 1']);
    expect(screen.getByRole('button', { name: 'Pick all shown (1)' })).toBeEnabled();

    fireEvent.click(within(sides).getByRole('button', { name: /^Buy/ }));
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#1 Breakout']);
    fireEvent.click(within(sides).getByRole('button', { name: /^Both/ }));
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['#1 Breakout', '#3 Liquidity sweep']);
  });
});

describe('bought or sold: the BUY and SELL tabs over the leg', () => {
  const legs = () => screen.getByLabelText('leg from the signal');

  it('[critical] SELL is what a strategy is: a BUY signal sells the PE, a SELL the CE -- and an older strategy reads as SELL', () => {
    const { unmount } = render(<SignalStrategyForm editing={null} open onOpenChange={() => {}} onSaved={() => {}} balanceUsd={228} spot={85_000} />);
    tab('Strike & lots');
    const sides = within(screen.getByRole('radiogroup', { name: 'option buy or sell' }));
    expect(sides.getAllByRole('radio').map((r) => r.textContent)).toEqual(['BUY', 'SELL']);
    expect(sides.getByRole('radio', { name: 'SELL' })).toBeChecked();
    expect(legs()).toHaveTextContent('BUY signal → sells PEwins as BTC rises or holds');
    expect(legs()).toHaveTextContent('SELL signal → sells CEwins as BTC falls or holds');
    unmount();
    // Saved before the choice existed: no `action` on it at all.
    const older = signalStrategy();
    delete (older.config.signal as Partial<SignalRule>).action;
    show(older);
    tab('Strike & lots');
    expect(within(screen.getByRole('radiogroup', { name: 'option buy or sell' })).getByRole('radio', { name: 'SELL' })).toBeChecked();
  });

  it('[critical] BUY: a BUY signal buys the CE, a SELL the PE; its target open and its stop under 100%; live orders off until switched on -- and saved as bought', async () => {
    show(signalStrategy({}, { liveOrders: true, takeProfitPct: 0.5 }));
    tab('Strike & lots');
    radio('option buy or sell', 'BUY');
    expect(legs()).toHaveTextContent('BUY signal → buys CEwins as BTC rises');
    expect(legs()).toHaveTextContent('SELL signal → buys PEwins as BTC falls');
    expect(screen.getByRole('note')).toHaveTextContent('Bought at the offer, sold to close. The most it can lose is the premium paid.');
    expect(screen.getByText(/a BUY buys a call, a SELL a put/)).toBeInTheDocument();

    // Live orders went off with the change of side -- real orders of the other kind are switched on on purpose.
    const live = screen.getByRole('switch', { name: /Live orders/ });
    expect(live).not.toBeChecked();
    fireEvent.click(live);
    expect(live).toBeChecked();
    expect(screen.getByText(/ON — each signal places a real buy order at Delta\./)).toBeInTheDocument();

    // The option's own exits: both, each off at 0 -- the seller's 50% target did not come across as a buyer's.
    tab('Entry & exit');
    expect(screen.getByLabelText('Take profit percent')).toHaveValue('0');
    expect(screen.getByLabelText('Stop loss percent')).toHaveValue('0');
    expect(screen.getByText(/Bought: the target is a sale over the entry, with no upper limit; the stop a sale under it, up to 99% — the premium and no more\./)).toBeInTheDocument();
    expect(screen.queryByText(/Add one: \+200%/)).toBeNull(); // the seller's advice is not the buyer's
    // The entry is the offer a buyer pays -- not the seller's "rest at the offer, then sell at the bid".
    expect(screen.getByLabelText('entry price for a bought option')).toHaveTextContent('A buyer pays the offer: each signal is bought with a limit at the offer of its strike');
    expect(screen.queryByRole('radiogroup', { name: 'entry price' })).toBeNull();
    expect(screen.queryByLabelText('cross after seconds')).toBeNull();
    expect(screen.queryByText(/then sells at the bid/)).toBeNull();
    expect(screen.queryByText(/buys the option back/)).toBeNull();
    expect(screen.getByLabelText('exits on the BTC perp')).toHaveTextContent('A bought option would be sold the moment the perp reaches either');
    // Its stop is a sale under the entry, up to 99%: 40% lost, never "buys back above the entry" -- and 150% is refused.
    fireEvent.change(screen.getByLabelText('Stop loss percent'), { target: { value: '40' } });
    expect(within(screen.getByRole('region', { name: 'Stop loss' })).getByText(/sells once it has lost 40% of the premium paid/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Stop loss percent'), { target: { value: '150' } });
    expect(await screen.findByText('Stop loss must be between 0 and 99% of the premium paid: a bought option can lose its premium and no more.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Stop loss percent'), { target: { value: '40' } });
    // Its target is a sale over the entry, and open: 300% up is a buyer's target, and is taken.
    fireEvent.change(screen.getByLabelText('Take profit percent'), { target: { value: '300' } });
    expect(within(screen.getByRole('region', { name: 'Take profit' })).getByText(/sells once it is up 300% on the premium paid/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/must be between/)).toBeNull());
    expect(screen.queryByText(/buys back/)).toBeNull();

    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.signal!.action).toBe('buy');
    expect(saved().config.liveOrders).toBe(true);
    expect([saved().config.takeProfitPct, saved().config.stopLossPct]).toEqual([3, 0.4]);
  });

  it('[critical] the size of a BUY strategy is its premium, not a seller\'s margin', () => {
    // 1 lot a signal, at most 2 open, paying at most $40: 2 contracts x $40 x 0.001 BTC = $0.08 of premium.
    show(signalStrategy({ action: 'buy', maxOpen: 2 }, { lots: 1, strikeRule: 'premium', premium: { mode: 'atMost', usd: 40, fallbackUsd: null } }));
    tab('Strike & lots');
    expect(screen.getByText('Premium, at most')).toBeInTheDocument();
    expect(screen.queryByText(/at 200x/)).toBeNull();
    expect(screen.getByText('$0.080 premium, no margin')).toBeInTheDocument();
    // Sold, the same strategy shows the seller's margin, as before.
    radio('option buy or sell', 'SELL');
    expect(screen.getByText('Margin')).toBeInTheDocument();
    expect(screen.getByText(/at 200x/)).toBeInTheDocument();
  });

  it('[critical] back to SELL: the exits start off again and take the seller\'s limits -- target up to 99%, stop open -- and live orders can be on', async () => {
    show(signalStrategy({ action: 'buy' }, { takeProfitPct: 3, stopLossPct: 0.4 }));
    tab('Entry & exit');
    expect(screen.getByLabelText('Take profit percent')).toHaveValue('300'); // a buyer's target, as saved
    tab('Strike & lots');
    radio('option buy or sell', 'SELL');
    expect(legs()).toHaveTextContent('BUY signal → sells PE');
    tab('Entry & exit');
    // The buyer's 300% did not come across as a seller's target.
    expect(screen.getByLabelText('Take profit percent')).toHaveValue('0');
    expect(screen.getByLabelText('Stop loss percent')).toHaveValue('0');
    expect(screen.getByText(/Sold: the target is a buy-back under the entry, up to 99%, resting at Delta\. The stop is a buy-back over the entry: the desk watches it/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Take profit percent'), { target: { value: '300' } });
    expect(await screen.findByText('Take profit must be between 0 and 99% of the credit.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Take profit percent'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Stop loss percent'), { target: { value: '300' } });
    await waitFor(() => expect(screen.queryByText(/must be between/)).toBeNull());
    expect(within(screen.getByRole('region', { name: 'Stop loss' })).getByText(/buys back 300% above the entry/)).toBeInTheDocument();
    const live = screen.getByRole('switch', { name: /Live orders/ });
    fireEvent.click(live);
    expect(live).toBeChecked();
  });
});

describe('the exits: the perp first, the option as the backstop', () => {
  it('[critical] a new strategy puts NOTHING on the option: target and stop off until you set them', async () => {
    show(null);
    tab('Entry & exit');
    expect(screen.getByLabelText('exit order')).toHaveTextContent(/BTC perp SL \/ TGT.*Checked first.*Option TP \/ SL.*only if you set them/);
    expect(screen.getByLabelText('Take profit percent')).toHaveValue('0');
    expect(screen.getByLabelText('Stop loss percent')).toHaveValue('0');
    expect(screen.getByText(/Option stop off — nothing is placed on the option/)).toBeInTheDocument();
    // not the clock strategy's "runs to settlement" warning: a signal trade has the perp's exits
    expect(screen.queryByText(/No target and no stop/)).toBeNull();
    expect(screen.getByText(/no option target or stop is placed/)).toBeInTheDocument();
  });

  it('[critical] with the option stop off it says what that means; a stop is added only when asked', () => {
    show(signalStrategy({}, { stopLossPct: 0 }));
    tab('Entry & exit');
    expect(screen.getByText(/Option stop off — nothing is placed on the option/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add one: \+200%/ }));
    expect(screen.queryByText(/Option stop off/)).toBeNull();
    expect(screen.getByLabelText('Stop loss percent')).toHaveValue('200');
  });
});

describe('the strike rule over the window: the same all the time, or cut into blocks', () => {
  // The owner's window: 5:35 PM to 5:29 PM, ≤ $50 with a $75 "if none", 3 lots.
  const day = (over: Partial<Strategy['config']> = {}) => signalStrategy({}, {
    entryTime: '17:35', exitTime: '17:29', lots: 3,
    strikeRule: 'premium', premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 }, ...over,
  });
  const openBlocks = (s: Strategy = day()) => {
    show(s);
    tab('Strike & lots');
    return screen.getByRole('region', { name: 'strike rule over the window' });
  };
  const sameBox = () => screen.getByRole('checkbox', { name: 'Same strike rule all the time' });
  const byTimeBox = () => screen.getByRole('checkbox', { name: 'Different strike rule by time of day' });
  const block = (n: number) => within(screen.getByRole('list', { name: 'strike blocks' })).getByRole('listitem', { name: `block ${n}` });
  const blockCount = () => within(screen.getByRole('list', { name: 'strike blocks' })).getAllByRole('listitem').length;

  it('[critical] two tick boxes, "Same strike rule all the time" ticked by default: one rule, and nothing extra is saved', async () => {
    const region = openBlocks();
    expect(sameBox()).toBeChecked();
    expect(byTimeBox()).not.toBeChecked();
    // its section holds the strike fields: they are inside it, not above the two boxes
    const same = within(region).getByRole('group', { name: 'same strike rule all the time' });
    expect(within(same).getByText('One rule for every signal, from the start of the window to its end.')).toBeInTheDocument();
    expect(within(same).getByRole('radiogroup', { name: 'strike rule' })).toBeInTheDocument();
    expect(within(same).getByLabelText('premium usd')).toHaveValue('50');
    expect(within(same).getByRole('switch', { name: /Keep it at least this far out of the money/ })).toBeInTheDocument();
    expect(within(region).getByText(/Off — tick to cut the window into blocks of hours/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'strike blocks' })).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.strikeBlocks ?? []).toEqual([]);
  });

  it('[critical] by time of day: 23 h 54 min every 4 hours is six blocks -- 4, 4, 4, 4, 4 and 3 h 54 min -- the first the rule above', () => {
    const region = openBlocks();
    fireEvent.click(byTimeBox());
    expect(byTimeBox()).toBeChecked();
    expect(sameBox()).not.toBeChecked();
    expect(blockCount()).toBe(6);
    // the one-rule section closes, and its rule becomes block 1 -- from the start of the window, with the same fields
    expect(screen.queryByRole('group', { name: 'same strike rule all the time' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('premium usd')).not.toBeInTheDocument();
    expect(within(region).getByText('Off — the rule changes through the window, below.')).toBeInTheDocument();
    expect(block(1)).toHaveTextContent(/Block 1.*5:35 PM.*the start of the window.*→ 9:35 PM · 4 h/);
    expect(within(block(1)).getByLabelText('block 1 premium usd')).toHaveValue('50');
    expect(within(block(1)).getByLabelText('block 1 fallback usd')).toHaveValue('75');
    expect(within(block(1)).queryByRole('button', { name: /remove block/ })).not.toBeInTheDocument();
    expect(block(2)).toHaveTextContent('→ 1:35 AM · 4 h');
    expect(block(6)).toHaveTextContent('→ 5:29 PM · 3 h 54 min');
    expect(within(block(2)).getByLabelText('block 2 premium usd')).toHaveValue('50');
    expect(within(block(2)).getByLabelText('block 2 fallback usd')).toHaveValue('75');
    expect(within(region).getByText(/5:35 PM → 5:29 PM is 23 h 54 min: 6 blocks of 4 h, the last 3 h 54 min/)).toBeInTheDocument();
    expect(within(region).getByText(/6 blocks from 5:35 PM to 5:29 PM/)).toBeInTheDocument();
  });

  it('[critical] one box is always ticked: the ticked one tapped again changes nothing, and loses nothing typed', () => {
    openBlocks();
    fireEvent.click(sameBox());
    expect(sameBox()).toBeChecked();
    expect(screen.queryByRole('list', { name: 'strike blocks' })).not.toBeInTheDocument();
    fireEvent.click(byTimeBox());
    fireEvent.change(screen.getByLabelText('block 2 premium usd'), { target: { value: '40' } });
    fireEvent.click(byTimeBox());
    expect(byTimeBox()).toBeChecked();
    expect(blockCount()).toBe(6);
    expect(screen.getByLabelText('block 2 premium usd')).toHaveValue('40');
  });

  it('[critical] the 4 hours is typed: 6 hours makes four blocks, 2 hours twelve', () => {
    openBlocks();
    fireEvent.click(byTimeBox());
    const hours = screen.getByLabelText('block hours');
    expect(hours).toHaveValue('4');
    fireEvent.change(hours, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    expect(blockCount()).toBe(4);
    expect(block(4)).toHaveTextContent('→ 5:29 PM · 5 h 54 min');
    fireEvent.change(hours, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    expect(blockCount()).toBe(12);
  });

  it('[critical] the premium reads "≥ Greater or equal" or "≤ Less or equal" -- on the rule and on every block', () => {
    openBlocks();
    const main = screen.getByRole('radiogroup', { name: 'premium rule' });
    expect(within(main).getByRole('radio', { name: '≥ Greater or equal' })).toHaveAttribute('aria-checked', 'false');
    expect(within(main).getByRole('radio', { name: '≤ Less or equal' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radio', { name: 'At least' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'At most' })).not.toBeInTheDocument();
    fireEvent.click(byTimeBox());
    const b2 = screen.getByRole('radiogroup', { name: 'block 2 premium rule' });
    expect(within(b2).getByRole('radio', { name: '≤ Less or equal' })).toHaveAttribute('aria-checked', 'true');
    expect(within(b2).getByRole('radio', { name: '≥ Greater or equal' })).toBeInTheDocument();
  });

  it('[critical] each block has its own rule -- by premium, ≥ or ≤, with an "if none" number, or by strike -- and all of it is saved', async () => {
    openBlocks();
    fireEvent.click(byTimeBox());
    // block 2: ≤ $40, no "if none"
    fireEvent.change(screen.getByLabelText('block 2 premium usd'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('block 2 fallback usd'), { target: { value: '' } });
    // block 3: ≥ $15, if none ≥ $10
    radio('block 3 premium rule', '≥ Greater or equal');
    fireEvent.change(screen.getByLabelText('block 3 premium usd'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('block 3 fallback usd'), { target: { value: '10' } });
    // block 4: by strike, two out
    radio('block 4 strike rule', 'By strike');
    expect(within(block(4)).queryByLabelText('block 4 premium usd')).not.toBeInTheDocument();
    fireEvent.click(within(block(4)).getByRole('button', { name: 'one strike further out' }));
    fireEvent.click(within(block(4)).getByRole('button', { name: 'one strike further out' }));
    expect(within(block(4)).getByRole('status', { name: 'which strike' })).toHaveTextContent('OTM 2');

    expect(screen.getByText(/— then from 9:35 PM ≤ \$40, from 1:35 AM ≥ \$15 \(if none, ≥ \$10\), from 5:35 AM OTM 2, from 9:35 AM ≤ \$50 \(if none, ≤ \$75\)/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    const sent = saved().config;
    expect(sent.premium).toEqual({ mode: 'atMost', usd: 50, fallbackUsd: 75 });
    expect(sent.strikeBlocks).toEqual([
      { at: '21:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 40, fallbackUsd: null } },
      { at: '01:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atLeast', usd: 15, fallbackUsd: 10 } },
      { at: '05:35', strikeRule: 'strict', strikeStep: 2, premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 } },
      { at: '09:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 } },
      { at: '13:35', strikeRule: 'premium', strikeStep: 0, premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 } },
    ]);
  });

  it('[critical] block 1 is the strategy\'s own rule: edited in its row, kept when going back to one rule, and saved as the rule', async () => {
    openBlocks();
    fireEvent.click(byTimeBox());
    fireEvent.change(screen.getByLabelText('block 1 premium usd'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('block 1 fallback usd'), { target: { value: '90' } });
    expect(screen.getByLabelText('block 2 premium usd')).toHaveValue('50');     // no other block moved
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.premium).toEqual({ mode: 'atMost', usd: 60, fallbackUsd: 90 });
    expect(saved().config.strikeBlocks![0]!.premium).toEqual({ mode: 'atMost', usd: 50, fallbackUsd: 75 });
    fireEvent.click(sameBox());
    expect(screen.getByLabelText('premium usd')).toHaveValue('60');
    expect(screen.getByLabelText('premium fallback usd')).toHaveValue('90');
  });

  it('[critical] block 1\'s own mistake is said on block 1\'s row', () => {
    openBlocks();
    fireEvent.click(byTimeBox());
    fireEvent.change(screen.getByLabelText('block 1 premium usd'), { target: { value: '0' } });
    expect(within(block(1)).getByRole('alert')).toHaveTextContent('Premium must be a positive number of dollars.');
    expect(within(block(2)).queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton()).toHaveTextContent('Fix 1 to save');
  });

  it('fewer blocks: one is removed and the one before it runs on; one is added after the last', () => {
    openBlocks();
    fireEvent.click(byTimeBox());
    fireEvent.click(screen.getByRole('button', { name: 'remove block 3' }));
    expect(blockCount()).toBe(5);
    expect(block(2)).toHaveTextContent('→ 5:35 AM · 8 h');
    fireEvent.click(screen.getByRole('button', { name: 'remove block 5' }));
    expect(block(4)).toHaveTextContent('→ 5:29 PM · 7 h 54 min');
    fireEvent.click(screen.getByRole('button', { name: /Add a block/ }));
    expect(blockCount()).toBe(5);
    expect(block(5)).toHaveTextContent('→ 5:29 PM · 3 h 54 min');
  });

  it('[critical] a bad block is said on its own row, marks the tab, and nothing is sent', () => {
    openBlocks();
    fireEvent.click(byTimeBox());
    fireEvent.change(screen.getByLabelText('block 3 premium usd'), { target: { value: '0' } });
    expect(within(block(3)).getByRole('alert')).toHaveTextContent('Block 3: the premium must be a positive number of dollars.');
    expect(within(block(2)).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Strike & lots/ })).toContainElement(screen.getByLabelText('has a problem'));
    expect(saveButton()).toHaveTextContent('Fix 1 to save');
    fireEvent.click(saveButton());
    expect(saveStrategy).not.toHaveBeenCalled();
  });

  it('[critical] a saved strategy opens with its blocks, each with the hours it runs', () => {
    const blocks = [
      { at: '21:35', strikeRule: 'premium' as const, strikeStep: 0, premium: { mode: 'atMost' as const, usd: 40, fallbackUsd: null } },
      { at: '05:35', strikeRule: 'strict' as const, strikeStep: 1, premium: { mode: 'atMost' as const, usd: 50, fallbackUsd: null } },
    ];
    openBlocks(day({ strikeBlocks: blocks }));
    expect(byTimeBox()).toBeChecked();
    expect(sameBox()).not.toBeChecked();
    expect(blockCount()).toBe(3);
    expect(block(2)).toHaveTextContent('→ 5:35 AM · 8 h');
    expect(within(block(3)).getByRole('status', { name: 'which strike' })).toHaveTextContent('OTM 1');
  });

  it('a window moved from under its blocks is said, and one tap splits it again', () => {
    const blocks = [{ at: '21:35', strikeRule: 'premium' as const, strikeStep: 0, premium: { mode: 'atMost' as const, usd: 40, fallbackUsd: null } }];
    openBlocks(day({ entryTime: '09:00', exitTime: '17:00', strikeBlocks: blocks }));
    expect(within(block(2)).getByRole('alert')).toHaveTextContent('Block 2 (9:35 PM) must start after entry (9:00 AM) and before exit (5:00 PM).');
    fireEvent.click(screen.getByRole('button', { name: 'Split again every 4 h' }));
    expect(blockCount()).toBe(2);
    expect(block(2)).toHaveTextContent('→ 5:00 PM · 4 h');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('[critical] back to "Same strike rule all the time": the blocks are gone and the rule above holds all window', async () => {
    openBlocks();
    fireEvent.click(byTimeBox());
    fireEvent.click(sameBox());
    expect(sameBox()).toBeChecked();
    expect(byTimeBox()).not.toBeChecked();
    expect(screen.queryByRole('list', { name: 'strike blocks' })).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.strikeBlocks).toEqual([]);
  });

  it('a window shorter than one length is cut in half, so there is something to edit', () => {
    openBlocks(day({ entryTime: '09:00', exitTime: '11:00' }));
    fireEvent.click(byTimeBox());
    expect(blockCount()).toBe(2);
    expect(block(1)).toHaveTextContent(/9:00 AM.*→ 10:00 AM · 1 h/);
    expect(block(2)).toHaveTextContent('→ 11:00 AM · 1 h');
  });

  it('[critical] "Its own minimum premium" is last on the tab: under the strike rules, the blocks and the lots', () => {
    const region = openBlocks();
    const minPremium = screen.getByRole('switch', { name: /Its own minimum premium/ });
    const after = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(region, minPremium)).toBe(true);
    expect(after(screen.getByLabelText(/^lots/i), minPremium)).toBe(true);
    expect(screen.getAllByRole('switch', { name: /Its own minimum premium/ })).toHaveLength(1);
    fireEvent.click(minPremium);
    expect(screen.getByLabelText('minimum premium usd')).toHaveValue('1');
  });

});

describe('the split length is remembered with the blocks', () => {
  const blocksEvery = (hours: number) => {
    const out = [];
    for (let m = hours * 60; m < 1434; m += hours * 60) {
      const t = (17 * 60 + 35 + m) % 1440;
      out.push({ at: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, strikeRule: 'premium' as const, strikeStep: 0, premium: { mode: 'atMost' as const, usd: 50, fallbackUsd: 75 } });
    }
    return out;
  };
  const saved = (hours: number) => signalStrategy({}, {
    entryTime: '17:35', exitTime: '17:29', strikeRule: 'premium', premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 }, strikeBlocks: blocksEvery(hours),
  });

  it('[critical] a strategy saved split every 3 hours reopens showing 3 h and its 8 blocks -- not the default 4', () => {
    show(saved(3));
    tab('Strike & lots');
    expect(screen.getByLabelText('block hours')).toHaveValue('3');
    expect(within(screen.getByRole('list', { name: 'strike blocks' })).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByText(/5:35 PM → 5:29 PM is 23 h 54 min: 8 blocks of 3 h, the last 2 h 54 min/)).toBeInTheDocument();
  });

  it('[critical] typed, split, and another tab visited: the length is still what was typed', () => {
    show(saved(4));
    tab('Strike & lots');
    expect(screen.getByLabelText('block hours')).toHaveValue('4');
    fireEvent.change(screen.getByLabelText('block hours'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    tab('When');
    tab('Strike & lots');
    expect(screen.getByLabelText('block hours')).toHaveValue('6');
    expect(within(screen.getByRole('list', { name: 'strike blocks' })).getAllByRole('listitem')).toHaveLength(4);
  });

  it('a strategy with one rule all the time starts the split at 4 h', () => {
    show(signalStrategy({}, { entryTime: '17:35', exitTime: '17:29' }));
    tab('Strike & lots');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Different strike rule by time of day' }));
    expect(screen.getByLabelText('block hours')).toHaveValue('4');
  });
});

describe('the distance rule and its else strike, beside the premium', () => {
  const day = (over: Partial<Strategy['config']> = {}) => signalStrategy({}, {
    entryTime: '17:35', exitTime: '17:29', lots: 3,
    strikeRule: 'premium', premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 }, ...over,
  });
  const open = (s: Strategy = day()) => { show(s); tab('Strike & lots'); };
  // The rule's own switch is the first on the tab; each premium block has one of its own under it.
  const floorSwitch = () => screen.getAllByRole('switch', { name: /Keep it at least this far out of the money/ })[0]!;
  const strike = (name: string) => screen.getByRole('status', { name });
  const step = (name: string, way: 'further out' | 'nearer the money') => fireEvent.click(screen.getByRole('button', { name: `${name}: ${way}` }));
  const block = (n: number) => within(screen.getByRole('list', { name: 'strike blocks' })).getByRole('listitem', { name: `block ${n}` });
  const byTimeBox = () => screen.getByRole('checkbox', { name: 'Different strike rule by time of day' });

  it('[critical] off by default: no strikes to pick, and nothing about it is saved', async () => {
    open();
    expect(floorSwitch()).not.toBeChecked();
    expect(screen.getByText('Off — whichever strike the premium picks, however near the money.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'rule strike' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'else strike' })).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.premium.minOtm ?? null).toBeNull();
  });

  it('[critical] switched on: a rule strike and an else strike, both picked like a strike, both starting at OTM 6', () => {
    open();
    fireEvent.click(floorSwitch());
    expect(strike('rule strike')).toHaveTextContent('OTM 6');
    expect(strike('else strike')).toHaveTextContent('OTM 6');
    expect(screen.getByText('The premium\'s strike is sold only at OTM 6 or further out — OTM 7 stays OTM 7. Else — nearer than that, or none found — sells OTM 6.')).toBeInTheDocument();
  });

  it('[critical] the two are separate: the else strike may be further out than the rule, nearer, or the same -- and both are saved', async () => {
    open();
    fireEvent.click(floorSwitch());
    step('rule strike', 'further out');                       // rule OTM 7
    expect(strike('rule strike')).toHaveTextContent('OTM 7');
    expect(strike('else strike')).toHaveTextContent('OTM 6'); // the else did not move with it
    step('else strike', 'further out');
    step('else strike', 'further out');                       // else OTM 8: different, further out
    expect(strike('else strike')).toHaveTextContent('OTM 8');
    expect(strike('rule strike')).toHaveTextContent('OTM 7');
    expect(screen.getByText(/sold only at OTM 7 or further out — OTM 8 stays OTM 8\. Else — nearer than that, or none found — sells OTM 8\./)).toBeInTheDocument();
    expect(screen.getByText(/only at OTM 7 or further — else sells OTM 8, 3 lots/)).toBeInTheDocument();
    step('else strike', 'nearer the money');                  // else OTM 7: equal
    expect(screen.getByText(/only at OTM 7 or further — else sells OTM 7, 3 lots/)).toBeInTheDocument();
    for (let i = 0; i < 3; i += 1) step('else strike', 'nearer the money');   // else OTM 4: different, nearer
    expect(strike('else strike')).toHaveTextContent('OTM 4');
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.premium).toEqual({ mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm: 7, elseOtm: 4 });
  });

  it('[critical] neither can be set nearer than OTM 1: a premium rule never sells at or in the money', () => {
    open(day({ premium: { mode: 'atMost', usd: 50, minOtm: 1, elseOtm: 1 } }));
    expect(strike('rule strike')).toHaveTextContent('OTM 1');
    expect(strike('else strike')).toHaveTextContent('OTM 1');
    expect(screen.getByRole('button', { name: 'rule strike: nearer the money' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'else strike: nearer the money' })).toBeDisabled();
  });

  it('a strategy saved before the else had a strike of its own shows the rule\'s strike as its else', () => {
    open(day({ premium: { mode: 'atMost', usd: 50, minOtm: 6 } }));
    expect(strike('rule strike')).toHaveTextContent('OTM 6');
    expect(strike('else strike')).toHaveTextContent('OTM 6');
  });

  it('it belongs to the premium rule: by strike has no such switch', () => {
    open(day({ premium: { mode: 'atMost', usd: 50, minOtm: 6, elseOtm: 8 } }));
    expect(floorSwitch()).toBeChecked();
    radio('strike rule', 'By strike');
    expect(screen.queryByRole('switch', { name: /Keep it at least this far out of the money/ })).not.toBeInTheDocument();
  });

  it('switched off again: saved as off, the else with it', async () => {
    open(day({ premium: { mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm: 6, elseOtm: 8 } }));
    fireEvent.click(floorSwitch());
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.premium.minOtm).toBeNull();
    expect(saved().config.premium.elseOtm).toBeNull();
  });

  it('[critical] every block has the same switch, the same words and its own two strikes', async () => {
    open(day({ premium: { mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm: 6, elseOtm: 8 } }));
    fireEvent.click(byTimeBox());
    // block 1 is the strategy's own rule, with its own two strikes
    expect(strike('block 1 rule strike')).toHaveTextContent('OTM 6');
    expect(strike('block 1 else strike')).toHaveTextContent('OTM 8');
    // a new block starts as that rule: on, OTM 6, else OTM 8 -- and says so in its own row
    expect(within(block(2)).getByRole('switch', { name: /Keep it at least this far out of the money/ })).toBeChecked();
    expect(strike('block 2 rule strike')).toHaveTextContent('OTM 6');
    expect(strike('block 2 else strike')).toHaveTextContent('OTM 8');
    expect(within(block(2)).getByText(/sold only at OTM 6 or further out — OTM 7 stays OTM 7\. Else — nearer than that, or none found — sells OTM 8\./)).toBeInTheDocument();
    // block 2: its own strikes -- rule OTM 5, else OTM 9
    step('block 2 rule strike', 'nearer the money');
    step('block 2 else strike', 'further out');
    expect(strike('block 2 rule strike')).toHaveTextContent('OTM 5');
    expect(strike('block 2 else strike')).toHaveTextContent('OTM 9');
    expect(strike('block 1 rule strike')).toHaveTextContent('OTM 6');                // block 1 did not move
    expect(strike('block 3 rule strike')).toHaveTextContent('OTM 6');                // nor the next block
    // block 3: switched off; block 4: by strike has none
    fireEvent.click(within(block(3)).getByRole('switch', { name: /Keep it at least this far out of the money/ }));
    expect(screen.queryByRole('status', { name: 'block 3 rule strike' })).not.toBeInTheDocument();
    expect(within(block(3)).getByText('Off — whichever strike the premium picks, however near the money.')).toBeInTheDocument();
    radio('block 4 strike rule', 'By strike');
    expect(within(block(4)).queryByRole('switch', { name: /Keep it at least this far out of the money/ })).not.toBeInTheDocument();
    expect(screen.getByText(/then from 9:35 PM ≤ \$50 \(if none, ≤ \$75\) at OTM 5 or further, else OTM 9, from 1:35 AM ≤ \$50 \(if none, ≤ \$75\), from 5:35 AM ATM/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    const sent = saved().config;
    expect([sent.premium.minOtm, sent.premium.elseOtm]).toEqual([6, 8]);
    expect(sent.strikeBlocks!.map((b) => [b.premium.minOtm ?? null, b.premium.elseOtm ?? null])).toEqual([[5, 9], [null, null], [6, 8], [6, 8], [6, 8]]);
  });

  it('[critical] a block switched on under a rule that has none starts at OTM 6, else OTM 6', () => {
    open();
    fireEvent.click(byTimeBox());
    const sw = within(block(2)).getByRole('switch', { name: /Keep it at least this far out of the money/ });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    expect(strike('block 2 rule strike')).toHaveTextContent('OTM 6');
    expect(strike('block 2 else strike')).toHaveTextContent('OTM 6');
    expect(screen.queryByRole('status', { name: 'rule strike' })).not.toBeInTheDocument();
    expect(block(2)).toHaveTextContent(/sells OTM 6\./);
  });

});

describe('the SL and TGT distance filters: two numbers of points for each timeframe picked', () => {
  const single = (over: Partial<SignalRule> = {}) => signalStrategy({ mode: 'single', tf: '5m', tfs: ['5m', '15m'], ...over });
  const group = () => screen.getByRole('group', { name: 'SL and TGT distance by timeframe' });

  it('[critical] without the chain: an SL and a TGT field per timeframe picked, both 0 -- off -- until typed; with the chain, the chain\'s own row instead', () => {
    show(single());
    for (const tf of ['5m', '15m']) {
      expect(within(group()).getByLabelText(`${tf} SL distance pts`)).toHaveValue('0');
      expect(within(group()).getByLabelText(`${tf} TGT distance pts`)).toHaveValue('0');
    }
    expect(within(group()).queryByLabelText('1h SL distance pts')).not.toBeInTheDocument();
    // And a maximum beside each, 0 -- off -- the same way.
    for (const tf of ['5m', '15m']) {
      expect(within(group()).getByLabelText(`${tf} SL maximum distance pts`)).toHaveValue('0');
      expect(within(group()).getByLabelText(`${tf} TGT maximum distance pts`)).toHaveValue('0');
    }
    expect(within(group()).getAllByText('all off')).toHaveLength(2);
    expect(within(group()).getByText(/a minimum \(≥\) and a maximum \(≤\)\. Inside both and the signal is taken; nearer than the minimum or further\s+than the maximum and it is skipped/)).toBeInTheDocument();
    expect(within(group()).getByText(/on from any number above 0 — 0 is off/)).toBeInTheDocument();
    radio('signal way', 'With the timeframe chain');
    expect(screen.queryByRole('group', { name: 'SL and TGT distance by timeframe' })).not.toBeInTheDocument();
    // The chain has a row of its own (6 Oct 2026): no timeframe's fields, and all four off.
    const chain = within(screen.getByRole('group', { name: 'SL and TGT distance with the chain' }));
    expect(chain.queryByLabelText('5m SL distance pts')).not.toBeInTheDocument();
    for (const f of ['chain SL distance pts', 'chain SL maximum distance pts', 'chain TGT distance pts', 'chain TGT maximum distance pts']) {
      expect(chain.getByLabelText(f)).toHaveValue('0');
    }
    expect(chain.getByLabelText('chain distance filters')).toHaveTextContent('all off');
    expect(chain.getByText(/for signals with the chain \(their entry is on 5m\)/)).toBeInTheDocument();
  });

  it('[critical] with the chain: its own range is set, said, saved under the chain -- and a timeframe\'s number carried over is neither shown nor switched on', async () => {
    // As the live one was: copied from a strategy without the chain, its 5m and 4h numbers still on it.
    show(signalStrategy({ mode: 'mtf', tf: '5m', tfs: ['5m'], minSlPts: { '5m': 100, '4h': 100 }, minTgtPts: { '5m': 100, '4h': 100 } }));
    const chain = within(screen.getByRole('group', { name: 'SL and TGT distance with the chain' }));
    expect(chain.getByLabelText('chain SL distance pts')).toHaveValue('0');
    expect(chain.getByLabelText('chain distance filters')).toHaveTextContent('all off');
    expect(screen.getByText(/with the timeframe chain: a BUY sells a put/)).toBeInTheDocument();

    fireEvent.change(chain.getByLabelText('chain SL distance pts'), { target: { value: '180' } });
    fireEvent.change(chain.getByLabelText('chain SL maximum distance pts'), { target: { value: '600' } });
    fireEvent.change(chain.getByLabelText('chain TGT distance pts'), { target: { value: '250' } });
    expect(chain.getByLabelText('chain distance filters')).toHaveTextContent('SL 180 to 600 · TGT 250+');
    expect(screen.getByText(/with the timeframe chain \(only with the SL 180 to 600 pts from the entry; the TGT 250\+ pts from the entry\)/)).toBeInTheDocument();
    // A maximum under its minimum is refused in the chain's words.
    fireEvent.change(chain.getByLabelText('chain SL maximum distance pts'), { target: { value: '100' } });
    expect(await screen.findByText('The SL maximum with the chain (100) is under its minimum (180): no signal could pass both.')).toBeInTheDocument();
    fireEvent.change(chain.getByLabelText('chain SL maximum distance pts'), { target: { value: '600' } });
    await waitFor(() => expect(screen.queryByText(/is under its minimum/)).toBeNull());

    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.signal!.minSlPts).toMatchObject({ chain: 180 });
    expect(saved().config.signal!.maxSlPts).toMatchObject({ chain: 600 });
    expect(saved().config.signal!.minTgtPts).toMatchObject({ chain: 250 });
  });

  it('[critical] each is its own condition: a number above 0 switches that one on, and the row says which are on', () => {
    show(single());
    fireEvent.change(screen.getByLabelText('5m TGT distance pts'), { target: { value: '400' } });
    expect(within(group()).getByText('TGT 400+')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('5m SL distance pts'), { target: { value: '150' } });
    expect(within(group()).getByText('SL 150+ · TGT 400+')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('5m TGT distance pts'), { target: { value: '0' } });
    expect(within(group()).getByText('SL 150+')).toBeInTheDocument();
    expect(within(group()).getAllByText('all off')).toHaveLength(1);      // 15m untouched
  });

  it('[critical] a maximum beside each minimum: on from any number above 0, said in words, saved -- and one under its minimum is refused', async () => {
    show(single());
    fireEvent.change(screen.getByLabelText('5m SL maximum distance pts'), { target: { value: '600' } });
    expect(screen.getByLabelText('5m distance filters')).toHaveTextContent('SL up to 600');
    fireEvent.change(screen.getByLabelText('5m SL distance pts'), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText('5m TGT maximum distance pts'), { target: { value: '900' } });
    expect(screen.getByLabelText('5m distance filters')).toHaveTextContent('SL 150 to 600 · TGT up to 900');
    expect(screen.getByLabelText('15m distance filters')).toHaveTextContent('all off');

    // Under its own minimum no signal could pass: said, in the server's words.
    fireEvent.change(screen.getByLabelText('5m SL maximum distance pts'), { target: { value: '100' } });
    expect(await screen.findByText('The SL maximum for 5m (100) is under its minimum (150): no signal could pass both.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('5m SL maximum distance pts'), { target: { value: '600' } });
    await waitFor(() => expect(screen.queryByText(/is under its minimum/)).toBeNull());
  });

  it('[critical] picking another timeframe adds its fields; each keeps its own numbers, and all of it is saved', async () => {
    show(single());
    fireEvent.change(screen.getByLabelText('5m SL distance pts'), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText('15m SL distance pts'), { target: { value: '300' } });
    fireEvent.change(screen.getByLabelText('5m TGT distance pts'), { target: { value: '400' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'signal timeframes' })).getByRole('button', { name: '1h' }));
    expect(screen.getByLabelText('1h SL distance pts')).toHaveValue('0');
    expect(screen.getByLabelText('1h TGT distance pts')).toHaveValue('0');
    expect(screen.getByLabelText('5m SL distance pts')).toHaveValue('150');
    expect(screen.getByText(/without the chain, on 5m \+ 15m \+ 1h \(only with the SL 150\+ pts from the entry on 5m, 300\+ on 15m; the TGT 400\+ pts from the entry on 5m\)/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saved().config.signal!.minSlPts).toMatchObject({ '5m': 150, '15m': 300 });
    expect(saved().config.signal!.minTgtPts).toMatchObject({ '5m': 400 });
  });

  it('[critical] a saved strategy opens with its numbers; too large is said under the fields, by name, and stops the save', () => {
    show(single({ minSlPts: { '5m': 150, '15m': 300 }, minTgtPts: { '15m': 500 } }));
    expect(screen.getByLabelText('5m SL distance pts')).toHaveValue('150');
    expect(screen.getByLabelText('15m SL distance pts')).toHaveValue('300');
    expect(screen.getByLabelText('5m TGT distance pts')).toHaveValue('0');
    expect(screen.getByLabelText('15m TGT distance pts')).toHaveValue('500');
    fireEvent.change(screen.getByLabelText('15m TGT distance pts'), { target: { value: '200000' } });
    expect(within(group()).getByRole('alert')).toHaveTextContent('The TGT distance for 15m must be from 0 to 100,000 points.');
    expect(screen.getByRole('tab', { name: /^Signals/ })).toContainElement(screen.getByLabelText('has a problem'));
    fireEvent.click(saveButton());
    expect(saveStrategy).not.toHaveBeenCalled();
  });

  it('the TGT alone is said in the sentence; with neither set it says nothing about distance', () => {
    show(single({ minTgtPts: { '5m': 400 } }));
    expect(screen.getByText(/on 5m \+ 15m \(only with the TGT 400\+ pts from the entry on 5m\)/)).toBeInTheDocument();
  });

  it('with no number set the sentence says nothing about it', () => {
    show(single());
    expect(screen.queryByText(/only with the/)).not.toBeInTheDocument();
  });
});

/*
 * 8 Oct 2026: a 300% stop showed as 251% on a $73 entry -- held inside the close-out, which at 200x is a fixed
 * distance over the entry -- and read as a mistake. The form says where the stop can sit, before the trade does.
 */
describe('the stop and the close-out, said under the stop', () => {
  const note = () => screen.queryByRole('note', { name: 'where the stop can sit' });

  it('[critical] a 300% stop: the close-out\'s distance, the premium up to which 300% stands, and a worked richer entry', () => {
    show(signalStrategy({}, { stopMode: 'pct', stopLossPct: 3 }));
    tab('Entry & exit');
    // BTC 85,000: closed out 212.5 over the entry, held at 191.2; 300% fits up to 191.2 / 3 = 63.7.
    expect(note()).toHaveTextContent('At 200x the exchange closes a sold option out $213 above its entry, whatever it was sold for.');
    expect(note()).toHaveTextContent('This stop stands as set on an entry up to $63.7.');
    expect(note()).toHaveTextContent('On a richer one it is held at entry + $191.2, just inside the close-out — sold at $77, the stop is 268.2 (248%), not 308.');
  });

  it('no stop, or a stop typed as a price, has nothing to say; a small points stop stands as set', () => {
    const { unmount } = show(signalStrategy({}, { stopMode: 'pct', stopLossPct: 0 }));
    tab('Entry & exit');
    expect(note()).not.toBeInTheDocument();
    unmount();
    const price = show(signalStrategy({}, { stopMode: 'price', stopLossAt: 120 }));
    tab('Entry & exit');
    expect(note()).not.toBeInTheDocument();
    price.unmount();
    show(signalStrategy({}, { stopMode: 'points', stopLossPoints: 60 }));
    tab('Entry & exit');
    expect(note()).toHaveTextContent('This stop is inside that, and stands as set.');
  });

  it('a bought option has no close-out to be held inside: nothing is said', () => {
    show(signalStrategy({ action: 'buy' }, { stopMode: 'pct', stopLossPct: 0.5 }));
    tab('Entry & exit');
    expect(note()).not.toBeInTheDocument();
  });
});
