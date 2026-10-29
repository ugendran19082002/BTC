import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DayStats, MarketBreakdownResponse, MarketReportResponse, Row, Tot } from '@/types/market-report';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';
import { moneyText } from '@/lib/market-report';

/**
 * The market report (owner, 13 Oct 2026): each expiry day's kind of market with its figures -- high, low, zigzag,
 * ATR and its percentile, candle and volatility expansion -- and what the signal history and the real orders
 * made on it, by kind of day, with the exits and the pairs one tap away. On the phone under More, and on the desk.
 */

const getMarketReport = vi.fn();
const getMarketBreakdown = vi.fn();
vi.mock('@/api/market-report', () => ({
  getMarketReport: (...a: unknown[]) => getMarketReport(...a),
  getMarketBreakdown: (...a: unknown[]) => getMarketBreakdown(...a),
}));

const { MarketReport } = await import('@/components/report/MarketReport');
const { MarketReportScreen } = await import('@/components/mobile/screens/MarketReportScreen');

const tot = (o: Partial<Tot> = {}): Tot => ({ n: 0, wins: 0, losses: 0, open: 0, net: 0, won: 0, lost: 0, netR: 0, exits: {}, ...o });
const row = (name: string, tf: string, o: Partial<Tot>): Row => ({ ...tot(o), key: `${name}|${tf}`, name, tf });
const at = (iso: string) => Date.parse(`${iso}+05:30`);
const stats = (o: Partial<DayStats> = {}): DayStats => ({
  bars: 1_440, open: 83_352, close: 83_553, high: 83_574, low: 80_988, highAt: at('2026-10-13T10:20:00'), lowAt: at('2026-10-13T05:55:00'),
  rangePts: 2_586, rangePct: 0.031, netPts: 201, netPct: 0.0024, upPts: 222, downPts: 2_364, dirShare: 0.08, efficiency: 0.02,
  atr: 246, atrPct: 0.003, atrPercentile: 92, volExpansion: 1.55, candleExpansion: 3.2,
  bigCandle: { at: at('2026-10-13T05:30:00'), pts: 780, shareOfRange: 0.3, pctOfPrice: 0.0094, up: false }, lateVsEarly: 1.2,
  zigzag: { thresholdPts: 208, swings: 9, totalPts: 8_181, avgPts: 818, maxUpPts: 2_565, maxDownPts: 1_400, pivots: [] },
  pathRatio: 3.2, counterShare: 0.4, thirds: [{ netPts: -873, rangeShare: 0.39 }, { netPts: -412, rangeShare: 0.53 }, { netPts: 1_486, rangeShare: 1 }],
  highPos: 0.93, lowPos: 0.77, line: [83_352, 83_100, 82_400, 81_000, 82_600, 83_553], ...o,
});

const SIGNAL_TUE = tot({ n: 2_854, wins: 1_313, losses: 1_541, open: 243, net: 98_211, won: 400_000, lost: 301_789, netR: 350, exits: { 'perp-tgt': { n: 1_300, net: 390_000 }, 'perp-sl': { n: 1_500, net: -300_000 }, timeout: { n: 54, net: 8_211 } } });
const REAL_TUE = tot({ n: 151, wins: 63, losses: 88, open: 13, net: -147.4, won: 40, lost: 187.4, exits: { 'option-tgt': { n: 40, net: 30 }, 'perp-tgt': { n: 23, net: 10 }, 'perp-sl': { n: 60, net: -92.4 }, 'option-sl': { n: 28, net: -95 } } });
const REAL_MON = tot({ n: 156, wins: 95, losses: 61, net: 10.66, won: 60, lost: 49.34, exits: { 'option-tgt': { n: 90, net: 50 }, 'perp-sl': { n: 66, net: -39.34 } } });
const SIGNAL_MON = tot({ n: 4_448, wins: 1_957, losses: 2_491, net: -66_172, won: 100_000, lost: 166_172, netR: 190, exits: { 'perp-tgt': { n: 1_957, net: 100_000 }, 'perp-sl': { n: 2_491, net: -166_172 } } });
const sum = (a: Tot, b: Tot): Tot => {
  const exits: Tot['exits'] = {};
  for (const t of [a, b]) for (const [k, v] of Object.entries(t.exits)) { const e = exits[k as keyof Tot['exits']] ?? { n: 0, net: 0 }; exits[k as keyof Tot['exits']] = { n: e.n + v!.n, net: e.net + v!.net }; }
  return tot({ n: a.n + b.n, wins: a.wins + b.wins, losses: a.losses + b.losses, open: a.open + b.open, net: a.net + b.net, won: a.won + b.won, lost: a.lost + b.lost, netR: a.netR + b.netR, exits });
};
const BEST = row('#16 Previous day H/L rejection', '15m', { n: 6, wins: 5, losses: 1, net: 3.1, won: 3.6, lost: 0.5 });
const WORST = row('#54 Liquidity replenishment', '1h', { n: 10, wins: 2, losses: 8, net: -11.8, won: 1, lost: 12.8 });

