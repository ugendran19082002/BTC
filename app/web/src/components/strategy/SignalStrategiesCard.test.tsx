import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SignalStrategiesCard } from '@/components/strategy/SignalStrategiesCard';
import { DEFAULT_CONFIG, type Strategy, type StrategyStatus } from '@/types/strategy';

const getStrategies = vi.fn();
const saveStrategy = vi.fn();
const setStrategyEnabled = vi.fn();
const getSignalTrades = vi.fn();
const cloneStrategy = vi.fn();
const setSignalMaxOpen = vi.fn();
vi.mock('@/api/strategy', () => ({
  setSignalMaxOpen: (...a: unknown[]) => setSignalMaxOpen(...a),
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
    expect(sum).toHaveTextContent(/Limits: 5 strategies on · up to 28 entries at once · 146 lots · ₹5,274(\.\d+)? margin with all of it open/);
    // nothing reported open by this server: all 28 are still to open, against what is free
    expect(screen.getByLabelText('still to open, against the free margin')).toHaveTextContent(
      /Still to open: up to 28 entries · 146 lots · needs ₹5,274(\.\d+)? more margin — ₹19,380 is free \(27%\)/);
    expect(sum).toHaveTextContent('Margin is the desk\'s estimate at 200x on BTC now');
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
      /Still to open under the limit of 6: up to 3 entries · 18 lots · needs ₹650(\.\d+)? more margin — ₹19,380 is free \(3%\)\. The worst case: the largest lots first\./);
  });

  it('[critical] at the limit: nothing more can open, said as that', async () => {
    getStrategies.mockResolvedValue(status(five(), { signalMaxOpen: 6, openNow: 6 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('A');
    expect(screen.getByLabelText('still to open, against the free margin')).toHaveTextContent('Still to open under the limit of 6: nothing — the limit is reached.');
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
    expect(screen.getByLabelText('strategies added up')).toHaveTextContent(/up to 54 entries at once · 265 lots/);
    expect(screen.getByLabelText('in use now, all strategies')).toHaveTextContent(/12 of 54 entries · 65 of 265 lots/);
    // 16 places left: ten more of the 8-lot strategy (80 lots) and six of the 6-lot one (36) = 116 lots = ₹4,190.
    const left = screen.getByLabelText('still to open, against the free margin');
    expect(left).toHaveTextContent(/under the limit of 28: up to 16 entries · 116 lots · needs ₹4,19\d(\.\d+)? more margin — ₹3,515 is free \(119%\)/);
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

  it('[critical] the header adds the use up: entries, lots and margin in use of what the switched-on strategies allow', async () => {
    getStrategies.mockResolvedValue(status([withOpen('b', 5, 9, 3), withOpen('c', 6, 10, 2), withOpen('a', 3, 1, 0)], { signalMaxOpen: 0, openNow: 5 }));
    render(<SignalStrategiesCard />);
    await screen.findByText('B');
    // 5 of 20 entries; 15 + 12 = 27 of 45 + 60 + 3 = 108 lots; 27 x $0.425 = ₹975 of 108 x $0.425 = ₹3,902
    expect(screen.getByLabelText('in use now, all strategies')).toHaveTextContent(/In use now: 5 of 20 entries · 27 of 108 lots · ₹975(\.\d+)? of ₹3,90\d(\.\d+)? margin/);
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
