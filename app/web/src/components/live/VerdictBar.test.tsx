import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerdictBar } from './VerdictBar';
import type { Ladder, Readiness, LiveResponse } from '@/types/live';

const NOW = 1_790_500_000_000;

const ladder = (over: Partial<Ladder> = {}): Ladder => ({
  rows: [], tiers: {}, score: -12, normalised: -0.63, bias: 'DOWN',
  alignment: 0.68, text: '5 of 8 frames · 14 of 19 weight', against: [], ...over,
});

const ready = (over: Partial<Readiness> = {}): Readiness =>
  ({ ready: true, side: 'DOWN', blockers: [], ...over });

const stability = (over: Partial<NonNullable<LiveResponse['stability']>> = {}): LiveResponse['stability'] => ({
  verdict: 'STABLE', n: 6, flips: 0, persistence: 1, leaning: 'DOWN', ageMs: 0,
  text: '6 of 6 calls in the last hour agreed on DOWN. The read is holding.', ...over,
});

const base = { ladder: ladder(), readiness: ready(), hoursLeft: 8.28, asOf: NOW, now: NOW };

describe('the verdict bar', () => {
  it('gives the direction and whether the desk may act as two separate facts', () => {
    render(<VerdictBar {...base} />);
    expect(screen.getByText('Down')).toBeVisible();
    expect(screen.getByText(/Entry ready · DOWN/)).toBeVisible();
  });

  it('[critical] not-ready lists every blocker as a sentence, never a count', () => {
    const blockers = ['5M trigger is UP, direction is DOWN — wait for the trigger to turn', 'Weighted read is inside the 15% dead band'];
    render(<VerdictBar {...base} readiness={ready({ ready: false, blockers })} />);
    expect(screen.getByText('Not ready')).toBeVisible();
    for (const b of blockers) expect(screen.getByText(b)).toBeVisible();
    expect(screen.queryByText(/Not ready \(2\)/)).not.toBeInTheDocument();
  });

  it('[critical] an unstable read is called out beside the arrow — New.md §32', () => {
    render(<VerdictBar {...base} stability={stability({ verdict: 'UNSTABLE', flips: 4 })} />);
    expect(screen.getByText(/Low stability/)).toBeVisible();
    expect(screen.getByText(/4 side changes\/h/)).toBeVisible();
  });

  it('a holding read says so without being dressed as a recommendation', () => {
    const { container } = render(<VerdictBar {...base} stability={stability()} />);
    const chip = screen.getByText('Holding');
    expect(chip).toBeVisible();
    // Colour on this screen means direction, never quality: "Holding" is muted.
    expect(container.innerHTML).not.toMatch(/Holding<\/span>[\s\S]{0,40}--up/);
  });

  it('no side changes prints no change counter', () => {
    render(<VerdictBar {...base} stability={stability({ flips: 0 })} />);
    expect(screen.queryByText(/side change/)).not.toBeInTheDocument();
  });

  it('[critical] penalties are shown with both the reason and the explanation — New.md §33', () => {
    const penalties = [
      { reason: 'Stale price', detail: 'No live tick — every distance is measured from the last 5-minute close.' },
      { reason: 'Timeframes disagree', detail: '5m points the other way.' },
    ];
    render(<VerdictBar {...base} penalties={penalties} />);
    for (const p of penalties) {
      expect(screen.getByText(`${p.reason}:`)).toBeVisible();
      expect(screen.getByText(p.detail)).toBeVisible();
    }
  });

  it('[critical] penalties appear even when the desk IS ready — they discount, not block', () => {
    render(<VerdictBar {...base} readiness={ready({ ready: true })} penalties={[{ reason: 'Stale price', detail: 'No live tick right now.' }]} />);
    expect(screen.getByText(/Entry ready/)).toBeVisible();
    expect(screen.getByText('Stale price:')).toBeVisible();
  });

  it('no penalties draws no penalty list', () => {
    render(<VerdictBar {...base} />);
    expect(screen.queryByLabelText(/worth less than it looks/)).not.toBeInTheDocument();
  });

  it('[critical] a stale read says how old it is rather than pretending to be live', () => {
    render(<VerdictBar {...base} now={NOW + 120_000} />);
    expect(screen.getByText('120s old')).toBeVisible();
  });

  it('a fresh read says live', () => {
    render(<VerdictBar {...base} now={NOW + 5_000} />);
    expect(screen.getByText('live')).toBeVisible();
  });

  it('time to settlement reads in hours and minutes', () => {
    render(<VerdictBar {...base} hoursLeft={8.28} />);
    expect(screen.getByText(/8h 17m to settlement/)).toBeVisible();
  });
});
