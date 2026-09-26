import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MarketState } from '@/components/desk/MarketState';
import type { MarketStateResponse, StateHistoryRow } from '@/api/desk';

const base: MarketStateResponse = {
  at: Date.UTC(2026, 8, 23, 11, 54),
  tf: '15m',
  bars: 60,
  state: {
    event: 'BREAKOUT_WATCH',
    stage: 'WATCH',
    side: 'UP',
    confirmed: false,
    level: { resistance: 86_800, support: 86_200 },
    against: 86_800,
    distance: -246,
    confidence: 76,
    parts: { levelBreak: 0.3, volume: 1, candle: 0.8, retest: 0, flow: 0.9, mtf: 0.71, regime: 1 },
    checks: [
      { label: 'Close over 86,800', ok: false },
      { label: 'Volume over 1.5x', ok: true },
      { label: 'Open interest building', ok: null },
    ],
    plan: { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 },
    plans: {
      up: { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 },
      down: { side: 'DOWN', trigger: 86_200, target1: 85_800, target2: 85_400, invalidation: 86_600 },
    },
    volumeRatio: 1.8,
    volumeRead: 'STRONG',
    words: 'Price is near resistance. A close over 86,800 is the break.',
    insight: 'If 86,800 breaks and a 15m candle closes above it with volume, the next move is towards 87,200 – 87,600. If it is rejected, watch 86,200 for the short.',
  },
  lines: [],
  context: {
    regime: 'Downtrend',
    volatility: { word: 'Medium', atrPct: 0.24 },
    alignment: { word: 'Bearish (4 of 5)', side: 'DOWN', tfs: [] },
  },
  levels: [
    { label: 'R1', price: 86_800, strength: 'Resistance', side: 'resistance' },
    { label: 'S1', price: 86_200, strength: 'Strong support', side: 'support' },
  ],

  bias: { side: 'UP', strength: 40, up: 7, down: 3, reasons: [{ text: 'higher lows', side: 'UP', weight: 2 }] },
  patterns: {
    all: [],
    shown: [
      { name: 'Ascending Triangle', bias: 'BULLISH', kind: 'structure', note: 'Higher lows into one flat ceiling', barsAgo: 0 },
      { name: 'Hammer', bias: 'BULLISH', kind: 'candle', note: 'A long tail under a fall', barsAgo: 2 },
    ],
  },
  indicators: {
    all: [
      { key: 'trend', label: 'Trend', value: 1, text: 'Rising', read: 'Up', bias: 'BULLISH', gauge: null },
      { key: 'structure', label: 'Structure', value: 1, text: 'Higher highs and lows', read: 'Up', bias: 'BULLISH', gauge: null },
      { key: 'rsi', label: 'RSI (14)', value: 62, text: '62', read: 'Bullish', bias: 'BULLISH', gauge: 0.62 },
      { key: 'macd', label: 'MACD', value: 41, text: '+41', read: 'Bullish', bias: 'BULLISH', gauge: null },
      { key: 'vwap', label: 'VWAP', value: 0.4, text: '+0.4%', read: 'Above', bias: 'BULLISH', gauge: null },
      { key: 'atr', label: 'ATR (14)', value: 0.47, text: '0.47%', read: 'Normal', bias: 'NEUTRAL', gauge: null },
      { key: 'chop', label: 'Choppiness', value: 44, text: '44', read: 'Mixed', bias: 'NEUTRAL', gauge: 0.44 },
    ],
    shown: [
      { key: 'rsi', label: 'RSI (14)', value: 62, text: '62', read: 'Bullish', bias: 'BULLISH', gauge: 0.62 },
      { key: 'volume', label: 'Volume', value: 1.8, text: '1.8x', read: 'Increasing', bias: 'NEUTRAL', gauge: 0.6 },
    ],
  },
  inputs: { atr: 400, oiChangePct: 2.1, cvdSlope: 120, aggressorBuyPct: 58, mtf: { up: 5, down: 2, total: 7 }, regime: 'TREND_UP' },
};

