import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalStrategiesCard } from '@/components/strategy/SignalStrategiesCard';
import { DEFAULT_CONFIG, type Strategy, type StrategyStatus } from '@/types/strategy';
import { blockNow, hoursLabel, istMinuteOf, pickWords } from '@/lib/strategy-blocks';
import { time12 } from '@/lib/time';

const getStrategies = vi.fn();
const saveStrategy = vi.fn();
const setStrategyEnabled = vi.fn();
const getSignalTrades = vi.fn();
const cloneStrategy = vi.fn();
const setSignalMaxOpen = vi.fn();
const setContractMaxLots = vi.fn();
vi.mock('@/api/strategy', () => ({
  setSignalMaxOpen: (...a: unknown[]) => setSignalMaxOpen(...a),
  setContractMaxLots: (...a: unknown[]) => setContractMaxLots(...a),
  cloneStrategy: (...a: unknown[]) => cloneStrategy(...a),
  getStrategies: (...a: unknown[]) => getStrategies(...a),
  getSignalTrades: (...a: unknown[]) => getSignalTrades(...a),
  saveStrategy: (...a: unknown[]) => saveStrategy(...a),
  setStrategyEnabled: (...a: unknown[]) => setStrategyEnabled(...a),
}));
vi.mock('@/api/entry', () => ({
  getEntryMethods: () => Promise.resolve({ methods: [] }),
  getMethodReport: () => Promise.resolve({ tf: null, sections: [], singleByTf: {} }),
  getEntryBoard: () => Promise.resolve({ reads: [], ltp: null }),
}));

/** The signal strategies on the Live screen: the same strategies as the Strategy tab, the signal ones. */

const strat = (id: string, over: Partial<Strategy['config']> = {}, enabled = true): Strategy => ({
  id, name: id.toUpperCase(), enabled, createdAt: 0, updatedAt: 0, lastRunDate: null, ranToday: false,
  nextEntryAt: null, status: 'taking signals until 5:29 PM', config: { ...DEFAULT_CONFIG, ...over },
});
const SIG = { trigger: 'signal' as const, lots: 1, liveOrders: false,
  signal: { mode: 'single' as const, tf: '15m' as const, methods: ['breakout', 'bos'], target: 'tp2' as const, maxOpen: 2 } };
const status = (strategies: Strategy[], over: Partial<StrategyStatus> = {}): StrategyStatus => ({
  today: '2026-10-02', schedulerOn: true, runnerInstalled: true, mode: 'paper', balanceUsd: 228, spot: 85_000,
  strategies, runs: [], signalRuns: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getSignalTrades.mockImplementation(async () => ({ from: null, to: null, trades: (await getStrategies()).signalTrades ?? [] }));
  saveStrategy.mockResolvedValue({ ok: true });
  setStrategyEnabled.mockResolvedValue({ ok: true });
});

