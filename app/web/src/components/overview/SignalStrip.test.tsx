import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ExpiryDirection, MtfConsensus } from '@/lib/overview';
import { SIGNAL_ANCHORS, SignalStrip } from './SignalStrip';

const mtf = (tiers: MtfConsensus['tiers'], way: MtfConsensus['way']) => ({ tiers, way }) as unknown as MtfConsensus;
const direction = (p: Partial<ExpiryDirection>) =>
  ({ bias: 'RANGE', confidence: 'LOW', pUp: 0.3, pRange: 0.4, pDown: 0.3, ...p }) as unknown as ExpiryDirection;

const show = (o: { m?: MtfConsensus; d?: ExpiryDirection | null; side?: 'CE' | 'PE' | 'BOTH' | 'NO_TRADE' } = {}) =>
  render(
    <SignalStrip
      mtf={o.m ?? mtf({ macro: 'DOWN', setup: 'DOWN', trigger: 'SIDE' }, 'DOWN')}
      direction={o.d === undefined ? direction({}) : o.d}
      choice={{ side: o.side ?? 'CE', why: 'Downtrend; the call side passes' }}
      hoursLeftText="6h 10m"
    />,
  );

describe('the signal strip', () => {
  it('reads the trend by tier, in the order docs/New.md gives them', () => {
    const { container } = show();
    expect(screen.getByText('↓ Down')).toBeInTheDocument();
    const tiers = [...container.querySelectorAll('.ov-sig-tiers > span')].map((e) => e.textContent);
    expect(tiers).toEqual(['Direction ↓', 'Setup ↓', 'Trigger ↔']);
  });

  it('a tier with no reading says so rather than borrowing a neighbour', () => {
    show({ m: mtf({ macro: null, setup: 'UP', trigger: null }, null) });
    expect(screen.getByTitle('Direction: no reading')).toHaveTextContent('Direction ·');
    expect(screen.getByTitle('Setup: Up')).toBeInTheDocument();
  });

  it('shows the expiry split with its confidence, never the split without it', () => {
    show({ d: direction({ bias: 'UP', confidence: 'MEDIUM', pUp: 0.55, pRange: 0.25, pDown: 0.2 }) });
    expect(screen.getByText('medium')).toBeInTheDocument();
    expect(screen.getByText('↑ 55%')).toBeInTheDocument();
    expect(screen.getByText('↔ 25%')).toBeInTheDocument();
    expect(screen.getByText('↓ 20%')).toBeInTheDocument();
  });

  it('no expiry read is a dash, not a guess', () => {
    const { container } = show({ d: null });
    expect(container.querySelectorAll('.ov-sig-tile')[1]).toHaveTextContent('—');
  });

  it('[critical] a CE sale is not coloured as a down call: green means a side passes', () => {
    const { container } = show({ side: 'CE' });
    expect(screen.getByText('Sell CE')).toHaveClass('ov-up');
    expect(container.querySelector('.ov-sig-tile:last-child .ov-down')).toBeNull();
  });

  it('no trade is muted', () => {
    show({ side: 'NO_TRADE' });
    expect(screen.getByText('No trade')).toHaveClass('ov-muted');
  });

  it('each tile jumps to its own panel', () => {
    const into = vi.fn();
    for (const id of Object.values(SIGNAL_ANCHORS)) {
      const el = document.createElement('div');
      el.id = id;
      el.scrollIntoView = () => into(id);
      document.body.appendChild(el);
    }
    show();
    const tiles = screen.getAllByRole('button');
    tiles.forEach((t) => fireEvent.click(t));
    expect(into.mock.calls.map((c) => c[0])).toEqual([SIGNAL_ANCHORS.trend, SIGNAL_ANCHORS.expiry, SIGNAL_ANCHORS.decision]);
  });
});