const REPORT: MarketReportResponse = {
  from: '2026-10-01', to: '2026-10-13',
  days: [
    { day: '2026-10-12', from: at('2026-10-11T17:30:00'), to: at('2026-10-12T17:30:00'), live: false, bars: 1_440, pattern: 'FALSE_BREAKOUT_RANGE', family: 'range',
      why: 'Broke above the early range by 157 pts and closed back inside it: the breakout failed.',
      stats: stats({ high: 84_320, low: 82_982, rangePts: 1_339, netPts: 216, atr: 152, atrPercentile: 23, volExpansion: 0.92, candleExpansion: 4.4, zigzag: { thresholdPts: 208, swings: 11, totalPts: 6_829, avgPts: 569, maxUpPts: 900, maxDownPts: 700, pivots: [] } }),
      signal: SIGNAL_MON, real: REAL_MON },
    { day: '2026-10-13', from: at('2026-10-12T17:30:00'), to: at('2026-10-13T17:30:00'), live: true, bars: 1_030, pattern: 'REVERSAL_ZIGZAG', family: 'turn',
      why: 'Went 2,364 pts down from the open, turned, and took 2,565 pts of it back: a reversal inside a 2,586-pt range.',
      stats: stats(), signal: SIGNAL_TUE, real: REAL_TUE },
  ],
  total: { signal: sum(SIGNAL_MON, SIGNAL_TUE), real: sum(REAL_MON, REAL_TUE) },
  catalogue: [
    { id: 15, key: 'FALSE_BREAKOUT_RANGE', name: 'False breakout', meaning: 'Breakout attempt fails', family: 'range' },
    { id: 16, key: 'REVERSAL_ZIGZAG', name: 'Reversal', meaning: 'Direction changes repeatedly near a turning point', family: 'turn' },
  ],
};
const BREAKDOWN: MarketBreakdownResponse = {
  day: '2026-10-13',
  signal: { total: SIGNAL_TUE, pairs: [row('#1 Breakout', '5m', { n: 40, wins: 30, losses: 10, net: 9_000, won: 12_000, lost: 3_000 })], byTf: [{ ...SIGNAL_TUE, key: '5m', name: '5m' }], byMethod: [], byStrategy: [] },
  real: {
    total: REAL_TUE, pairs: [BEST, WORST],
    byTf: [{ ...tot({ n: 14, wins: 9, losses: 5, net: 0.9 }), key: '15m', name: '15m' }, { ...tot({ n: 44, wins: 8, losses: 36, open: 4, net: -62.5 }), key: '1h', name: '1h' }],
    byMethod: [], byStrategy: [{ ...tot({ n: 44, wins: 8, losses: 36, net: -62.5 }), key: '1h time', name: '1h time' }],
  },
};

// Tue 13 Oct 2026, 11:00 IST
const NOW = at('2026-10-13T11:00:00');
const show = (wide = false) => render(<MarketReport account={null} now={NOW} wide={wide} />);
const lastAsk = () => getMarketReport.mock.calls.at(-1)! as [{ from: string; to: string }, number | null, { from: string; to: string }];

beforeEach(() => {
  window.localStorage.clear();
  getMarketReport.mockReset(); getMarketBreakdown.mockReset();
  getMarketReport.mockResolvedValue(REPORT);
  getMarketBreakdown.mockResolvedValue(BREAKDOWN);
});

