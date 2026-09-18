import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SuddenMove, expiresIn, horizonWords, trendWords } from '@/components/desk/SuddenMove';
import type {
  MarketRead, OptionStructure, Outlook, OutlookRow, SnapshotMeta, SuddenMove as Shock,
} from '@/types/desk';

/**
 * Sudden move analytics, laid out after the 17 September design.
 *
 * What the layout must not cost: every reading still shows the two numbers
 * behind its headline; a reading the desk cannot take says so instead of a zero;
 * the odds are measured and say over which window; the trend is marked as the
 * past; and nothing trades on any of it.
 */

const snap = {
  ts: 1_789_000_000, spot: 76_382, atmIv: 0.281, expectedMove: 832, live: true,
  expiry: '170926', hoursToExpiry: 3.2,
} as unknown as SnapshotMeta;

const structure = {
  pcrOi: 0.34, pcrVolume: 0.76, ceOi: 9_000_000, peOi: 3_400_000, ceVolume: 60_000, peVolume: 40_000,
  ceOiWall: { strike: 82_400, value: 318_400 }, peOiWall: { strike: 72_800, value: 278_400 },
  gammaWall: null, atmIv: 0.28, ivSkewPts: null, volPremiumPts: -4.2,
  maxPain: { strike: 76_000, payoutUsd: 1_000 },
  oiRange: { low: 72_800, high: 82_400, widthUsd: 9_600, widthPct: 12.6 },
  ranges: [],
} as unknown as OptionStructure;

const market = { return24h: 0.41, high24h: 76_548, low24h: 75_033 } as unknown as MarketRead;

const shock = (over: Partial<Shock> = {}): Shock => ({
  score: 12,
  band: 'normal',
  parts: [
    { name: 'Move against expected', value: 0.1, weight: 0.3, note: '', detail: { headline: '0.4×', now: '5m range: 0.33%', before: 'Expected (5m): 0.83%' } },
    { name: 'Volume spike', value: 0, weight: 0.25, note: '', detail: { headline: '1.0×', now: 'Current: 3.9k', before: '20-bar median: 3.8k' } },
    { name: 'Volatility repricing', value: 0, weight: 0.2, note: null, detail: null },
  ],
  reasons: [],
  direction: 0,
  directionLabel: 'no clear side',
  directionParts: [],
  odds: { overMinutes: 60, thresholdPct: 1, up: 0.09, down: 0.10, inside: 0.81, either: 0.19, typicalPct: 0.63, outerPct: 1.40 },
  window: 60,
  ...over,
});

const row = (over: Partial<OutlookRow> = {}): OutlookRow => ({
  label: '1h', minutes: 60, spot: 76_382, impliedUsd: 241, low: 76_141, high: 76_623,
  measured68Pct: 0.32, measured95Pct: 0.9, measuredLow: null, measuredHigh: null,
  below: 0.16, inside: 0.68, above: 0.16, pUp: 0.5, richness: 1.0, priced: 'fair',
  score: 0.19, lean: 'flat', why: 'EMAs rising, RSI 55', isExpiry: false,
  factors: [
    { key: 'ema', label: 'EMA (9/21/50)', contribution: 0.30 },
    { key: 'rsi', label: 'RSI (14)', contribution: 0.12 },
    { key: 'structure', label: 'Swing structure', contribution: -0.12 },
    { key: 'vwap', label: 'Price vs VWAP', contribution: -0.11 },
  ],
  ...over,
});

const outlook = (rows: OutlookRow[] = [row()]) => ({ rows } as unknown as Outlook);

const panel = (over: Partial<Shock> = {}, o: Outlook | null = outlook(), onWindow = () => {}) =>
  render(<SuddenMove shocks={[shock(over)]} window={60} onWindow={onWindow} snap={snap} structure={structure} market={market} outlook={o} />);

