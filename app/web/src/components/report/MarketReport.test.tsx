import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DayStats, MarketBreakdownResponse, MarketReportResponse, Row, Tot } from '@/types/market-report';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';

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
  ends: { signal: { best: [row('#1 Breakout', '5m', { n: 40, wins: 30, losses: 10, net: 9_000, won: 12_000, lost: 3_000 })], worst: [] }, real: { best: [BEST], worst: [WORST] } },
  patterns: [
    { key: 'FALSE_BREAKOUT_RANGE', id: 15, name: 'False breakout', meaning: 'Breakout attempt fails', days: ['2026-10-12'], signal: SIGNAL_MON, real: REAL_MON, signalEnds: { best: [], worst: [] }, realEnds: { best: [BEST], worst: [] } },
    { key: 'REVERSAL_ZIGZAG', id: 16, name: 'Reversal', meaning: 'Direction changes repeatedly near a turning point', days: ['2026-10-13'], signal: SIGNAL_TUE, real: REAL_TUE, signalEnds: { best: [], worst: [] }, realEnds: { best: [], worst: [WORST] } },
  ],
  families: [
    { key: 'range', name: 'Range', days: ['2026-10-12'], signal: SIGNAL_MON, real: REAL_MON, signalEnds: { best: [], worst: [] }, realEnds: { best: [BEST], worst: [] } },
    { key: 'turn', name: 'Turn / event', days: ['2026-10-13'], signal: SIGNAL_TUE, real: REAL_TUE, signalEnds: { best: [], worst: [] }, realEnds: { best: [], worst: [WORST] } },
  ],
  catalogue: [
    { id: 15, key: 'FALSE_BREAKOUT_RANGE', name: 'False breakout', meaning: 'Breakout attempt fails', family: 'range' },
    { id: 16, key: 'REVERSAL_ZIGZAG', name: 'Reversal', meaning: 'Direction changes repeatedly near a turning point', family: 'turn' },
  ],
  choices: {
    timeframes: [{ key: '15m', name: '15m' }, { key: '1h', name: '1h' }, { key: 'chain', name: 'With timeframe chain' }],
    methods: [
      { key: 'pd-rejection', name: '#16 Previous day H/L rejection', signal: { n: 120, wins: 70, net: 4_200 }, real: { n: 6, wins: 5, net: 3.1 } },
      { key: 'replenish', name: '#54 Liquidity replenishment', signal: { n: 300, wins: 120, net: -2_750 }, real: { n: 10, wins: 2, net: -11.8 } },
      { key: 'quiet', name: '#70 Never traded', signal: { n: 0, wins: 0, net: 0 }, real: { n: 0, wins: 0, net: 0 } },
    ],
    strategies: [{ key: '15m time', name: '15m time', n: 6, wins: 5, net: 3.1 }, { key: '1h time', name: '1h time', n: 10, wins: 2, net: -11.8 }],
  },
};
const BREAKDOWN: MarketBreakdownResponse = {
  days: ['2026-10-13'],
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
const lastQuery = () => getMarketReport.mock.calls.at(-1)![0];

beforeEach(() => {
  window.localStorage.clear();
  getMarketReport.mockReset(); getMarketBreakdown.mockReset();
  getMarketReport.mockResolvedValue(REPORT);
  getMarketBreakdown.mockResolvedValue(BREAKDOWN);
});

describe('MarketReport', () => {
  it('[critical] asks for every expiry day since 1 Oct to the day in progress, and leads with what stands out in the real orders', async () => {
    show();
    const out = within((await screen.findByText(/What stands out · real orders/)).closest('section, div')!.parentElement!);
    expect(lastQuery()).toEqual({ from: '2026-10-01', to: '2026-10-13', account: null, tfs: [], methods: [], strategies: [] });
    for (const [label, text] of [
      ['Made most on', 'Range days · 1 day'], ['Lost most on', 'Turn / event days · 1 day'],
      ['Exit that paid most', 'Option TGT · 130 trades'], ['Exit that cost most', 'Perp SL · 126 trades'],
      ['Best pair', '#16 Previous day H/L rejection · 15m'], ['Worst pair', '#54 Liquidity replenishment · 1h'],
      ['Best day', 'Mon 12 Oct · False breakout'], ['Worst day', 'Tue 13 Oct · Reversal'],
    ] as const) {
      expect(out.getByText(label)).toBeInTheDocument();
      expect(out.getByText(text)).toBeInTheDocument();
    }
  });

  it('[critical] each expiry day, newest first: its span, its kind and why, and the figures asked for by name', async () => {
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

  it('[critical] by kind of day: the days of each kind, both records, its best and worst pair -- or by family', async () => {
    show();
    const kinds = within(await screen.findByRole('list', { name: 'Market types' }));
    const items = kinds.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const reversal = within(items[1]!);
    expect(reversal.getByRole('heading', { level: 3 })).toHaveTextContent('#16 Reversal');
    expect(reversal.getByText('1 day')).toBeInTheDocument();
    expect(reversal.getByText('Tue 13 Oct')).toBeInTheDocument();
    expect(reversal.getByText('#54 Liquidity replenishment')).toBeInTheDocument();
    expect(within(items[0]!).getByText('#16 Previous day H/L rejection')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /By family/ }));
    const families = within(screen.getByRole('list', { name: 'Trend families' }));
    expect(families.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Range', 'Turn / event']);
  });

  it('[critical] the exits: perp TGT / perp SL / option TGT / option SL with their share -- of the record chosen', async () => {
    show();
    const exits = within(await screen.findByRole('table', { name: 'Which exit closed the trades, real orders' }));
    expect(exits.getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/[+−]₹[\d,.]+/, ''))).toEqual(['Perp TGT237%', 'Perp SL12641%', 'Option TGT13042%', 'Option SL289%']);
    fireEvent.click(screen.getByRole('radio', { name: /Signal history, in BTC perp points/ }));
    const signal = within(screen.getByRole('table', { name: 'Which exit closed the trades, signal history' }));
    expect(signal.getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual(['Perp TGT3,25745%+490,000 pts', 'Perp SL3,99155%−466,172 pts', 'Timed out541%+8,211 pts']);
    expect(screen.getByText(/What stands out · signal history/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Which exit closed the trades, real orders' })).not.toBeInTheDocument();
  });

  it('[critical] a day opened: its exits, its best and worst pairs, by time frame and by strategy -- read for that day alone', async () => {
    show();
    const days = within(await screen.findByRole('region', { name: 'Each expiry day' }));
    expect(getMarketBreakdown).not.toHaveBeenCalled();
    fireEvent.click(days.getAllByRole('button', { name: /Show exits, pairs and time frames/ })[0]!);
    const best = within(await days.findByRole('list', { name: 'Best pairs · real orders' }));
    expect(getMarketBreakdown).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-01', to: '2026-10-13' }), { day: '2026-10-13' });
    expect(best.getByText('#16 Previous day H/L rejection')).toBeInTheDocument();
    expect(within(days.getByRole('list', { name: 'Worst pairs · real orders' })).getByText('#54 Liquidity replenishment')).toBeInTheDocument();
    const byTf = within(days.getByRole('table', { name: 'By time frame, real orders' }));
    expect(byTf.getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/[+−]₹[\d,.]+/, ''))).toEqual(['15m1464%', '1h44 +418%']);
    expect(within(days.getByRole('table', { name: 'By strategy, real orders' })).getByText('1h time')).toBeInTheDocument();
    expect(days.getByRole('table', { name: 'Which exit closed the trades, real orders' })).toBeInTheDocument();
    // a kind of day opens the same way, read for that kind
    fireEvent.click(within(screen.getByRole('list', { name: 'Market types' })).getAllByRole('button', { name: /Show exits, pairs and time frames/ })[1]!);
    await waitFor(() => expect(getMarketBreakdown).toHaveBeenCalledWith(expect.anything(), { pattern: 'REVERSAL_ZIGZAG' }));
  });

  it('[critical] the filters ask again: the range, the time frames, the methods and the strategies -- and are remembered', async () => {
    show();
    await screen.findByText(/What stands out/);
    fireEvent.click(screen.getByRole('radio', { name: 'The last 7 expiry days' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ from: '2026-10-07', to: '2026-10-13' }));
    const tf = within(screen.getByRole('group', { name: 'Time frame' }));
    fireEvent.click(tf.getByRole('button', { name: '1h' }));
    fireEvent.click(tf.getByRole('button', { name: 'TF chain' }));
    await waitFor(() => expect(lastQuery().tfs).toEqual(['1h', 'chain']));
    expect(tf.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tf.getByRole('button', { name: 'All time frames' }));
    await waitFor(() => expect(lastQuery().tfs).toEqual([]));
    expect(JSON.parse(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.endsWith('marketReport.range'))!)!)).toBe('7');
  });

  it('[critical] a custom range: the dates picked in the sheet are the expiry days asked for, shown, changeable and remembered', async () => {
    show();
    await screen.findByText(/What stands out/);
    fireEvent.click(screen.getByRole('radio', { name: 'A range of expiry days of your own' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Custom range' }));
    expect(lastQuery()).toMatchObject({ from: '2026-10-01', to: '2026-10-13' });      // nothing asked until Show
    fireEvent.change(sheet.getByLabelText('From'), { target: { value: '2026-10-05' } });
    fireEvent.change(sheet.getByLabelText('To'), { target: { value: '2026-10-09' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ from: '2026-10-05', to: '2026-10-09' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'A range of expiry days of your own' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Mon 5 Oct → Fri 9 Oct')).toBeInTheDocument();
    expect(screen.getByText(/· 5 days/)).toBeInTheDocument();
    // a day after today is refused in the sheet, in words, and Cancel changes nothing
    fireEvent.click(screen.getByRole('button', { name: 'Change dates' }));
    const again = within(screen.getByRole('dialog', { name: 'Custom range' }));
    expect(again.getByLabelText('From')).toHaveValue('2026-10-05');
    fireEvent.change(again.getByLabelText('To'), { target: { value: '2026-10-20' } });
    expect(again.getByRole('alert')).toHaveTextContent('The To date cannot be after today.');
    expect(again.getByRole('button', { name: 'Show' })).toBeDisabled();
    fireEvent.click(again.getByRole('button', { name: 'Cancel' }));
    expect(lastQuery()).toMatchObject({ from: '2026-10-05', to: '2026-10-09' });
    // remembered: the next visit opens on the same dates
    const keys = Object.keys(window.localStorage);
    expect(JSON.parse(window.localStorage.getItem(keys.find((k) => k.endsWith('marketReport.custom'))!)!)).toEqual({ from: '2026-10-05', to: '2026-10-09' });
    expect(JSON.parse(window.localStorage.getItem(keys.find((k) => k.endsWith('marketReport.range'))!)!)).toBe('custom');
    // and a preset is one tap back
    fireEvent.click(screen.getByRole('radio', { name: 'Every expiry day since 1 October' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ from: '2026-10-01', to: '2026-10-13' }));
    expect(screen.queryByRole('button', { name: 'Change dates' })).not.toBeInTheDocument();
  });

  it('[critical] the methods\' profit and loss: in the list they are chosen from, and in a table of their own -- for the record shown', async () => {
    show();
    await screen.findByText(/What stands out/);
    // the table: in profit and in loss, with closed trades and the win rate
    const profit = within(screen.getByRole('table', { name: 'Methods in profit, real orders' }));
    expect(profit.getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/[+−]₹[\d,.]+/, '₹'))).toEqual(['#16 Previous day H/L rejection683%₹']);
    const loss = within(screen.getByRole('table', { name: 'Methods in loss, real orders' }));
    expect(loss.getAllByRole('row').slice(1).map((r) => r.textContent!.replace(/[+−]₹[\d,.]+/, '₹'))).toEqual(['#54 Liquidity replenishment1020%₹']);
    expect(screen.getByText('2 with a closed trade')).toBeInTheDocument();
    // the list: every method with what it made, green or red; one that never traded says so
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    const list = within(screen.getByRole('listbox'));
    expect(list.getByText(/^6 closed · 83% won · \+₹/)).toBeInTheDocument();
    expect(list.getByText(/^10 closed · 20% won · −₹/)).toBeInTheDocument();
    expect(list.getByText('no order closed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // the strategies' list the same way
    fireEvent.click(screen.getByRole('button', { name: 'Strategy filter: All strategies' }));
    expect(within(screen.getByRole('listbox')).getByText(/^10 closed · 20% won · −₹/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    // the signal history: the same methods in points
    fireEvent.click(screen.getByRole('radio', { name: /Signal history, in BTC perp points/ }));
    expect(within(screen.getByRole('table', { name: 'Methods in profit, signal history' })).getByText('+4,200 pts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    expect(within(screen.getByRole('listbox')).getByText('300 closed · 40% won · −2,750 pts')).toBeInTheDocument();
  });

  it('on the desk it says where it begins, and shows both records\' exits side by side', async () => {
    show(true);
    expect(await screen.findByRole('heading', { level: 2, name: /^Market report/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Which exit closed the trades, real orders' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Which exit closed the trades, signal history' })).toBeInTheDocument();
  });

  it('a day with too little tape is listed and says so; a report that cannot be read says why', async () => {
    getMarketReport.mockResolvedValue({ ...REPORT, days: [{ ...REPORT.days[0]!, bars: 40, stats: null, pattern: null, why: null, family: null }] });
    const { unmount } = show();
    expect(await screen.findByText('Too little of the tape was recorded for this day to measure it (40 minutes).')).toBeInTheDocument();
    expect(screen.getByText('No tape')).toBeInTheDocument();
    unmount();
    getMarketReport.mockRejectedValue(new Error('the desk is restarting'));
    show();
    expect(await screen.findByText('Could not read the market report: the desk is restarting')).toBeInTheDocument();
  });

  it('[critical] on the phone, under More: read for the account the phone is showing', async () => {
    render(<PhoneContext.Provider value={{ now: NOW, accountParam: 2 } as PhoneData}><MarketReportScreen /></PhoneContext.Provider>);
    await screen.findByText(/What stands out/);
    expect(lastQuery()).toMatchObject({ account: 2, from: '2026-10-01', to: '2026-10-13' });
  });
});
