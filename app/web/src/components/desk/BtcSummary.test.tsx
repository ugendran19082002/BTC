import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BtcSummary, HOLD_BARS, holding } from '@/components/desk/BtcSummary';
import type { Candle, MarketRead, OptionStructure, Outlook, SnapshotMeta } from '@/types/desk';

/** BTC at a glance, beside the chart: what is known, said once, and the past marked as the past. */

const snap = { spot: 76_230, atmIv: 0.28, expiryTs: 1_789_212_600, hoursToExpiry: 11, live: true } as unknown as SnapshotMeta;
const market = { return24h: 0.41 } as unknown as MarketRead;
const structure = {
  peOiWall: { strike: 72_800, value: 1 }, ceOiWall: { strike: 78_400, value: 1 },
  // what the screens draw: the heaviest within reach of spot
  peOiWallNear: { strike: 72_800, value: 1 }, ceOiWallNear: { strike: 78_400, value: 1 },
  wallWithinEm: 2,
} as unknown as OptionStructure;
const outlook = { rows: [{ label: '5m', impliedUsd: 69, score: 0.45, why: 'EMAs rising' }] } as unknown as Outlook;
const bar = (low: number): Candle => ({ time: 0, open: low + 50, high: low + 90, low, close: low + 60, volume: 1 });
const bars = Array.from({ length: 20 }, () => bar(76_100));

const show = (over: Partial<Parameters<typeof BtcSummary>[0]> = {}) =>
  render(<BtcSummary snap={snap} market={market} structure={structure} outlook={outlook} bars={bars} tf="5m" {...over} />);

describe('the BTC summary', () => {
  it('[critical] says the spot and its 24h move, in dollars and percent', () => {
    show();
    expect(screen.getByText('76,230')).toBeInTheDocument();
    expect(screen.getByText(/\+311 \+0\.41%/)).toBeInTheDocument();
  });

  it('says the expiry and the time left', () => {
    show();
    expect(screen.getByText('11h 00m left')).toBeInTheDocument();
  });

  it('[critical] the expected move follows the chart timeframe', () => {
    show();
    expect(screen.getByText('Expected move (5m)')).toBeInTheDocument();
    expect(screen.getByText(/±0\.09%/)).toBeInTheDocument();   // 69 / 76,230
    expect(screen.getByText('(≈ ±$69)')).toBeInTheDocument();
  });

  it('1m has no outlook card, so the move is worked out from the volatility', () => {
    show({ tf: '1m' });
    // 76,230 × 0.28 × √(1 / 525,600) ≈ $29
    expect(screen.getByText('(≈ ±$29)')).toBeInTheDocument();
  });

  it('[critical] both walls, with how far away they are', () => {
    show();
    expect(screen.getByText('72,800')).toBeInTheDocument();
    expect(screen.getByText('(−4.5%)')).toBeInTheDocument();
    expect(screen.getByText('78,400')).toBeInTheDocument();
    expect(screen.getByText('(+2.8%)')).toBeInTheDocument();
  });

  it('[critical] the chart status is the past, and holding above is a fact about recent bars', () => {
    show();
    expect(screen.getByText('Bullish (past)')).toBeInTheDocument();
    expect(screen.getByText(`Holding above 76,000 over the last ${HOLD_BARS} bars`)).toBeInTheDocument();
    expect(holding([bar(75_950), ...bars], 76_230)).toEqual({ level: 76_000, held: true });  // the dip is older than the window
    expect(holding([...bars, bar(75_950)], 76_230)).toEqual({ level: 76_000, held: false });
    expect(holding([], 76_230)).toBeNull();
  });

  it('says what the levels are, and what they are not', () => {
    show();
    expect(screen.getByText(/not where BTC will settle/)).toBeInTheDocument();
  });

  it('[critical] folds to its title and the spot price, and remembers it', () => {
    localStorage.clear();
    const { unmount } = show();
    fireEvent.click(screen.getByRole('button', { name: /BTC summary/ }));
    expect(screen.queryByText(/not where BTC will settle/)).toBeNull();
    unmount();
    show();
    expect(screen.getByRole('button', { name: /BTC summary/ })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: /BTC summary/ }));
    expect(screen.getByText(/not where BTC will settle/)).toBeInTheDocument();
  });

  /*
   * 18 September: "Resistance 89,000" with BTC at 76,723 — the heaviest call
   * open interest on the whole chain, about eleven expected moves away. Real
   * open interest, and not a level. The card draws the near wall, and when
   * there is none it says so instead of reaching further out.
   */
  it('[critical] a wall out of reach is never drawn as a level', () => {
    show({ structure: {
      peOiWall: { strike: 60_000, value: 1 }, ceOiWall: { strike: 89_000, value: 1 },
      peOiWallNear: null, ceOiWallNear: null, wallWithinEm: 2,
    } as unknown as OptionStructure });
    expect(screen.queryByText(/89,000 \(/)).toBeNull();
    expect(screen.getAllByText('none near')).toHaveLength(2);
    expect(screen.getByText((_, el) => /heaviest 89,000, \+1[0-9]\.[0-9]%/.test(el?.textContent ?? ''), { selector: 'small' }))
      .toBeInTheDocument();
  });

  it('says the band the levels are looked for in', () => {
    show();
    expect(screen.getByText(/within 2 expected moves of spot/)).toBeInTheDocument();
  });
});