describe('the header', () => {
  it('[critical] draws nothing at all when it could not take a single reading', () => {
    const { container } = panel({ score: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the window, the time left, the risk and when it was read', () => {
    panel({ score: 58, band: 'high' });
    expect(screen.getByRole('combobox', { name: 'reading window' })).toHaveValue('60');
    expect(screen.getByText('Expires in 3h 12m')).toBeInTheDocument();
    expect(screen.getAllByText('High risk').length).toBeGreaterThan(0);
    expect(screen.getByText('Last updated')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('[critical] choosing a window asks for it rather than fetching', () => {
    const onWindow = vi.fn();
    render(<SuddenMove shocks={[shock({ window: 5 }), shock({ window: 240 })]} window={5} onWindow={onWindow} snap={snap} structure={structure} market={market} outlook={outlook()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'reading window' }), { target: { value: '240' } });
    expect(onWindow).toHaveBeenCalledWith(240);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['5 MINUTES', '4 HOURS']);
  });

  it('falls back to the first reading when the stored window is not offered', () => {
    render(<SuddenMove shocks={[shock({ window: 5 })]} window={999} onWindow={() => {}} snap={snap} structure={structure} market={market} />);
    expect(screen.getByRole('combobox', { name: 'reading window' })).toHaveValue('5');
  });

  it('time left reads as a clock, and a settled contract says so', () => {
    expect(expiresIn(3.2)).toBe('3h 12m');
    expect(expiresIn(0.5)).toBe('30m');
    expect(expiresIn(0)).toBe('settled');
    expect(horizonWords(60)).toBe('1 hour');
    expect(horizonWords(240)).toBe('4 hours');
  });
});

describe('the answer', () => {
  it('[critical] the risk ring carries the score and the band, and says what the band means', () => {
    panel({ score: 72, band: 'high' });
    expect(screen.getByRole('img', { name: '72 out of 100' })).toBeInTheDocument();
    expect(screen.getByText('Abnormal move possible in the next few hours')).toBeInTheDocument();
  });

  it('[critical] a raised score beside calm odds says both, in words', () => {
    panel({ score: 58, band: 'high', odds: { overMinutes: 5, thresholdPct: 1, up: 0.01, down: 0.01, inside: 0.98, either: 0.02, typicalPct: 0.06, outerPct: 0.3 } });
    expect(screen.getByText(/Busier than usual — but over the next 5 minutes a 1% move has/)).toBeInTheDocument();
    expect(screen.getByText('98 in 100')).toBeInTheDocument();
  });

  it('names what is raised, and stays quiet when nothing is', () => {
    const { container, unmount } = panel();
    expect(container.querySelector('.smx-reasons')).toBeNull();
    unmount();
    panel({ score: 78, band: 'sudden', reasons: ['5m volume is 4.0× its median'] });
    expect(screen.getByText('5m volume is 4.0× its median')).toBeInTheDocument();
  });

  it('[critical] the probability outlook is measured, adds to a hundred, and prices its thresholds', () => {
    panel();
    const card = within(screen.getByLabelText('probability outlook'));
    const shown = ['Down', 'Sideways ±1%', 'Up'].map((w) => Number(card.getByText(w).previousSibling!.textContent!.replace('%', '')));
    expect(shown).toEqual([10, 81, 9]);
    expect(shown.reduce((a, v) => a + v, 0)).toBe(100);
    // spot 76,382 ± 1%
    expect(card.getByText('< 75,618')).toBeInTheDocument();
    expect(card.getByText('75,618 – 77,146')).toBeInTheDocument();
    expect(card.getByText('> 77,146')).toBeInTheDocument();
    expect(card.getByText(/over the next 1 hour, measured/)).toBeInTheDocument();
    // The line is said, so 81% here cannot be read against the outlook cards' 33%.
    expect(card.getByText(/a ±1% line, not the outlook cards’ narrower band/)).toBeInTheDocument();
    expect(card.getByText('±0.63%')).toBeInTheDocument();
  });

  it('with no measured odds the outlook says so rather than drawing a bar', () => {
    panel({ odds: null });
    expect(screen.getByText('No measured odds for this window.')).toBeInTheDocument();
  });
});

describe('why', () => {
  it('[critical] pricing against history: the ratio, the word, and both moves in dollars', () => {
    panel();
    const card = within(screen.getByLabelText('pricing vs history'));
    expect(card.getByText('1.00×')).toBeInTheDocument();
    expect(card.getByText('FAIR')).toBeInTheDocument();
    expect(card.getByText('±$241')).toBeInTheDocument();
    expect(card.getByText('±$244')).toBeInTheDocument();   // 76,382 × 0.32%
    expect(card.getByText('Options are priced fairly for this timeframe.')).toBeInTheDocument();
  });

  it('cheap pricing says what it costs a seller', () => {
    panel({}, outlook([row({ richness: 0.87, priced: 'cheap' })]));
    expect(screen.getByText('CHEAP')).toBeInTheDocument();
    expect(screen.getByText(/a seller is paid less than the usual risk/)).toBeInTheDocument();
  });

  it('[critical] every reading carries the two numbers behind its headline', () => {
    panel();
    for (const t of ['5m range: 0.33%', 'Expected (5m): 0.83%', 'Current: 3.9k', '20-bar median: 3.8k']) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });

  it('[critical] a reading it cannot take says so rather than showing a zero', () => {
    panel();
    expect(screen.getByText('No reading yet')).toBeInTheDocument();
    expect(screen.getByText('The desk records one every five minutes')).toBeInTheDocument();
    expect(screen.queryByText('+0.0%')).toBeNull();
  });

  it('[critical] the trend score is marked as the past', () => {
    panel();
    const card = within(screen.getByLabelText('trend score'));
    expect(card.getByText('+0.19')).toBeInTheDocument();
    expect(card.getByText('NEUTRAL')).toBeInTheDocument();
    expect(card.getByText('Slightly bullish (past)')).toBeInTheDocument();
    expect(trendWords(0.7).words).toBe('Strongly bullish (past)');
    expect(trendWords(-0.4)).toMatchObject({ badge: 'BEARISH', words: 'Bearish (past)' });
    expect(trendWords(null).badge).toBe('NO CHART');
  });

  it('[critical] the key factors show each part of the score, signed', () => {
    panel();
    const card = within(screen.getByLabelText('key factors'));
    expect(card.getByText('EMA (9/21/50)').parentElement).toHaveTextContent('+0.30');
    expect(card.getByText('Price vs VWAP').parentElement).toHaveTextContent('−0.11');
  });

  it('options flow stays, as one line under the factors', () => {
    panel({ direction: -0.68, directionParts: [{ name: 'Call against put activity', value: -0.61 }] });
    const line = screen.getByText('Options flow: downside 68%');
    expect(line.getAttribute('title')).toMatch(/Call against put activity: −0\.61/);
  });

  it('without the outlook row the cards say there is nothing to show', () => {
    panel({}, null);
    expect(screen.getByText('Nothing to compare for 1h')).toBeInTheDocument();
    expect(screen.getByText('No chart to break down')).toBeInTheDocument();
  });
});

describe('where price sits', () => {
  it('[critical] the range line puts spot between the thresholds the odds counted', () => {
    panel();
    const card = within(screen.getByLabelText('price range'));
    expect(card.getByText('Price range (1H)')).toBeInTheDocument();
    expect(card.getByText('75,618')).toBeInTheDocument();
    expect(card.getByText('77,146')).toBeInTheDocument();
    expect(card.getByText('76,382')).toBeInTheDocument();
    expect(card.getByText(/Expected move ±\$241/)).toBeInTheDocument();
  });

  it('[critical] the board numbers carry splits, not invented changes', () => {
    panel();
    const card = within(screen.getByLabelText('board numbers'));
    expect(card.getByText('28.1%')).toBeInTheDocument();
    expect(card.getByText('1,00,000')).toBeInTheDocument();
    expect(card.getByText('contracts · calls 60%')).toBeInTheDocument();
    expect(card.getByText('12,400 BTC')).toBeInTheDocument();      // 12.4M contracts × 0.001
    expect(card.getByText(/0\.34 puts per call · more calls open/)).toBeInTheDocument();
    expect(card.getByText('72,800 – 82,400')).toBeInTheDocument();
    expect(screen.queryByText(/[+−-]\d+%$/)).toBeNull();
  });

  it('says on its face that nothing trades on it', () => {
    panel();
    expect(screen.getByText(/Nothing on the trading side reads any of this/)).toBeInTheDocument();
  });
});
