import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketInsights } from '@/components/desk/MarketInsights';
import type { MarketRead, OptionStructure, SnapshotMeta } from '@/types/desk';

/**
 * Ten figures in one card.
 *
 * It was a six-figure strip above a four-figure card for a while, and the strip
 * repeated support, resistance, the put/call ratio and max pain out of the card
 * below it — the same number twice on one screen, which is how two figures
 * eventually disagree. They are one card now, and the test that used to pin the
 * *absence* of those four pins their presence instead.
 *
 * An absent figure has to read as absent — a dash — never as a zero. "Max pain
 * 0" and "support 0" are numbers somebody would act on.
 */

const snap = {
  spot: 77_172, expiry: '120926', hoursToExpiry: 20.25, atmIv: 0.298,
  expectedMove: 650, live: true, atm: 77_200,
} as unknown as SnapshotMeta;

const market = { return24h: 0.37 } as unknown as MarketRead;

const structure = {
  oiRange: { low: 74_400, high: 80_000, widthUsd: 5_600, widthPct: 7.26 },
  volPremiumPts: 4.2,
  pcrOi: 0.86,
  maxPain: { strike: 77_600, payoutUsd: 1 },
  ceOiWall: { strike: 80_000, value: 425_600 },
  peOiWall: { strike: 74_400, value: 59_000 },
} as unknown as OptionStructure;

const card = (
  over: Partial<OptionStructure> = {},
  snapOver: Partial<SnapshotMeta> = {},
  mkt: MarketRead | null = market,
) =>
  render(
    <MarketInsights
      structure={{ ...structure, ...over } as OptionStructure}
      snap={{ ...snap, ...snapOver } as SnapshotMeta}
      market={mkt}
    />,
  );

beforeEach(() => localStorage.clear());

describe('market insights', () => {
  it('shows the band, its width and how options are priced', () => {
    card();
    expect(screen.getByText('74,400 – 80,000')).toBeInTheDocument();
    expect(screen.getByText('$5,600')).toBeInTheDocument();
    expect(screen.getByText('+4.2 pts')).toBeInTheDocument();
  });

  it('[critical] does not carry a market lean', () => {
    // Three signals that were each tested and rejected, weighted into one
    // number with no use for it. /api/chain still returns `bias` if it is ever
    // wanted back.
    card();
    expect(screen.queryByText(/leaning/)).not.toBeInTheDocument();
    expect(screen.queryByText('Market lean')).not.toBeInTheDocument();
  });

  it('carries the six figures the strip used to, so nothing is read twice', () => {
    card();
    expect(screen.getByText('77,172 USD')).toBeInTheDocument();   // spot
    expect(screen.getByText('29.8%')).toBeInTheDocument();        // implied volatility
    expect(screen.getByText('0.86')).toBeInTheDocument();         // puts per call
    expect(screen.getByText('74,400')).toBeInTheDocument();       // support
    expect(screen.getByText('80,000')).toBeInTheDocument();       // resistance
    expect(screen.getByText('77,600')).toBeInTheDocument();       // max pain
  });

  it('says how far the day has moved, in dollars as well as percent', () => {
    card();
    expect(screen.getByText(/^\+\d{3} \(\+0\.37%\)$/)).toBeInTheDocument();
  });

  it('marks a fall as a fall', () => {
    card({}, {}, { return24h: -1.4 } as MarketRead);
    expect(screen.getByText(/^−1,0?\d\d \(-1\.40%\)$/)).toBeInTheDocument();
  });

  it('reads more calls open as a lean, rather than leaving a bare ratio', () => {
    card();
    expect(screen.getByText('Bearish')).toBeInTheDocument();
  });

  it('reads more puts open the other way', () => {
    card({ pcrOi: 1.4 });
    expect(screen.getByText('Bullish')).toBeInTheDocument();
  });

  it('says how heavy each wall is, not only where it is', () => {
    card();
    expect(screen.getByText('425.6K open')).toBeInTheDocument();
    expect(screen.getByText('59.0K open')).toBeInTheDocument();
  });

  it('says where max pain sits relative to price, which is the part that means anything', () => {
    card();
    expect(screen.getByText('above spot')).toBeInTheDocument();
  });

  it('says the price is a snapshot when the board is not live', () => {
    card({}, { live: false });
    expect(screen.getByText('BTC at snapshot')).toBeInTheDocument();
  });

  it('[critical] shows a dash where there is no figure, never a zero', () => {
    card(
      { pcrOi: null, maxPain: null, ceOiWall: null, peOiWall: null, oiRange: null, volPremiumPts: null },
      { atmIv: null, expectedMove: null },
      null,
    );
    // implied volatility, puts per call, support, resistance, max pain,
    // the range, its width and the volatility premium
    expect(screen.getAllByText('—')).toHaveLength(8);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('0.00')).not.toBeInTheDocument();
  });

  it('says where BTC sits against the band, which is the part that means anything', () => {
    card();
    expect(screen.getByText('BTC is inside it')).toBeInTheDocument();
  });

  it('says so when BTC has left the band', () => {
    card({ oiRange: { low: 70_000, high: 72_000, widthUsd: 2_000, widthPct: 2.6 } });
    expect(screen.getByText('BTC is above it')).toBeInTheDocument();
  });

  it('[critical] reads a volatility premium as the seller’s case, and a discount against it', () => {
    card();
    expect(screen.getByText('richer than BTC has moved')).toBeInTheDocument();

    localStorage.clear();
    card({ volPremiumPts: -5.9 });
    expect(screen.getByText('-5.9 pts')).toBeInTheDocument();
    expect(screen.getByText('cheaper than BTC has moved')).toBeInTheDocument();
  });

  it('says why the range is missing rather than only dashing it', () => {
    card({ oiRange: null });
    expect(screen.getByText('no open interest to read')).toBeInTheDocument();
  });

  it('says on its face that nothing here is traded on', () => {
    card();
    expect(screen.getByText('For information')).toBeInTheDocument();
  });
});
