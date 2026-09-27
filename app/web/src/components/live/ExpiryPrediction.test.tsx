import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExpiryPredictionCard } from './ExpiryPrediction';
import type { ExpiryPrediction } from '@/types/live';

const SPOT = 84_595;
const target = (label: 'T1' | 'T2' | 'T3', side: 'UP' | 'DOWN', away: number, pTouch: number, from: 'typical' | '68%' | '95%') => ({
  label, side, price: side === 'UP' ? SPOT + away : SPOT - away,
  movePct: ((side === 'UP' ? away : -away) / SPOT) * 100, pTouch, from,
});

const pred = (over: Partial<ExpiryPrediction> = {}): ExpiryPrediction => ({
  spot: SPOT, hoursToExpiry: 20.6,
  band: { low: 84_000, high: 85_200, widthPct: 1.42, pInside: 0.64, pBelow: 0.18, pAbove: 0.18 },
  targets: [
    target('T1', 'UP', 600, 0.28, 'typical'), target('T2', 'UP', 1000, 0.20, '68%'), target('T3', 'UP', 2800, 0.12, '95%'),
    target('T1', 'DOWN', 600, 0.26, 'typical'), target('T2', 'DOWN', 1000, 0.18, '68%'), target('T3', 'DOWN', 2800, 0.10, '95%'),
  ],
  bandMeasured: true,
  note: 'Range from 1,05,119 measured windows; the percentage is Black–Scholes at 25.3% IV.',
  ...over,
});

describe('the expiry prediction', () => {
  it('[critical] the range is the headline, with its probability beside it', () => {
    const { container } = render(<ExpiryPredictionCard prediction={pred()} />);
    // Twice on purpose — the headline and the bar's own label — so scope to the headline.
    const headline = container.querySelector('b.font-mono');
    expect(headline).toHaveTextContent('84,000 – 85,200');
    expect(screen.getByText(/64% probability/)).toBeVisible();
  });

  it('[critical] measured and modelled are labelled apart, never merged', () => {
    render(<ExpiryPredictionCard prediction={pred()} />);
    // The range is badged measured; the percentage is badged modelled. Both words
    // must appear, and they must not be on the same element.
    const measured = screen.getAllByText(/measured/);
    const modelled = screen.getAllByText(/modelled/);
    expect(measured.length).toBeGreaterThan(0);
    expect(modelled.length).toBeGreaterThan(0);
    for (const m of measured) expect(m.textContent).not.toMatch(/modelled/);
  });

  it('[critical] a band that is not measured is badged modelled, not measured', () => {
    render(<ExpiryPredictionCard prediction={pred({ bandMeasured: false, note: 'No measured horizons.' })} />);
    // The provenance badge on the range must read modelled…
    expect(screen.getAllByText('modelled').length).toBeGreaterThan(0);
    // …and nothing may claim the range was measured.
    expect(screen.queryByText(/^measured · n=/)).not.toBeInTheDocument();
  });

  it('[critical] the split adds to one and is drawn as below / inside / above', () => {
    render(<ExpiryPredictionCard prediction={pred()} />);
    const bar = screen.getByRole('img', { name: /below 18%, inside 64%, above 18%/ });
    expect(bar).toBeVisible();
  });

  it('every rung names the measured percentile it came from', () => {
    render(<ExpiryPredictionCard prediction={pred()} />);
    expect(screen.getAllByText('typical')).toHaveLength(2);
    expect(screen.getAllByText('68%')).toHaveLength(2);
    expect(screen.getAllByText('95%')).toHaveLength(2);
  });

  it('[critical] the last column is touch odds, and the card says it is not finish odds', () => {
    render(<ExpiryPredictionCard prediction={pred()} />);
    expect(screen.getByText(/chance of being/)).toHaveTextContent(/touched/);
    expect(screen.getByText(/not of finishing through/)).toBeVisible();
  });

  it('[critical] the card explains why the ladder is symmetric', () => {
    render(<ExpiryPredictionCard prediction={pred()} />);
    expect(screen.getByText(/gives no\s+direction at any horizon/)).toBeVisible();
  });

  it('no IV means no probability shown, not a zero', () => {
    const p = pred({ band: { low: 84_000, high: 85_200, widthPct: 1.42, pInside: null, pBelow: null, pAbove: null } });
    render(<ExpiryPredictionCard prediction={p} />);
    expect(screen.queryByText(/probability/)).not.toBeInTheDocument();
    expect(screen.getByText('84,000 – 85,200')).toBeVisible();
  });

  it('nothing to predict says so rather than drawing an empty range', () => {
    render(<ExpiryPredictionCard prediction={null} />);
    expect(screen.getByText(/No measured horizons are loaded/)).toBeVisible();
  });

  it('time to settlement reads in hours and minutes', () => {
    render(<ExpiryPredictionCard prediction={pred()} />);
    expect(screen.getByText('20h 36m left')).toBeVisible();
  });
});
