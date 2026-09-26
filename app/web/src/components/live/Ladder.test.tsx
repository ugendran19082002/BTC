import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Ladder } from './Ladder';
import type { Ladder as LadderT, LadderRow, Tier } from '@/types/live';

const WEIGHT: Record<Tier, number> = {
  direction: 3, structure: 3, setup: 2, pattern: 3, trigger: 3, execution: 0,
};

const r = (tf: string, tier: Tier, way: LadderRow['way'], over: Partial<LadderRow> = {}): LadderRow => ({
  tf, tier, weight: WEIGHT[tier], trend: way === 'UP' ? 1 : way === 'DOWN' ? -1 : 0,
  momentum: way === 'UP' ? 'bullish' : way === 'DOWN' ? 'bearish' : 'neutral',
  structure: way === 'UP' ? 1 : way === 'DOWN' ? -1 : 0,
  vwapDistPct: -0.42, adx: 27, way, conviction: 1, ...over,
});

const ladder = (over: Partial<LadderT> = {}): LadderT => ({
  rows: [
    r('12h', 'direction', 'DOWN'),
    r('6h', 'direction', 'DOWN'),
    r('4h', 'structure', 'DOWN'),
    r('2h', 'structure', 'DOWN'),
    r('1h', 'setup', 'DOWN'),
    r('30m', 'setup', 'SIDE'),
    r('15m', 'pattern', 'UP'),
    r('5m', 'trigger', 'DOWN'),
    r('1m', 'execution', 'UP'),
  ],
  tiers: { direction: 'DOWN', structure: 'DOWN', setup: 'DOWN', pattern: 'UP', trigger: 'DOWN', execution: 'UP' },
  score: -12,
  normalised: -0.63,
  bias: 'DOWN',
  alignment: 0.68,
  text: '5 of 8 frames · 14 of 19 weight',
  against: ['15m'],
  ...over,
});

describe('the timeframe ladder', () => {
  it('[critical] the execution frame is shown carrying zero weight', () => {
    render(<Ladder ladder={ladder()} />);
    const oneMin = screen.getByText('1m').closest('tr')!;
    expect(within(oneMin).getByTitle(/Execution frames do not vote/)).toHaveTextContent('0');
  });

  it('[critical] a bullish 1m does not change the read', () => {
    render(<Ladder ladder={ladder()} />);
    // The header verdict is DOWN even though the fastest frame points up.
    expect(screen.getByText(/↓ Down/)).toBeInTheDocument();
  });

  it('[critical] frames that disagree are named, not averaged away', () => {
    render(<Ladder ladder={ladder()} />);
    expect(screen.getByText('Against this read: 15m.')).toBeVisible();
  });

  it('every frame carries its weight on screen', () => {
    render(<Ladder ladder={ladder()} />);
    const twelve = screen.getByText('12h').closest('tr')!;
    expect(within(twelve).getByText('3')).toBeInTheDocument();
  });

  it('frames are grouped by the job they do, each group named', () => {
    render(<Ladder ladder={ladder()} />);
    for (const label of ['Direction', 'Structure', 'Setup', 'Pattern', 'Trigger', 'Execution']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('each tier shows its own verdict', () => {
    render(<Ladder ladder={ladder()} />);
    const pattern = screen.getByText('Pattern').closest('div')!;
    expect(within(pattern).getByText('Up')).toBeInTheDocument();
  });

  it('the weight that agreed is spelled out, not just a count of rows', () => {
    render(<Ladder ladder={ladder()} />);
    expect(screen.getByText('5 of 8 frames · 14 of 19 weight')).toBeVisible();
  });

  it('a frame with no side shows a dash for conviction rather than 0%', () => {
    render(<Ladder ladder={ladder()} />);
    const thirty = screen.getByText('30m').closest('tr')!;
    expect(within(thirty).getByText('—')).toBeInTheDocument();
  });

  it('no readable frame says so instead of drawing an empty table', () => {
    render(<Ladder ladder={ladder({ rows: [], tiers: {}, against: [] })} />);
    expect(screen.getByText(/No timeframe could be read/)).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('when nothing disagrees, no dissent line is drawn', () => {
    render(<Ladder ladder={ladder({ against: [] })} />);
    expect(screen.queryByText(/Against this read/)).not.toBeInTheDocument();
  });
});