const withState = (over: Partial<MarketStateResponse['state']>): MarketStateResponse =>
  ({ ...base, state: { ...base.state, ...over } });

describe('the market-state card', () => {
  it('[critical] says "likely" for a setup and never calls it confirmed', () => {
    /*
     * The distinction the whole card exists to keep. A watch is a thing that
     * might happen; dressing it like a thing that has is how somebody sells
     * into a level that never broke.
     */
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText(/Breakout likely/)).toBeInTheDocument();
    expect(screen.queryByText(/Breakout confirmed/)).toBeNull();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
  });

  it('[critical] a confirmed break says so, in its own words', () => {
    render(<MarketState data={withState({ event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', confirmed: true })} tf="15m" />);
    expect(screen.getByText('Breakout confirmed')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it('[critical] the number is labelled a score, not a probability', () => {
    // Nothing here is calibrated against history yet, and a number that looks
    // like a probability and is not is worse than no number at all.
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('76')).toBeInTheDocument();
    expect(screen.getByText('score')).toBeInTheDocument();
    expect(screen.queryByText(/76%/)).toBeNull();
    expect(screen.queryByText(/probability/i)).toBeNull();
  });

  it('shows both sides’ plans at once, with the range between them', () => {
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('> 86,800')).toBeInTheDocument();
    expect(screen.getByText('< 86,200')).toBeInTheDocument();
    expect(screen.getByText('86,200 – 86,800')).toBeInTheDocument();
  });

  it('[critical] a reading that could not be taken is not shown as a failed one', () => {
    render(<MarketState data={base} tf="15m" />);
    const checks = screen.getByText('Open interest building').closest('li')!;
    expect(within(checks).getByText('not measured')).toBeInTheDocument();
    expect(checks.className).toContain('is-unknown');
  });


  it('[critical] the whole card is one column: nothing a trade needs is behind a tab', () => {
    /*
     * The card had six tabs and five of them hid an answer to a question being
     * asked elsewhere on the same screen. The targets and the stop were the
     * worst of it: numbers a trade is placed with, a click away.
     */
    const { container } = render(<MarketState data={base} tf="15m" />);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(screen.getByText('87,200')).toBeInTheDocument();
    expect(screen.getByText('86,400')).toBeInTheDocument();
    expect(screen.getAllByText('Stop loss').length).toBe(2);
    expect(screen.getByText('Volume over 1.5x')).toBeInTheDocument();
  });


  it('[critical] the history tallies what came good, as a count and not a percentage', () => {
    // Four calls is not a hit rate, and a percentage would say it was.
    const rows: StateHistoryRow[] = [
      { id: 1, at: base.at, tf: '15m', event: 'BREAKOUT_CONFIRMED', stage: 'CONFIRMED', side: 'UP', confirmed: true, confidence: 76, close: 86_900, plan: null, outcome: 'TARGET_HIT', gradedAt: base.at },
      { id: 2, at: base.at - 3_600_000, tf: '15m', event: 'RANGE', stage: 'RANGE', side: null, confirmed: false, confidence: 62, close: 86_500, plan: null, outcome: 'NOT_GRADED', gradedAt: null },
      { id: 3, at: base.at - 7_200_000, tf: '15m', event: 'REJECTION', stage: 'FAILED', side: 'DOWN', confirmed: true, confidence: 70, close: 86_610, plan: null, outcome: 'INVALIDATED', gradedAt: base.at },
    ];
    const { container } = render(<MarketState data={base} history={rows} hitRate={{ correct: 1, graded: 2 }} tf="15m" />);
    expect(screen.getByText('1 of 2 reached target')).toBeInTheDocument();
    expect(screen.getByText('Target hit')).toBeInTheDocument();
    expect(screen.getByText('Invalidated')).toBeInTheDocument();
    // A range is not a prediction, so it is not marked right or wrong.
    const outcomes = [...container.querySelectorAll('.bt-market-state__hist-out')].map((e) => e.textContent);
    expect(outcomes).toEqual(['Target hit', '—', 'Invalidated']);
    // The word the owner banned from the live screen (24 Sep 2026): a setup
    // that never triggered is not a failure, and most of what it marked had
    // not finished.
    expect(container.textContent).not.toMatch(/wrong/i);
  });

  it('[critical] each earlier call says what BTC did after it', () => {
    /*
     * The question the row is read to answer. Between two calls it is the move
     * to the next one; for the newest it is the move to the price now -- and
     * the colour follows the call, so a fall after a breakdown is green.
     */
    const rows: StateHistoryRow[] = [
      { id: 3, at: base.at, tf: '15m', event: 'BREAKDOWN_CONFIRMED', stage: 'CONFIRMED', side: 'DOWN', confirmed: true, confidence: 70, close: 86_500, plan: null, outcome: 'TARGET_HIT', gradedAt: base.at },
      { id: 2, at: base.at - 3_600_000, tf: '15m', event: 'BREAKOUT_WATCH', stage: 'WATCH', side: 'UP', confirmed: false, confidence: 60, close: 86_300, plan: null, outcome: 'INVALIDATED', gradedAt: base.at },
    ];
    render(<MarketState data={base} history={rows} tf="15m" spot={86_200} />);
    // newest: 86,200 now against 86,500 called -- 300 down, and it was a breakdown
    // A fall after a breakdown call is green: the colour follows the call.
    const newest = screen.getByText('−300 pts');
    expect(newest.className).toContain('is-up');
    expect(screen.getByText('+200 pts').className).toContain('is-up');
  });

  it('[critical] a call names the level it was about and what it was worth', () => {
    /*
     * A breakdown at 86,200 with the target four hundred points under it is a
     * different call from one with forty, and the row said neither.
     */
    const rows: StateHistoryRow[] = [{
      id: 1, at: base.at, tf: '15m', event: 'BREAKDOWN_CONFIRMED', stage: 'CONFIRMED', side: 'DOWN',
      confirmed: true, confidence: 71, close: 86_190,
      plan: { side: 'DOWN', trigger: 86_200, target1: 85_800, target2: 85_400, invalidation: 86_600 },
      outcome: null, gradedAt: null,
    }];
    render(<MarketState data={base} history={rows} tf="15m" />);
    const row = document.querySelector('.bt-market-state__history li')!;
    // Not yet graded says so, rather than reading like a range nobody grades.
    expect(row.textContent).toContain('Waiting');
    // Trigger, target and stop, in the order a call is read.
    expect(row.textContent).toContain('Trigger');
    expect(row.textContent).toContain('86,200');
    expect(row.textContent).toContain('Target');
    expect(row.textContent).toContain('85,800');
    expect(row.textContent).toContain('Stop');
    expect(row.textContent).toContain('86,600');
  });

  it('[critical] a setup waiting on its trigger says how far, not whether it was right', () => {
    /*
     * The bug the owner found on 24 September: a breakout watch whose trigger
     * was never reached was marked WRONG, so the screen filled with red for
     * calls that were never anything but a plan. A call that has not triggered
     * says how far away the trigger is; one that never did says so; and
     * neither is counted for or against.
     */
    const rows: StateHistoryRow[] = [
      { id: 1, at: base.at, tf: '5m', event: 'BREAKOUT_WATCH', stage: 'WATCH', side: 'UP',
        confirmed: false, confidence: 35, close: 84_436,
        plan: { side: 'UP', trigger: 84_532, target1: 84_731, target2: 84_900, invalidation: 84_309 },
        outcome: null, gradedAt: null },
      { id: 2, at: base.at - 900_000, tf: '5m', event: 'BREAKOUT_WATCH', stage: 'WATCH', side: 'UP',
        confirmed: false, confidence: 30, close: 84_373,
        plan: { side: 'UP', trigger: 84_459, target1: 84_653, target2: 84_800, invalidation: 84_220 },
        outcome: 'NOT_TRIGGERED', gradedAt: base.at },
    ];
    const { container } = render(<MarketState data={base} history={rows} tf="5m" spot={84_436} />);
    // The chip is upper-cased by the stylesheet; the text itself is a word.
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('96 pts to trigger')).toBeInTheDocument();
    // Once as the status, once at the end of its own track.
    expect(screen.getAllByText('Not triggered')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/wrong/i);
  });

  it('[critical] today is what the list shows, with every day behind View all', () => {
    /*
     * The list answers "what has the desk called since this morning". A page
     * of yesterday's calls at the top answers a question nobody asked --
     * everything is still there, one click away, with the lot downloadable.
     */
    const now = Date.now();
    const rows: StateHistoryRow[] = [
      { id: 1, at: now, tf: '5m', event: 'BREAKOUT_WATCH', stage: 'WATCH', side: 'UP', confirmed: false,
        confidence: 40, close: 84_400, plan: null, outcome: null, gradedAt: null },
      { id: 2, at: now - 36 * 3_600_000, tf: '5m', event: 'REJECTION', stage: 'FAILED', side: 'DOWN',
        confirmed: true, confidence: 60, close: 84_000, plan: null, outcome: 'TARGET_HIT', gradedAt: now },
    ];
    render(<MarketState data={base} history={rows} tf="5m" />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    // yesterday's call is not in the list on screen
    expect(screen.queryByText(/Resistance rejection/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /View all/ }));
    expect(screen.getByText('2 signals')).toBeInTheDocument();
    expect(screen.getByText(/Resistance rejection/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeInTheDocument();
  });

  it('[critical] shows five calls a page, newest first, and pages back through the rest', () => {
    // Ten rows of small print is a wall nobody reads to the end of.
    const rows: StateHistoryRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, at: base.at - i * 900_000, tf: '15m', event: 'RANGE', stage: 'RANGE',
      side: null, confirmed: false, confidence: 50 + i, close: 86_000 + i, plan: null,
      outcome: 'NOT_GRADED' as const, gradedAt: null,
    }));
    render(<MarketState data={base} history={rows} tf="15m" />);
    expect(screen.getByText('1–5 of 12 signals')).toBeInTheDocument();
    expect(document.querySelectorAll('.bt-market-state__history li')).toHaveLength(5);
    expect(screen.getByText('(50)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Newer calls' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Older calls' }));
    expect(screen.getByText('6–10 of 12 signals')).toBeInTheDocument();
    expect(screen.getByText('(55)')).toBeInTheDocument();
    expect(screen.queryByText('(50)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Older calls' }));
    expect(screen.getByText('11–12 of 12 signals')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Older calls' })).toBeDisabled();
  });

  it('[critical] shows the chart\'s timeframe and does not offer a second switch', () => {
    // Two timeframe controls for one question is two answers on screen the
    // moment they disagree. The chart owns the row; this follows it.
    render(<MarketState data={base} tf="15m" />);
    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1h' })).toBeNull();
  });


  it('[critical] the expiry read and the options bias are on this card, not cards of their own', () => {
    /*
     * They asked the same question this card asks -- which way, and how sure
     * -- from the options board rather than the bars, from two more cards in
     * another column. Three cards for one question is how a screen gets read
     * in the wrong order. They are passed in, so their own logic is untouched.
     */
    render(<MarketState data={base} tf="15m" extra={[
      { label: 'Expiry', node: <p>expiry read</p> },
      { label: 'Options', node: <p>CE / PE bias</p> },
    ]} />);
    // Both are on the card, under the plans, in the order they are read.
    expect(screen.getByText('expiry read')).toBeInTheDocument();
    expect(screen.getByText('CE / PE bias')).toBeInTheDocument();
    expect(screen.getByText('> 86,800')).toBeInTheDocument();
  });

  it('says so rather than breaking when there is no state yet', () => {
    render(<MarketState data={null} tf="15m" />);
    expect(screen.getByText('No state yet.')).toBeInTheDocument();
  });
});
