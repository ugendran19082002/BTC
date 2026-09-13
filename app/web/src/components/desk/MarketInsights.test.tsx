import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketInsights } from '@/components/desk/MarketInsights';
import type { Bias, OptionStructure, SnapshotMeta } from '@/types/desk';

/**
 * The card carries what the summary strip above it does not.
 *
 * The first version repeated support, resistance, the put/call ratio and max
 * pain — all four already on the strip — so the same figure appeared twice on
 * one screen. The test below pins the absence, because a duplicate is the kind
 * of thing that gets added back by someone being helpful.
 */

const snap = { spot: 77_172, hoursToExpiry: 20.25 } as unknown as SnapshotMeta;

const structure = {
  oiRange: { low: 74_400, high: 80_000, widthUsd: 5_600, widthPct: 7.26 },
  volPremiumPts: 4.2,
  pcrOi: 0.86,
  maxPain: { strike: 77_600, payoutUsd: 1 },
  ceOiWall: { strike: 80_000, value: 425_600 },
  peOiWall: { strike: 74_400, value: 59_000 },
} as unknown as OptionStructure;

const bias = {
  score: 0.05,
  label: 'not leaning either way',
  components: [{}, {}, {}],
} as unknown as Bias;

const card = (over: Partial<OptionStructure> = {}) =>
  render(
    <MarketInsights
      structure={{ ...structure, ...over } as OptionStructure}
      bias={bias}
      snap={snap}
    />,
  );

beforeEach(() => localStorage.clear());

describe('market insights', () => {
  it('shows the band, its width, the lean and how options are priced', () => {
    card();
    expect(screen.getByText('74,400 – 80,000')).toBeInTheDocument();
    expect(screen.getByText('$5,600')).toBeInTheDocument();
    expect(screen.getByText('not leaning either way')).toBeInTheDocument();
    expect(screen.getByText('+4.2 pts')).toBeInTheDocument();
  });

  it('[critical] repeats nothing that is already on the strip above it', () => {
    card();
    for (const duplicated of ['77,600', '0.86', 'Max pain', 'Support zone', 'Resistance zone']) {
      expect(screen.queryByText(duplicated)).not.toBeInTheDocument();
    }
  });

  it('says where BTC sits against the band, which is the part that means anything', () => {
    card();
    expect(screen.getByText(/BTC is inside it/)).toBeInTheDocument();
  });

  it('says so when BTC has left the band', () => {
    card({ oiRange: { low: 70_000, high: 72_000, widthUsd: 2_000, widthPct: 2.6 } });
    expect(screen.getByText(/BTC is above it/)).toBeInTheDocument();
  });

  it('[critical] reads a volatility premium as the seller’s case, and a discount against it', () => {
    card();
    expect(screen.getByText(/priced richer than BTC has actually moved/)).toBeInTheDocument();

    localStorage.clear();
    card({ volPremiumPts: -5.9 });
    expect(screen.getByText('-5.9 pts')).toBeInTheDocument();
    expect(screen.getByText(/the seller is being underpaid/)).toBeInTheDocument();
  });

  it('shows a dash, not a zero, where there is nothing to read', () => {
    card({ oiRange: null, volPremiumPts: null });
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getByText('no open interest to read')).toBeInTheDocument();
  });

  it('says on its face that nothing here is traded on', () => {
    card();
    expect(screen.getByText('For information')).toBeInTheDocument();
    expect(screen.getByText(/none held up in all three/)).toBeInTheDocument();
  });
});