describe('signal strategies on the Live screen', () => {
  it('[critical] lists only the signal strategies, each in one line', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG), strat('clock')]));
    render(<SignalStrategiesCard />);
    expect(await screen.findByText('SIG')).toBeInTheDocument();
    expect(screen.queryByText('CLOCK')).toBeNull();
    expect(screen.getByText(/2 methods on 15m · BUY → PE · SELL → CE · .* · 1 lot · perp SL \/ TGT2 \(else TGT1\) · max 2 open · 5:30 AM → 5:29 PM/)).toBeInTheDocument();
    expect(screen.getByText(/writes down what it would sell, sends nothing/)).toBeInTheDocument();
  });

  it('[critical] New opens the form already on signals, on its Signals tab, one lot', async () => {
    getStrategies.mockResolvedValue(status([]));
    render(<SignalStrategiesCard />);
    expect(await screen.findByText(/No signal strategy yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New signal strategy/ }));
    expect(await screen.findByRole('tab', { name: /^Signals/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('radio', { name: 'With the timeframe chain' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'legs' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Strike & lots/ }));
    expect(screen.getByLabelText('lots')).toHaveValue('1');
    expect(screen.getByRole('switch', { name: /^Live orders/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('[critical] live orders on needs a second tap; off is one tap', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)]));
    render(<SignalStrategiesCard />);
    const sw = await screen.findByRole('switch', { name: 'Live orders for SIG' });
    fireEvent.click(sw);
    expect(saveStrategy).not.toHaveBeenCalled();
    expect(sw).toHaveTextContent('Tap again: real orders');
    fireEvent.click(sw);
    await waitFor(() => expect(saveStrategy).toHaveBeenCalledTimes(1));
    expect(saveStrategy.mock.calls[0]![0]).toMatchObject({ id: 'sig', name: 'SIG', config: { liveOrders: true, signal: SIG.signal } });
  });

  it('[critical] live orders off again is one tap', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', { ...SIG, liveOrders: true })]));
    render(<SignalStrategiesCard />);
    const on = await screen.findByRole('switch', { name: 'Live orders for SIG' });
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(on).toHaveTextContent('Live orders ON');
    fireEvent.click(on);
    await waitFor(() => expect(saveStrategy).toHaveBeenCalledTimes(1));
    expect(saveStrategy.mock.calls[0]![0].config.liveOrders).toBe(false);
  });

  it('enable and disable from here', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG, false)]));
    render(<SignalStrategiesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(setStrategyEnabled).toHaveBeenCalledWith('sig', true));
  });

  it('[critical] auto-trading off is said, with the way to the switch', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)], { schedulerOn: false }));
    const go = vi.fn();
    render(<SignalStrategiesCard onOpenStrategyTab={go} />);
    expect(await screen.findByText(/Auto-trading is off, so no signal is taken/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Turn it on on the Strategy tab/ }));
    expect(go).toHaveBeenCalled();
  });

  it('[critical] the trade history is shown; the raw signals log is not', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG), strat('clock')], {
      signalRuns: [
        { id: 1, strategyId: 'sig', signalKey: 'k', method: 'bos', mode: 'single', tf: '15m', dir: -1, status: 'skipped', detail: 'already 7 of its trades open (at most 2)', tradeId: null, at: Date.now() },
      ],
      signalTrades: [{
        id: 2, strategyId: 'sig', at: Date.now(), method: 'bos', mode: 'single', tf: '15m', dir: -1, status: 'would-place',
        detail: '#6 BOS SELL | live orders off: would sell CE 86000 x1 @ 18', tradeId: null,
        levels: { entryLo: 85_000, entryHi: 85_050, stop: 85_400, tp1: 84_500, tp2: null, tp3: null },
        perp: { status: 'filled', fillPrice: 85_040, filledAt: Date.now(), exitPrice: null, exitAt: null }, option: null,
      }],
    }));
    render(<SignalStrategiesCard />);
    const table = await screen.findByRole('table', { name: 'signal trades' });
    // asked of the server for today, by IST day
    expect(getSignalTrades).toHaveBeenCalledWith({ from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(within(table).getByText('#6 BOS SELL')).toBeInTheDocument();
    expect(table).toHaveTextContent('in the trade');
    expect(screen.queryByRole('table', { name: 'signals taken' })).toBeNull();
    expect(screen.queryByText(/already 7 of its trades open/)).toBeNull();
  });
});

