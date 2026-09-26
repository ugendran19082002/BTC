import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MomentumCard } from './MomentumCard';
import type { MomentumSignal, Measured } from '@/types/live';

const measured = (over: Partial<Measured> = {}): Measured => ({
  policy: 'entry 1.5 ATR : 3 ATR',
  tf: '30m',
  n: 1317,
  hitRate: 0.198,
  netR: -0.149,
  avgR: 0.043,
  outOfSample: { year: '2026', n: 375, hitRate: 0.224, netR: -0.093 },
  from: '2024-04-01',
  to: '2026-09-26',
  ...over,
});

const confirmed = (over: Partial<MomentumSignal> = {}): MomentumSignal => ({
  state: 'CONFIRMED',
  tf: '30m',
  side: 'DOWN',
  level: 83_750,
  atr: 210,
  at: Date.now(),
  plan: { entry: 83_700, stop: 84_015, target: 83_070, rr: 2, riskPts: 315, rewardPts: 630, policy: 'entry 1.5 ATR : 3 ATR' },
  measured: measured(),
  verdict: 'INFORMATIONAL',
  compression: 0.9,
  headline: '30m breakdown through 83750 · hit 20% but -0.149R net after fees over 1,317.',
  warnings: ['Measured net -0.149R after fees over 1,317 of these (2024-04-01 → 2026-09-26). This shape has not paid for itself.'],
  ...over,
});

describe('the big-move card', () => {
  it('[critical] a losing shape is labelled not-a-trade, in the same breath as the call', () => {
    render(<MomentumCard signal={confirmed()} />);
    expect(screen.getByText(/Break confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/Not a trade/i)).toBeInTheDocument();
  });

  it('[critical] the net-after-fees figure is always on screen, never behind a control', () => {
    render(<MomentumCard signal={confirmed()} />);
    // Visible text, not a title attribute and not inside a collapsed region.
    expect(screen.getByText('-0.149R')).toBeVisible();
    // The label exactly: the warning below it also contains "after fees".
    expect(screen.getByText('Net after fees')).toBeVisible();
  });

  it('[critical] the sample size is shown beside the word "measured"', () => {
    render(<MomentumCard signal={confirmed()} />);
    expect(screen.getByText(/measured · n=1,317/)).toBeInTheDocument();
  });

  it('shows the held-out year separately from the whole sample', () => {
    render(<MomentumCard signal={confirmed()} />);
    expect(screen.getByText(/2026, held out/)).toBeInTheDocument();
    expect(screen.getByText(/-0\.093R · n=375/)).toBeInTheDocument();
  });

  it('a profitable measured shape is offered as tradeable', () => {
    render(<MomentumCard signal={confirmed({ verdict: 'TRADEABLE', measured: measured({ netR: 0.12 }) })} />);
    expect(screen.getByText(/^Tradeable$/i)).toBeInTheDocument();
    expect(screen.queryByText(/Not a trade/i)).not.toBeInTheDocument();
  });

  it('[critical] every warning is rendered — none are truncated or folded', () => {
    const s = confirmed({ warnings: ['first warning about the net R', 'second about the held-out year', 'third about the spread'] });
    render(<MomentumCard signal={s} />);
    for (const w of s.warnings) expect(screen.getByText(w)).toBeVisible();
  });

  it('the plan shows entry, stop and target as prices', () => {
    render(<MomentumCard signal={confirmed()} />);
    expect(screen.getByText('Entry')).toBeInTheDocument();
    expect(screen.getByText('Stop')).toBeInTheDocument();
    expect(screen.getByText('Target')).toBeInTheDocument();
    expect(screen.getByText('1 : 2.00')).toBeInTheDocument();
  });

  it('[critical] an ungraded call says so rather than borrowing a number', () => {
    render(<MomentumCard signal={confirmed({ measured: null, warnings: [] })} />);
    expect(screen.getByText(/never graded/i)).toBeInTheDocument();
    expect(screen.getByText(/do not size a trade off this card/i)).toBeInTheDocument();
  });

  it('[critical] a coil names both edges and offers no plan', () => {
    const coil: MomentumSignal = {
      state: 'COILED', tf: '15m', side: null, level: 84_300, levelLow: 83_700, atr: 90,
      at: Date.now(), plan: null, measured: null, verdict: 'INFORMATIONAL', compression: 0.62,
      headline: 'Range has contracted to 62% of its recent average, between 83700 and 84300. An expansion usually follows — which way is not forecast.',
      warnings: ['No side: a contraction says a move is likely, not which way it breaks.'],
    };
    render(<MomentumCard signal={coil} />);
    expect(screen.getByText(/Coiled/)).toBeInTheDocument();
    expect(screen.queryByText('Entry')).not.toBeInTheDocument();
    expect(screen.getByText(/not which way it breaks/)).toBeVisible();
  });

  it('nothing happening says nothing is happening', () => {
    const none: MomentumSignal = {
      state: 'NONE', tf: null, side: null, level: null, atr: null, at: null, plan: null,
      measured: null, verdict: 'INFORMATIONAL', compression: 0.95,
      headline: 'No break and no coil — the range is ordinary.', warnings: [],
    };
    render(<MomentumCard signal={none} />);
    expect(screen.getByText(/the range is ordinary/)).toBeInTheDocument();
    expect(screen.getByText('95%')).toBeInTheDocument();
  });
});
