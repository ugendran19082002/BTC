import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FocusSummary } from './FocusSummary';
import type { ExpiryPath, MomentumSignal } from '@/types/live';

const path = (over: Partial<ExpiryPath> = {}): ExpiryPath => ({
  spot: 82_000,
  hoursToExpiry: 6.5,
  rows: [],
  settlement: {
    label: 'expiry', minutes: 390, interpolated: false, windows: 1000,
    medianUsd: 300, p68Usd: 500, p95Usd: 900, low68: 81_500, high68: 82_500,
    low95: 81_100, high95: 82_900, impliedUsd: null, pUp: 0.5, leanUsd: 0,
  },
  directionEdgePct: 0.4,
  sampleWindows: 1000,
  sampleDays: 30,
  watch: 'BOTH',
  note: 'Direction is not measured as an edge.',
  ...over,
});

const momentum = (over: Partial<MomentumSignal> = {}): MomentumSignal => ({
  state: 'CONFIRMED', tf: '5m', side: 'DOWN', level: 82_000, atr: 100, at: Date.now(),
  plan: { entry: 81_900, stop: 82_200, target: 81_300, rr: 2, riskPts: 300, rewardPts: 600, policy: 'wide' },
  measured: null, verdict: 'INFORMATIONAL', compression: null,
  headline: 'Break confirmed below support', warnings: [], ...over,
});

describe('FocusSummary', () => {
  it('puts the measured expiry range and no-guarantee language first', () => {
    render(<FocusSummary path={path()} momentum={momentum()} />);
    expect(screen.getByText('81,100 – 82,900')).toBeInTheDocument();
    expect(screen.getByText(/not a guaranteed arrow/i)).toBeInTheDocument();
    expect(screen.getByText('wait / information')).toBeInTheDocument();
  });

  it('shows entry, stop, and target only when a confirmed plan exists', () => {
    render(<FocusSummary path={null} momentum={momentum({ verdict: 'TRADEABLE' })} />);
    expect(screen.getByText('81,900')).toBeInTheDocument();
    expect(screen.getByText('82,200')).toBeInTheDocument();
    expect(screen.getByText('81,300')).toBeInTheDocument();
    expect(screen.getByText('tradeable')).toBeInTheDocument();
    expect(screen.getByText(/No measured settlement band/i)).toBeInTheDocument();
  });
});