describe('copy', () => {
  it('[critical] Copy makes a copy and opens it, its name ready to change -- off, live orders off', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', { ...SIG, liveOrders: true })]));
    cloneStrategy.mockResolvedValue({ ok: true, strategy: { ...strat('sig-copy', { ...SIG, liveOrders: false }, false), name: 'SIG copy' } });
    render(<SignalStrategiesCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy SIG' }));
    await waitFor(() => expect(cloneStrategy).toHaveBeenCalledWith('sig'));
    expect(await screen.findByRole('dialog', { name: 'Edit SIG copy' })).toBeInTheDocument();
    const name = screen.getByLabelText('strategy name');
    expect(name).toHaveValue('SIG copy');
    fireEvent.change(name, { target: { value: 'Breakout 15m only' } });
    expect(name).toHaveValue('Breakout 15m only');
    expect(screen.getByRole('switch', { name: /^Live orders/ })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('at most open at once, across all strategies', () => {
  const field = () => screen.getByLabelText('At most open at once, all strategies');
  const type = (v: string) => { fireEvent.focus(field()); fireEvent.change(field(), { target: { value: v } }); fireEvent.blur(field()); };
  // The owner's five: 3 lots x 1, 5 x 9, 6 x 10, 5 x 7, 3 x 1 -- 28 entries, 146 lots between them.
  const five = () => ([['a', 3, 1], ['b', 5, 9], ['c', 6, 10], ['d', 5, 7], ['e', 3, 1]] as const)
    .map(([id, lots, maxOpen]) => strat(id, { ...SIG, lots, signal: { ...SIG.signal, maxOpen } }));

  beforeEach(() => { setSignalMaxOpen.mockResolvedValue({ ok: true }); });

  it('[critical] sits left of "Auto-trading", shows the desk\'s number and how many are open against it', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 6, openNow: 4 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(field()).toHaveValue('6');
    expect(screen.getByLabelText('open now, of the limit')).toHaveTextContent('4 of 6 open');
    const auto = screen.getByText(/^Auto-trading on$/);
    expect(Boolean(field().compareDocumentPosition(auto) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    // each strategy's own limit is still on its line
    expect(screen.getByText(/max 9 open/)).toBeInTheDocument();
  });

  it('[critical] the strategies are added up: entries, lots, and the margin all of it takes against what is free', async () => {
    getStrategies.mockResolvedValue(status([...five(), strat('off', { ...SIG, lots: 50, signal: { ...SIG.signal, maxOpen: 50 } }, false)], { signalMaxOpen: 0, openNow: 18 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    const sum = screen.getByLabelText('strategies added up');
    // 146 lots x $0.425 a lot = $62.05 = ₹5,274 at ₹85; the account has $228 = ₹19,380 free
    const allow = screen.getByLabelText("the strategies' limits, added up");
    expect(allow).toHaveTextContent(/Strategies allow\s*28 entries\s*5 strategies on\s*146 lots\s*₹5,274(\.\d+)? margin with all of it open/);
    // nothing reported open by this server: all 28 are still to open, against what is free
    const left = screen.getByLabelText('still to open, against the free margin');
    expect(left).toHaveTextContent(/Still to open\s*Fits in the free margin\s*28 entries · 146 lots\s*needs ₹5,274(\.\d+)? more margin — ₹19,380 is free \(27%\)\s*the worst case: the largest lots first/);
    // the bar is the margin still needed against what is free, in rupees
    const bar = within(left).getByRole('progressbar', { name: 'margin still needed, of what is free' });
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['5274', '19380']);
    // ₹36 a lot: $0.425 at ₹85 -- and on a server that sends no figure from Delta, the model alone
    expect(sum).toHaveTextContent(/Margin still needed is estimated at ₹36(\.\d+)? a lot — the desk’s 200x model on BTC now/);
    expect(within(sum).queryByRole('note')).toBeNull();
  });

  it('[critical] with no limit set the field shows what the strategies allow between them -- the limit in force', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 0, openNow: 18 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(field()).toHaveValue('28');
    expect(screen.getByLabelText('open now, of the limit')).toHaveTextContent('all the strategies allow · 18 open');
  });

  it('[critical] a lower limit is saved, and the line says the worst case under it: the largest lots first', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 0, openNow: 3 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    const before = getStrategies.mock.calls.length;
    type('6');
    await waitFor(() => expect(setSignalMaxOpen).toHaveBeenCalledWith(6));
    await waitFor(() => expect(getStrategies.mock.calls.length).toBeGreaterThan(before));
  });

  it('[critical] under a limit of 6 with 3 open on the desk: three places left -- the 6-lot strategy\'s -- and only their margin against what is free', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 6, openNow: 3 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    // 3 x 6 lots = 18 lots x $0.425 = $7.65 = ₹650
    expect(screen.getByLabelText('still to open, against the free margin')).toHaveTextContent(
      /Still to open · under the limit of 6\s*Fits in the free margin\s*3 entries · 18 lots\s*needs ₹650(\.\d+)? more margin — ₹19,380 is free \(3%\)/);
  });

  it('[critical] at the limit: nothing more can open, said as that', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 6, openNow: 6 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    const left = screen.getByLabelText('still to open, against the free margin');
    expect(left).toHaveTextContent(/Still to open · under the limit of 6\s*Nothing — the limit is reached/);
    // nothing to hold against the free margin: no status word and no bar
    expect(left).not.toHaveTextContent(/Fits|Tight|More than is free/);
    expect(within(left).queryByRole('progressbar')).toBeNull();
    expect(within(screen.getByLabelText('strategies added up')).queryByRole('note')).toBeNull();
  });

  it('[critical] open positions are not held against the free margin twice (the owner\'s desk, 4 Oct 2026)', async () => {
    // 54 entries and 265 lots allowed; 12 open using 65 lots; limit 28; ₹3,515 ($41.35) free.
    const mk = (id: string, lots: number, maxOpen: number, trades: number): Strategy =>
      ({ ...strat(id, { ...SIG, lots, signal: { ...SIG.signal, maxOpen } }), open: { trades, lots: trades * lots } });
    const desk = [mk('a', 8, 12, 2), mk('b', 5, 14, 5), mk('c', 6, 10, 3), mk('d', 3, 3, 2), mk('e', 2, 15, 0)];
    getStrategies.mockResolvedValue(status(desk, { signalMaxOpen: 28, openNow: 12, balanceUsd: 3_515 / 85 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(screen.getByLabelText("the strategies' limits, added up")).toHaveTextContent(/54 entries\s*5 strategies on\s*265 lots/);
    // in use is measured against the limit, as the pill says it -- 12 of 28, not 12 of the 54 the strategies allow --
    // and the lots against what is held plus what can still open: 65 + 116
    expect(screen.getByLabelText('in use now, all strategies')).toHaveTextContent(/In use now · of the limit of 28\s*12 of 28 entries\s*65 of 181 lots\s*₹2,34\d(\.\d+)? of ₹6,53\d(\.\d+)? margin/);
    const used = within(screen.getByLabelText('in use now, all strategies')).getByRole('progressbar', { name: 'entries in use, all strategies' });
    expect([used.getAttribute('aria-valuenow'), used.getAttribute('aria-valuemax')]).toEqual(['12', '28']);
    // 16 places left: ten more of the 8-lot strategy (80 lots) and six of the 6-lot one (36) = 116 lots = ₹4,190.
    const left = screen.getByLabelText('still to open, against the free margin');
    expect(left).toHaveTextContent(/under the limit of 28\s*More than is free\s*16 entries · 116 lots\s*needs ₹4,19\d(\.\d+)? more margin — ₹3,515 is free \(119%\)/);
    // that is over what is free, and said -- but as ₹4,190 against ₹3,515, not the whole ₹9,557 against it
    expect(within(screen.getByLabelText('strategies added up')).getByRole('note')).toHaveTextContent('That is more than is free');
    expect(screen.getByLabelText('strategies added up')).not.toHaveTextContent(/272%|159%/);
  });

  it('[critical] a limit above what the strategies allow is refused in words, put back, and not sent', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 0, openNow: 18 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    type('30');
    expect(screen.getByRole('alert')).toHaveTextContent('The strategies switched on allow 28 entries between them, so a limit above 28 changes nothing. Enter 28 or less.');
    expect(field()).toHaveValue('28');
    expect(setSignalMaxOpen).not.toHaveBeenCalled();
  });

  it('[critical] typing the sum back is "no extra limit" again: saved as 0, so it follows the strategies', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 6, openNow: 3 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    type('28');
    await waitFor(() => expect(setSignalMaxOpen).toHaveBeenCalledWith(0));
  });

  it('[critical] unchanged is not sent; blank or over 500 is said and put back; letters cannot be typed', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 6, openNow: 1 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    type('6');
    type('');
    expect(screen.getByText('At most open at once, across all strategies, must be a whole number from 0 (no limit) to 500.')).toBeInTheDocument();
    expect(field()).toHaveValue('6');
    type('501');
    expect(field()).toHaveValue('6');
    expect(setSignalMaxOpen).not.toHaveBeenCalled();
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: '1x2' } });
    expect(field()).toHaveValue('12');
  });

  it('[critical] the state is a word and an icon, not a colour alone: Fits, Tight from 80% of what is free, More than is free past it', async () => {
    const word = async (balanceUsd: number) => {
      getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 0, openNow: 0, balanceUsd }));
      const { unmount } = render(<SignalStrategiesCard />);
      await screen.findByText('A');
      const text = screen.getByLabelText('still to open, against the free margin').textContent ?? '';
      unmount();
      return /More than is free/.test(text) ? 'over' : /Tight/.test(text) ? 'tight' : /Fits in the free margin/.test(text) ? 'fits' : 'none';
    };
    // $62.05 still to open
    expect(await word(228)).toBe('fits');       // 27% of what is free
    expect(await word(70)).toBe('tight');       // 89%
    expect(await word(62.05)).toBe('tight');    // exactly what is free: it fits, with nothing to spare
    expect(await word(60)).toBe('over');        // 103%
  });

  it('[critical] more than is free is said, in red, with what to lower', async () => {
    // $20 free against $62.05 still to open
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 0, openNow: 0, balanceUsd: 20 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(within(screen.getByLabelText('strategies added up')).getByRole('note')).toHaveTextContent(
      'That is more than is free: an order that does not fit is refused at Delta. Lower the limit, the lots, or a strategy\'s own “at most open”.');
  });

  it('the server\'s refusal is shown', async () => {
    setSignalMaxOpen.mockRejectedValue(new Error('The strategies switched on allow 5 entries between them, so a limit above 5 changes nothing. Enter 5 or less.'));
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 6, openNow: 1 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    type('7');
    expect(await screen.findByText(/allow 5 entries between them/)).toBeInTheDocument();
  });

  it('none switched on: nothing to add up, and the field says no limit', async () => {
    getStrategies.mockResolvedValue(status([strat('off', SIG, false)], { signalMaxOpen: 0, openNow: 0 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('OFF');
    expect(screen.queryByLabelText('strategies added up')).toBeNull();
    expect(field()).toHaveValue('0');
    expect(screen.getByLabelText('open now, of the limit')).toHaveTextContent('no limit · 0 open');
  });

  it('an older server that does not send it shows no field', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)]));
    render(<SignalStrategiesCard />);
    await screen.findByText('SIG');
    expect(screen.queryByLabelText('At most open at once, all strategies')).toBeNull();
  });
});