describe('MarketReport', () => {
  it('[critical] the report is the expiry days, newest first, and nothing else: asked since 1 Oct to the day in progress', async () => {
    show();
    const days = within(await screen.findByRole('region', { name: 'Each expiry day' }));
    expect(lastAsk()).toEqual([{ from: '2026-10-01', to: '2026-10-13' }, null, { from: '17:31', to: '17:29' }]);
    expect(days.getAllByRole('heading', { level: 3 }).length).toBe(2);
    // the panels that were taken out the day they were built
    for (const gone of [/What stands out/, /By kind of day/, /By method/, 'Market type', 'Trend family']) expect(screen.queryByText(gone)).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Time frame' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Method filter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Signal history, in BTC perp points/ })).not.toBeInTheDocument();   // inside an opened day now
  });

  it('[critical] each expiry day: its span, its kind and why, and the figures asked for by name', async () => {
    show();
    const days = within(await screen.findByRole('region', { name: 'Each expiry day' }));
    const heads = days.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(heads[0]).toMatch(/^Tue 13 Oct expiry.*In progress/);
    expect(heads[1]).toMatch(/^Mon 12 Oct expiry$/);
    expect(days.getByText('Mon 12 Oct 5:30 PM → Tue 13 Oct 5:30 PM IST')).toBeInTheDocument();
    expect(days.getByText('#16 Reversal')).toBeInTheDocument();
    expect(days.getByText('Direction changes repeatedly near a turning point — so far')).toBeInTheDocument();
    expect(days.getByText(/Went 2,364 pts down from the open, turned/)).toBeInTheDocument();
    const tile = (label: string, i = 0) => days.getAllByText(label)[i]!.parentElement!.textContent;
    expect(tile('High')).toBe('High83,574');
    expect(tile('Low')).toBe('Low80,988');
    expect(tile('High − low')).toBe('High − low2,586 pts');
    expect(tile('Zigzag swings')).toBe('Zigzag swings9');
    expect(tile('Zigzag total')).toBe('Zigzag total8,181 pts');
    expect(tile('ATR (15m candles)')).toBe('ATR (15m candles)246 pts');
    expect(tile('ATR percentile')).toBe('ATR percentile92 of 100');
    expect(tile('Candle expansion ratio')).toBe('Candle expansion ratio3.2×');
    expect(tile('Volatility expansion ratio')).toBe('Volatility expansion ratio1.55×');
    expect(tile('Most below the open')).toBe('Most below the open−2,364 pts');
    expect(tile('ATR percentile', 1)).toBe('ATR percentile23 of 100');
    expect(days.getByRole('img', { name: /BTC perp over the Tue 13 Oct expiry day: high 83,574, low 80,988/ })).toBeInTheDocument();
    // both records, each in its own unit
    expect(days.getAllByText(/2,854 closed · 46% won · 243 open ·/)[0]).toBeInTheDocument();
    expect(days.getByText('+98,211 pts')).toBeInTheDocument();
    expect(days.getAllByText(/151 closed · 42% won · 13 open ·/)[0]).toBeInTheDocument();
    // the rest of a day's figures are behind a tap
    expect(days.queryByText('Largest 15m candle')).not.toBeInTheDocument();
    fireEvent.click(days.getAllByRole('button', { name: 'More figures' })[0]!);
    expect(days.getByText('780 pts down at 5:30 AM · 30% of the range')).toBeInTheDocument();
    expect(days.getByText('5:55 AM')).toBeInTheDocument();
  });

  it('[critical] a day opened: its exits, its best and worst pairs, by time frame and by strategy -- of one record, chosen there', async () => {
    show();
    const days = within(await screen.findByRole('region', { name: 'Each expiry day' }));
    expect(getMarketBreakdown).not.toHaveBeenCalled();
    fireEvent.click(days.getAllByRole('button', { name: /Show exits, pairs and time frames/ })[0]!);
    const best = within(await days.findByRole('list', { name: 'Best pairs · real orders' }));
    expect(getMarketBreakdown).toHaveBeenCalledWith('2026-10-13', null, { from: '17:31', to: '17:29' });
    expect(best.getByText('#16 Previous day H/L rejection')).toBeInTheDocument();
    expect(within(days.getByRole('list', { name: 'Worst pairs · real orders' })).getByText('#54 Liquidity replenishment')).toBeInTheDocument();
    const byTf = within(days.getByRole('table', { name: 'By time frame, real orders' }));
    expect(byTf.getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/[+−]₹[\d,.]+/, ''))).toEqual(['15m1464%', '1h44 +418%']);
    expect(within(days.getByRole('table', { name: 'By strategy, real orders' })).getByText('1h time')).toBeInTheDocument();
    // which exit closed them, with its share: perp TGT / perp SL / option TGT / option SL
    const exits = within(days.getByRole('table', { name: 'Which exit closed the trades, real orders' }));
    expect(exits.getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/[+−]₹[\d,.]+/, ''))).toEqual(['Perp TGT2315%', 'Perp SL6040%', 'Option TGT4026%', 'Option SL2819%']);
    // the other record, chosen inside the opened day
    fireEvent.click(days.getByRole('radio', { name: /Signal history, in BTC perp points/ }));
    expect(within(days.getByRole('list', { name: 'Best pairs · signal history' })).getByText('#1 Breakout')).toBeInTheDocument();
    expect(days.queryByRole('table', { name: 'By strategy, real orders' })).not.toBeInTheDocument();
    const signal = within(days.getByRole('table', { name: 'Which exit closed the trades, signal history' }));
    expect(signal.getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual(['Perp TGT1,30046%+390,000 pts', 'Perp SL1,50053%−300,000 pts', 'Timed out542%+8,211 pts']);
  });

  it('[critical] a custom range: the dates picked in the sheet are the expiry days asked for, shown, changeable and remembered', async () => {
    show();
    await screen.findByRole('region', { name: 'Each expiry day' });
    fireEvent.click(screen.getByRole('radio', { name: 'A range of expiry days of your own' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Custom range' }));
    expect(lastAsk()[0]).toEqual({ from: '2026-10-01', to: '2026-10-13' });      // nothing asked until Show
    fireEvent.change(sheet.getByLabelText('From'), { target: { value: '2026-10-05' } });
    fireEvent.change(sheet.getByLabelText('To'), { target: { value: '2026-10-09' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(lastAsk()[0]).toEqual({ from: '2026-10-05', to: '2026-10-09' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Mon 5 Oct → Fri 9 Oct')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change dates' }));
    const again = within(screen.getByRole('dialog', { name: 'Custom range' }));
    fireEvent.change(again.getByLabelText('To'), { target: { value: '2026-10-20' } });
    expect(again.getByRole('alert')).toHaveTextContent('The To date cannot be after today.');
    fireEvent.click(again.getByRole('button', { name: 'Cancel' }));
    const keys = Object.keys(window.localStorage);
    expect(JSON.parse(window.localStorage.getItem(keys.find((k) => k.endsWith('marketReport.custom'))!)!)).toEqual({ from: '2026-10-05', to: '2026-10-09' });
    fireEvent.click(screen.getByRole('radio', { name: 'The last 7 expiry days' }));
    await waitFor(() => expect(lastAsk()[0]).toEqual({ from: '2026-10-07', to: '2026-10-13' }));
  });

  it('[critical] a range changed: "working" at once and the days of the range before greyed, until the new ones come', async () => {
    show();
    await screen.findByRole('region', { name: 'Each expiry day' });
    let answer!: (v: unknown) => void;
    getMarketReport.mockImplementation(() => new Promise((r) => { answer = r; }));
    fireEvent.click(screen.getByRole('radio', { name: 'The last 30 expiry days' }));
    expect(await screen.findByText(/Working out the market report/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Each expiry day' }).closest('.opacity-40')).not.toBeNull();
    answer(REPORT);
    await waitFor(() => expect(screen.queryByText(/Working out the market report/)).not.toBeInTheDocument());
  });

  it('a day with too little tape is listed and says so; a report that cannot be read says why; the desk says where it begins', async () => {
    getMarketReport.mockResolvedValue({ ...REPORT, days: [{ ...REPORT.days[0]!, bars: 40, stats: null, pattern: null, why: null, family: null }] });
    const { unmount } = show();
    expect(await screen.findByText('Too little of the tape was recorded for this day to measure it (40 minutes).')).toBeInTheDocument();
    expect(screen.getByText('No tape')).toBeInTheDocument();
    unmount();
    getMarketReport.mockRejectedValue(new Error('the desk is restarting'));
    const failed = show();
    expect(await screen.findByText('Could not read the market report: the desk is restarting')).toBeInTheDocument();
    failed.unmount();
    getMarketReport.mockResolvedValue(REPORT);
    show(true);
    expect(await screen.findByRole('heading', { level: 2, name: /^Market report/ })).toBeInTheDocument();
  });

  it('[critical] the P&L on top: the real orders\' money over the range after charges, trades, won, the best and worst day; the signal history under it', async () => {
    show();
    const card = within(await screen.findByRole('region', { name: 'P&L of the range' }));
    expect(card.getByText('Whole contract')).toBeInTheDocument();
    expect(card.getByLabelText('Net, after charges')).toHaveTextContent(moneyText(REAL_MON.net + REAL_TUE.net));
    expect(card.getByText(/2 expiry days · every account/)).toBeInTheDocument();
    expect(card.getByText('Trades').nextSibling).toHaveTextContent('307 · 13 open');
    expect(card.getByText('Won').nextSibling).toHaveTextContent('51%');
    expect(card.getByText('Best · Mon 12 Oct').nextSibling).toHaveTextContent(moneyText(REAL_MON.net));
    expect(card.getByText('Worst · Tue 13 Oct').nextSibling).toHaveTextContent(moneyText(REAL_TUE.net));
    expect(card.getByText(/Signal history: 7,302 closed · 45% won · \+32,039 pts/)).toBeInTheDocument();
  });

  it('[critical] the time window: 5:31 PM to 5:29 PM to begin with; changed, applied with a tap, said on each day, kept, and one tap back to the whole contract', async () => {
    const { unmount } = show();
    await screen.findByRole('region', { name: 'Each expiry day' });
    const box = within(screen.getByRole('region', { name: 'Time window' }));
    expect(box.getByLabelText('Trades entered from')).toHaveValue('17:31');
    expect(box.getByLabelText('Trades entered to')).toHaveValue('17:29');
    expect(box.getByText(/5:31 PM → 5:29 PM: the whole contract/)).toBeInTheDocument();
    expect(box.queryByRole('button', { name: 'Apply' })).toBeNull();

    // the end before the start, in the contract's day: said, and not asked for
    fireEvent.change(box.getByLabelText('Trades entered from'), { target: { value: '11:00' } });
    fireEvent.change(box.getByLabelText('Trades entered to'), { target: { value: '07:00' } });
    expect(box.getByRole('alert')).toHaveTextContent(/end comes before the start/);
    expect(box.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.click(box.getByRole('button', { name: 'Cancel' }));
    expect(box.getByLabelText('Trades entered from')).toHaveValue('17:31');

    const asked = getMarketReport.mock.calls.length;
    fireEvent.change(box.getByLabelText('Trades entered from'), { target: { value: '07:00' } });
    fireEvent.change(box.getByLabelText('Trades entered to'), { target: { value: '11:00' } });
    expect(getMarketReport.mock.calls.length).toBe(asked);      // nothing asked while the times are turned
    fireEvent.click(box.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastAsk()[2]).toEqual({ from: '07:00', to: '11:00' }));
    expect(await screen.findAllByText('Trades entered 7:00 AM → 11:00 AM')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: 'P&L of the range' })).getByText('7:00 AM → 11:00 AM')).toBeInTheDocument();

    // kept: the next time it opens, it opens on the window
    unmount();
    show();
    await waitFor(() => expect(lastAsk()[2]).toEqual({ from: '07:00', to: '11:00' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Time window' })).getByRole('button', { name: 'Whole contract' }));
    await waitFor(() => expect(lastAsk()[2]).toEqual({ from: '17:31', to: '17:29' }));
  });

  it('[critical] on the phone, under More: read for the account the phone is showing', async () => {
    render(<PhoneContext.Provider value={{ now: NOW, accountParam: 2 } as PhoneData}><MarketReportScreen /></PhoneContext.Provider>);
    await screen.findByRole('region', { name: 'Each expiry day' });
    expect(lastAsk()).toEqual([{ from: '2026-10-01', to: '2026-10-13' }, 2, { from: '17:31', to: '17:29' }]);
    fireEvent.click(screen.getAllByRole('button', { name: /Show exits, pairs and time frames/ })[0]!);
    await waitFor(() => expect(getMarketBreakdown).toHaveBeenCalledWith('2026-10-13', 2, { from: '17:31', to: '17:29' }));
  });
});
