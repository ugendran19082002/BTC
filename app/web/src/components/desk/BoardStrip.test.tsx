import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoardStrip } from '@/components/desk/BoardStrip';
import type { MarketRead, OptionStructure, SnapshotMeta } from '@/types/desk';

/**
 * The strip exists so six figures can be read without opening a card. What is
 * tested is that each one is on screen, and that an absent figure reads as
 * absent — a dash — rather than as a zero, because "max pain 0" and "support 0"
 * are numbers somebody would act on.
 */

const snap = {
  spot: 77_172, expiry: '120926', hoursToExpiry: 20.25, atmIv: 0.298,
  expectedMove: 650, live: true, atm: 77_200,
} as unknown as SnapshotMeta;

const structure = {
  pcrOi: 0.86,
  maxPain: { strike: 77_600, payoutUsd: 1234 },
  ceOiWall: { strike: 80_000, value: 425_600 },
  peOiWall: { strike: 74_400, value: 59_000 },
} as unknown as OptionStructure;

const market = { return24h: 0.37 } as unknown as MarketRead;

const strip = (over: {
  snap?: Partial<SnapshotMeta>;
  structure?: Partial<OptionStructure>;
  market?: MarketRead | null;
} = {}) =>
  render(
    <BoardStrip
      snap={{ ...snap, ...over.snap } as SnapshotMeta}
      structure={{ ...structure, ...over.structure } as OptionStructure}
      market={over.market === undefined ? market : over.market}
    />,
  );

describe('the board strip', () => {
  it('carries all six figures', () => {
    strip();
    expect(screen.getByText('77,172 USD')).toBeInTheDocument();   // spot
    expect(screen.getByText('29.8%')).toBeInTheDocument();        // implied volatility
    expect(screen.getByText('0.86')).toBeInTheDocument();         // puts per call
    expect(screen.getByText('74,400')).toBeInTheDocument();       // support
    expect(screen.getByText('80,000')).toBeInTheDocument();       // resistance
    expect(screen.getByText('77,600')).toBeInTheDocument();       // max pain
  });

  it('says how far the day has moved, in dollars as well as percent', () => {
    strip();
    // 0.37% of a 77,172 spot is about $284, and both halves are on the tile
    expect(screen.getByText(/^\+\d{3} \(\+0\.37%\)$/)).toBeInTheDocument();
  });

  it('marks a fall as a fall', () => {
    strip({ market: { return24h: -1.4 } as MarketRead });
    expect(screen.getByText(/^−1,0?\d\d \(-1\.40%\)$/)).toBeInTheDocument();
  });

  it('[critical] shows a dash where there is no figure, never a zero', () => {
    strip({
      snap: { atmIv: null, expectedMove: null } as Partial<SnapshotMeta>,
      structure: { pcrOi: null, maxPain: null, ceOiWall: null, peOiWall: null } as Partial<OptionStructure>,
      market: null,
    });
    // implied volatility, puts per call, support, resistance and max pain
    expect(screen.getAllByText('—')).toHaveLength(5);
    expect(screen.queryByText('0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('reads more calls open as a lean, rather than leaving a bare ratio', () => {
    strip();
    expect(screen.getByText('Bearish')).toBeInTheDocument();
  });

  it('reads more puts open the other way', () => {
    strip({ structure: { pcrOi: 1.4 } as Partial<OptionStructure> });
    expect(screen.getByText('Bullish')).toBeInTheDocument();
  });

  it('says how heavy each wall is, not only where it is', () => {
    strip();
    expect(screen.getByText('425.6K open')).toBeInTheDocument();
    expect(screen.getByText('59.0K open')).toBeInTheDocument();
  });

  it('says where max pain sits relative to price, which is the part that means anything', () => {
    strip();
    expect(screen.getByText('above spot')).toBeInTheDocument();
  });

  it('falls back to the contract and its hours when there is no move to report', () => {
    strip({ market: null });
    expect(screen.getAllByText('120926 · 20.3h left').length).toBeGreaterThan(0);
  });

  it('says the price is a snapshot when the board is not live', () => {
    strip({ snap: { live: false } as Partial<SnapshotMeta> });
    expect(screen.getByText('BTC at snapshot')).toBeInTheDocument();
  });
});
