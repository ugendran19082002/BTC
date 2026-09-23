import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarketPanel } from '@/components/desk/MarketPanel';
import type { MarketStateResponse } from '@/api/desk';

const data: MarketStateResponse = {
  at: Date.UTC(2026, 8, 23, 11, 54),
  tf: '15m',
  bars: 60,
  state: {
    event: 'BREAKOUT_WATCH', stage: 'WATCH', side: 'UP', confirmed: false,
    level: { resistance: 86_800, support: 86_200 }, against: 86_800, distance: -246, confidence: 76,
    parts: { levelBreak: 0.3, volume: 1, candle: 0.8, retest: 0, flow: 0.9, mtf: 0.71, regime: 1 },
    checks: [{ label: 'Close over 86,800', ok: false }],
    plan: { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 },
    plans: {
      up: { side: 'UP', trigger: 86_800, target1: 87_200, target2: 87_600, invalidation: 86_400 },
      down: { side: 'DOWN', trigger: 86_200, target1: 85_800, target2: 85_400, invalidation: 86_600 },
    },
    volumeRatio: 1.8, volumeRead: 'STRONG',
    words: 'Price is near resistance.',
    insight: 'If 86,800 breaks, the next move is towards 87,200.',
  },
  patterns: { all: [], shown: [{ name: 'Ascending Triangle', bias: 'BULLISH', kind: 'structure', note: 'Higher lows', barsAgo: 0 }] },
  indicators: { all: [], shown: [{ key: 'rsi', label: 'RSI (14)', value: 62, text: '62', read: 'Neutral', bias: 'NEUTRAL', gauge: 0.62 }] },
  inputs: { atr: 400, oiChangePct: 2.1, cvdSlope: 120, aggressorBuyPct: 58, mtf: { up: 5, down: 2, total: 7 }, regime: 'TREND_UP' },
};

describe('the chart-and-analysis panel', () => {
  it('[critical] the chart and everything read off it are in one card', () => {
    /*
     * Four cards for one thought put a frame between the level on the chart
     * and the same level in the plan, and on a phone the plan had scrolled out
     * of sight by the time you reached it.
     */
    const { container } = render(
      <MarketPanel chart={<div data-testid="chart" />} data={data} tf="15m" />,
    );
    const panel = container.querySelector('.bt-analysis')!;
    expect(panel.querySelector('[data-testid="chart"]')).toBeTruthy();
    expect(panel.textContent).toContain('Ascending Triangle');
    expect(panel.textContent).toContain('RSI (14)');
    expect(panel.textContent).toContain('If 86,800 breaks');
    expect(panel.textContent).toContain('Breakout likely');
    expect(panel.textContent).toContain('87,200');
    // One card, not five: the pieces inside give up their own chrome.
    expect(container.querySelectorAll('.bt-card')).toHaveLength(1);
  });

  it('shows the chart alone on a past date, where there is no live state', () => {
    render(<MarketPanel chart={<div data-testid="chart" />} data={null} tf="15m" ready={false} />);
    expect(screen.getByTestId('chart')).toBeInTheDocument();
    expect(screen.queryByText('Pattern detection')).toBeNull();
  });

  it('still draws the strip while the first state is being fetched', () => {
    render(<MarketPanel chart={<div data-testid="chart" />} data={null} tf="15m" />);
    expect(screen.getByText('Nothing named on these bars.')).toBeInTheDocument();
    expect(screen.getByText('No state yet.')).toBeInTheDocument();
  });
});