describe('each strategy: its limit, and how much of it is in use now', () => {
  const withOpen = (id: string, lots: number, maxOpen: number, trades: number, enabled = true): Strategy =>
    ({ ...strat(id, { ...SIG, lots, signal: { ...SIG.signal, maxOpen } }, enabled), open: { trades, lots: trades * lots } });
  const usage = (name: string) => screen.getByLabelText(`usage of ${name}`);

  it('[critical] entries, lots and margin, each as "in use of limit", labelled', async () => {
    // 5 lots x at most 9: 45 lots, $19.13 = ₹1,626 of margin; 3 open: 15 lots, ₹542
    getStrategies.mockResolvedValue(status([withOpen('b', 5, 9, 3)], { signalMaxOpen: 0, openNow: 3 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('B');
    expect(usage('B')).toHaveTextContent(/Open now\s*3 of 9/);
    expect(usage('B')).toHaveTextContent(/Lots in use 15 of 45/);
    expect(usage('B')).toHaveTextContent(/Margin in use ₹542(\.\d+)? of ₹1,626/);
    const bar = within(usage('B')).getByRole('progressbar', { name: 'B entries in use' });
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['3', '9']);
    expect(usage('B')).not.toHaveTextContent('at its limit');
  });

  it('[critical] nothing open says 0 of its limit; at the limit says the next signal is skipped', async () => {
    getStrategies.mockResolvedValue(status([withOpen('a', 3, 1, 0), withOpen('e', 3, 1, 1)], { signalMaxOpen: 0, openNow: 1 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(usage('A')).toHaveTextContent(/Open now\s*0 of 1.*Lots in use 0 of 3.*Margin in use ₹0 of ₹108/);
    expect(usage('E')).toHaveTextContent(/Open now\s*1 of 1/);
    expect(usage('E')).toHaveTextContent('at its limit: the next signal is skipped');
  });

  it('[critical] under a desk-wide limit, "in use" is of the limit -- 6 of 28 -- not of everything the strategies allow', async () => {
    // 55 allowed; six open on the desk; the limit is 28
    const desk = [withOpen('a', 6, 20, 3), withOpen('b', 5, 20, 3), withOpen('c', 3, 15, 0)];
    getStrategies.mockResolvedValue(status(desk, { signalMaxOpen: 28, openNow: 6 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    const used = screen.getByLabelText('in use now, all strategies');
    expect(used).toHaveTextContent(/In use now · of the limit of 28\s*6 of 28 entries/);
    expect(used).not.toHaveTextContent('of 55');
    // 33 lots held; 22 places left: 17 more of the 6-lot strategy, then 5 of the 5-lot one = 127 lots; 33 of 160
    expect(used).toHaveTextContent(/33 of 160 lots/);
    expect(screen.getByLabelText("the strategies' limits, added up")).toHaveTextContent(/55 entries/);
  });

  it('with no limit, or one the strategies cannot reach, "in use" is of what the strategies allow', async () => {
    const desk = [withOpen('a', 6, 20, 3), withOpen('b', 5, 20, 3), withOpen('c', 3, 15, 0)];
    getStrategies.mockResolvedValue(status(desk, { signalMaxOpen: 0, openNow: 6 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(screen.getByLabelText('in use now, all strategies')).toHaveTextContent(/In use now\s*6 of 55 entries\s*33 of 265 lots/);
  });

  it('[critical] the header adds the use up: entries, lots and margin in use of what the switched-on strategies allow', async () => {
    getStrategies.mockResolvedValue(status([withOpen('b', 5, 9, 3), withOpen('c', 6, 10, 2), withOpen('a', 3, 1, 0)], { signalMaxOpen: 0, openNow: 5 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('B');
    // 5 of 20 entries; 15 + 12 = 27 of 45 + 60 + 3 = 108 lots; 27 x $0.425 = ₹975 of 108 x $0.425 = ₹3,902
    const used = screen.getByLabelText('in use now, all strategies');
    expect(used).toHaveTextContent(/In use now\s*5 of 20 entries\s*27 of 108 lots\s*₹975(\.\d+)? of ₹3,90\d(\.\d+)? margin/);
    const bar = within(used).getByRole('progressbar', { name: 'entries in use, all strategies' });
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['5', '20']);
  });

  it('a strategy switched off with a position still open shows what it holds', async () => {
    getStrategies.mockResolvedValue(status([withOpen('b', 5, 9, 2, false)], { signalMaxOpen: 0, openNow: 2 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('B');
    expect(usage('B')).toHaveTextContent(/Open now\s*2 of 9.*Lots in use 10 of 45/);
  });

  it('an older server that does not send it shows no usage line', async () => {
    getStrategies.mockResolvedValue(status([strat('sig', SIG)]));
    render(<SignalStrategiesCard />);
    await screen.findByText('SIG');
    expect(screen.queryByLabelText('usage of SIG')).toBeNull();
  });
});

describe('lots and "at most open", changed on the card itself', () => {
  const two = () => [
    strat('a', { ...SIG, lots: 3, signal: { ...SIG.signal, maxOpen: 5 }, liveOrders: true }),
    strat('b', { ...SIG, lots: 5, signal: { ...SIG.signal, maxOpen: 10 } }),
  ];
  const lots = (name: string) => screen.getByLabelText(`Lots per signal for ${name}`);
  const most = (name: string) => screen.getByLabelText(`At most open for ${name}`);
  const type = (el: HTMLElement, v: string) => { fireEvent.focus(el); fireEvent.change(el, { target: { value: v } }); fireEvent.blur(el); };
  const sent = () => saveStrategy.mock.calls.at(-1)![0] as { id: string; name: string; config: Strategy['config'] };

  it('[critical] each strategy shows its own two numbers, the same as in its form', async () => {
    getStrategies.mockResolvedValue(status(two()));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect([lots('A'), most('A'), lots('B'), most('B')].map((el) => (el as HTMLInputElement).value)).toEqual(['3', '5', '5', '10']);
    expect(within(screen.getByRole('group', { name: 'quick settings of A' })).getByText(/saved as you leave the field · from the next signal/)).toBeInTheDocument();
  });

  it('[critical] lots typed and left: that strategy is saved with the new lots and everything else as it was', async () => {
    getStrategies.mockResolvedValue(status(two()));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    type(lots('A'), '4');
    await waitFor(() => expect(saveStrategy).toHaveBeenCalledTimes(1));
    expect(sent().id).toBe('a');
    expect(sent().name).toBe('A');
    expect(sent().config).toEqual({ ...two()[0]!.config, lots: 4 });        // live orders, its limit, its signals: untouched
  });

  it('[critical] at most open typed and Enter pressed: saved on its signal rule, the lots untouched', async () => {
    getStrategies.mockResolvedValue(status(two()));
    render(<SignalStrategiesCard />);
    await screen.findByText('B');
    fireEvent.focus(most('B'));
    fireEvent.change(most('B'), { target: { value: '7' } });
    fireEvent.keyDown(most('B'), { key: 'Enter' });
    fireEvent.blur(most('B'));
    await waitFor(() => expect(saveStrategy).toHaveBeenCalledTimes(1));
    expect(sent().id).toBe('b');
    expect(sent().config.signal).toEqual({ ...two()[1]!.config.signal, maxOpen: 7 });
    expect(sent().config.lots).toBe(5);
  });

  it('[critical] 0 lots, 0 or 101 open, or blank: said in the form\'s own words, put back, and not sent', async () => {
    getStrategies.mockResolvedValue(status(two()));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    type(lots('A'), '0');
    expect(screen.getByRole('alert')).toHaveTextContent('Lots must be a whole number, at least 1.');
    expect(lots('A')).toHaveValue('3');
    type(most('A'), '101');
    expect(screen.getByRole('alert')).toHaveTextContent('At most 1 to 100 of its trades open at once.');
    expect(most('A')).toHaveValue('5');
    type(most('A'), '0');
    type(lots('A'), '');
    expect(lots('A')).toHaveValue('3');
    expect(saveStrategy).not.toHaveBeenCalled();
  });

  it('unchanged is not sent, and letters cannot be typed', async () => {
    getStrategies.mockResolvedValue(status(two()));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    type(lots('A'), '3');
    type(most('A'), '5');
    expect(saveStrategy).not.toHaveBeenCalled();
    fireEvent.focus(lots('A'));
    fireEvent.change(lots('A'), { target: { value: '1a2' } });
    expect(lots('A')).toHaveValue('12');
  });

  it('the server\'s refusal is shown, and the field goes back to the saved number on the next read', async () => {
    saveStrategy.mockRejectedValue(new Error('Lots must be a whole number, at least 1.'));
    getStrategies.mockResolvedValue(status(two()));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    type(lots('A'), '9');
    expect(await screen.findByRole('alert')).toHaveTextContent('Lots must be a whole number, at least 1.');
    await waitFor(() => expect(lots('A')).toHaveValue('3'));
  });

  it('[critical] the form still has both: Edit opens it with the same numbers', async () => {
    getStrategies.mockResolvedValue(status(two()));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    fireEvent.click(screen.getAllByRole('button', { name: /Edit/ })[0]!);
    fireEvent.click(await screen.findByRole('tab', { name: /^Strike & lots/ }));
    const form = within(screen.getByRole('dialog'));
    expect(form.getByLabelText(/^lots/i)).toHaveValue('3');
    fireEvent.click(screen.getByRole('tab', { name: /^Entry & exit/ }));
    expect(form.getByLabelText('max open')).toHaveValue('5');
  });
});

describe('the desk\'s other limits and Delta\'s own figures, on the summary', () => {
  const mk = (id: string, lots: number, maxOpen: number, trades: number): Strategy =>
    ({ ...strat(id, { ...SIG, lots, signal: { ...SIG.signal, maxOpen } }), open: { trades, lots: trades * lots } });
  // The owner's desk at 3:27 PM, 4 Oct: 22 open, 110 lots short of a limit of 116, the open-trades limit 28.
  const desk = () => [mk('a', 6, 15, 8), mk('b', 5, 10, 5), mk('c', 5, 20, 5), mk('d', 3, 5, 3), mk('e', 3, 5, 1), mk('f', 4, 10, 2)];
  const live = (over: Partial<StrategyStatus> = {}) =>
    status(desk(), { signalMaxOpen: 28, openNow: 24, shortCap: 116, shortNow: 110, walletUsd: 110, marginUsedUsd: 66, balanceUsd: 44, mode: 'live', ...over });

  it('[critical] "still to open" is held to the lots the short limit leaves: one 6-lot entry, not the six places the open-trades limit would give', async () => {
    getStrategies.mockResolvedValue(live());
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    const left = screen.getByLabelText('still to open, against the free margin');
    expect(left).toHaveTextContent(/1 entry · 6 lots/);
    expect(within(left).getByLabelText('held by the limit on lots short')).toHaveTextContent(
      'held to 6 more lots by the desk\'s limit of 116 short (110 now): an entry past it is refused');
  });

  it('[critical] no room under the short limit is said as that, with the numbers -- not as "fits"', async () => {
    getStrategies.mockResolvedValue(live({ shortNow: 115 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    const left = screen.getByLabelText('still to open, against the free margin');
    expect(left).toHaveTextContent('Nothing — the desk\'s limit of 116 lots short leaves no room (115 now)');
    expect(left).not.toHaveTextContent(/Fits|Tight/);
  });

  it('[critical] the margin in use is Delta\'s own figure where Delta gives it, and the lots short are said against their limit', async () => {
    getStrategies.mockResolvedValue(live());
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    const used = screen.getByLabelText('in use now, all strategies');
    // $66 = ₹5,610
    expect(within(used).getByLabelText("margin in use, Delta's figure")).toHaveTextContent('₹5,610 margin in use — Delta\'s own figure');
    expect(within(used).getByLabelText("lots short, of the desk's limit")).toHaveTextContent('110 of 116 lots short — the desk\'s limit');
    expect(used).not.toHaveTextContent('the desk\'s estimate');
  });

  it('[critical] what is still needed is priced at Delta\'s rate when it is dearer than the model, and says so', async () => {
    getStrategies.mockResolvedValue(live());
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    // Delta: $66 over 110 lots = $0.60 a lot = ₹51; the model is ₹36. Six lots: ₹306.
    expect(screen.getByLabelText('strategies added up')).toHaveTextContent(/Margin still needed is estimated at ₹51(\.\d+)? a lot — the dearer of the desk’s 200x model and what Delta is charging per lot now\./);
    expect(screen.getByLabelText('still to open, against the free margin')).toHaveTextContent(/needs ₹306(\.\d+)? more margin — ₹3,740 is free \(8%\)/);
  });

  it('on paper, where Delta gives no figure, the margin in use is the desk\'s estimate and says so', async () => {
    getStrategies.mockResolvedValue(live({ walletUsd: null, marginUsedUsd: null, mode: 'paper' }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    const used = screen.getByLabelText('in use now, all strategies');
    expect(used).toHaveTextContent(/margin — the desk's estimate/);
    expect(within(used).queryByLabelText("margin in use, Delta's figure")).toBeNull();
  });

  it('[critical] the running build is on the card: its tag and since when', async () => {
    getStrategies.mockResolvedValue(live({ build: { tag: '66c14eb-dirty-070123', startedAt: Date.UTC(2026, 9, 4, 7, 3) } }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(screen.getByLabelText('server build')).toHaveTextContent(/Server build 66c14eb-dirty-070123 · running since 4 Oct,? 12:33 pm IST/i);
  });

  it('a server run by hand says it has no tag; an older server shows no build line', async () => {
    getStrategies.mockResolvedValue(live({ build: { tag: null, startedAt: Date.UTC(2026, 9, 4, 7, 3) } }));
    const { unmount } = render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(screen.getByLabelText('server build')).toHaveTextContent('not tagged (run by hand)');
    unmount();
    getStrategies.mockResolvedValue(live());
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(screen.queryByLabelText('server build')).toBeNull();
  });
});

describe('the strike rule in force now, on each strategy\'s row', () => {
  // A window covering the whole day but one minute, so whenever this runs the clock is inside it.
  const allDay = { entryTime: '00:00', exitTime: '23:59' };
  const blocks = ['03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'].map((at, i) => ({
    at, strikeRule: 'premium' as const, strikeStep: 0, premium: { mode: 'atMost' as const, usd: 40 - i, fallbackUsd: null, minOtm: 2 + i, elseOtm: 3 + i },
  }));
  const now = (name: string) => screen.getByLabelText(`strike rule now of ${name}`);

  it('[critical] a strategy split by time of day says the block the clock is in, until when, and the rule a signal is sold under now', async () => {
    const s = strat('day', { ...SIG, ...allDay, strikeRule: 'premium', premium: { mode: 'atMost', usd: 50, fallbackUsd: 75 }, strikeBlocks: blocks });
    getStrategies.mockResolvedValue(status([s]));
    render(<SignalStrategiesCard />);
    await screen.findByText('DAY');
    const b = blockNow(s.config, istMinuteOf(Date.now()))!;
    expect(b.of).toBe(8);
    expect(now('DAY')).toHaveTextContent(`Block ${b.n} of 8`);
    expect(now('DAY')).toHaveTextContent(`${time12(b.from)} → ${time12(b.until)}`);
    expect(now('DAY')).toHaveTextContent(`sells ${pickWords(b.pick)}`);
    expect(now('DAY')).toHaveTextContent(/^Now/);
    expect(now('DAY')).toHaveTextContent(/\d+ (h|min)( \d+ min)? left/);
    if (b.next) expect(now('DAY')).toHaveTextContent(`then block ${b.next.n} at ${time12(b.next.at)}: ${pickWords(b.next.pick)}`);
    else expect(now('DAY')).not.toHaveTextContent('then block');
    // sanity: the words carry the block's own numbers, not block 1's
    if (b.n > 1) expect(now('DAY')).toHaveTextContent(`≤ $${40 - (b.n - 2)} at OTM ${2 + (b.n - 2)} or further, else OTM ${3 + (b.n - 2)}`);
    expect(hoursLabel(b.minutesLeft).length).toBeGreaterThan(0);
  });

  it('[critical] one rule all the time says that, with the rule', async () => {
    const s = strat('one', { ...SIG, ...allDay, strikeRule: 'premium', premium: { mode: 'atMost', usd: 50, fallbackUsd: 75, minOtm: 12, elseOtm: 12 } });
    getStrategies.mockResolvedValue(status([s]));
    render(<SignalStrategiesCard />);
    await screen.findByText('ONE');
    expect(now('ONE')).toHaveTextContent('NowSame rule all the timesells ≤ $50 (if none, ≤ $75) at OTM 12 or further, else OTM 12');
    expect(now('ONE')).not.toHaveTextContent(/Block \d/);
  });

  it('a by-strike rule is said as its strike', async () => {
    const s = strat('fix', { ...SIG, ...allDay, strikeRule: 'strict', strikeStep: 4 });
    getStrategies.mockResolvedValue(status([s]));
    render(<SignalStrategiesCard />);
    await screen.findByText('FIX');
    expect(now('FIX')).toHaveTextContent('sells OTM 4');
  });

  it('[critical] outside its window it says so, and when it starts again', async () => {
    // a one-minute window that this minute is not in (it is moved off the current minute)
    const m = istMinuteOf(Date.now());
    const hh = (x: number) => `${String(Math.floor((x % 1440) / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    const s = strat('shut', { ...SIG, entryTime: hh(m + 120), exitTime: hh(m + 180) });
    getStrategies.mockResolvedValue(status([s]));
    render(<SignalStrategiesCard />);
    await screen.findByText('SHUT');
    expect(now('SHUT')).toHaveTextContent(`Outside its window now — the next signal is taken from ${time12(hh(m + 120))}.`);
  });
});

describe('the limit on one contract', () => {
  const field = () => screen.getByLabelText('At most lots on one contract, all strategies');

  it('[critical] shows the limit and the contract holding the most now, and saves a new one when the field is left', async () => {
    setContractMaxLots.mockResolvedValue({ ok: true, contractMaxLots: 12 });
    getStrategies.mockResolvedValue(status(five(), { contractMaxLots: 20, contractMostNow: { symbol: 'P-BTC-84600-041026', lots: 15 } }));
    render(<SignalStrategiesCard />);
    await waitFor(() => expect(field()).toHaveValue('20'));
    expect(screen.getByLabelText('lots on the fullest contract now')).toHaveTextContent(/lots\s*·\s*PE 84,600 holds 15/);
    fireEvent.change(field(), { target: { value: '12' } });
    fireEvent.blur(field());
    await waitFor(() => expect(setContractMaxLots).toHaveBeenCalledWith(12));
  });

  it('[critical] no limit is 0 and says so; a number out of range is said and never sent', async () => {
    getStrategies.mockResolvedValue(status(five(), { contractMaxLots: 0, contractMostNow: null }));
    render(<SignalStrategiesCard />);
    await waitFor(() => expect(field()).toHaveValue('0'));
    expect(screen.getByLabelText('lots on the fullest contract now')).toHaveTextContent(/0 is no limit\s*·\s*none open/);
    fireEvent.change(field(), { target: { value: '99999' } });
    fireEvent.blur(field());
    expect(await screen.findByText('At most lots on one contract must be a whole number from 0 (no limit) to 10,000.')).toBeInTheDocument();
    expect(setContractMaxLots).not.toHaveBeenCalled();
  });

  it('an older server that does not send the limit shows no field for it', async () => {
    getStrategies.mockResolvedValue(status(five(), {}));
    render(<SignalStrategiesCard />);
    await screen.findByLabelText('At most open at once, all strategies');
    expect(screen.queryByLabelText('At most lots on one contract, all strategies')).not.toBeInTheDocument();
  });
});
