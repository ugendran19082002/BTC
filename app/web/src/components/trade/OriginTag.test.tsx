import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OriginTag } from '@/components/trade/OriginTag';

/**
 * Who placed this order.
 *
 * Three things place orders on this desk and a position card used to look the
 * same whichever it was. The one that matters most is the oldest record: a
 * trade saved before the field existed is a trade somebody placed by hand, and
 * must never be labelled as something a machine did.
 */

describe('who placed it', () => {
  it('[critical] a record from before the field existed reads as manual, never as automatic', () => {
    render(<OriginTag />);
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByLabelText('placed by: manual')).toBeInTheDocument();
  });

  it('names the strategy, because "strategy" does not answer "which one"', () => {
    render(<OriginTag origin="strategy" strategyName="Saturday Lock" />);
    expect(screen.getByText('Saturday Lock')).toBeInTheDocument();
    expect(screen.getByLabelText('placed by: strategy')).toBeInTheDocument();
  });

  it('a strategy with no name still says it was a strategy', () => {
    render(<OriginTag origin="strategy" />);
    expect(screen.getByText('Strategy')).toBeInTheDocument();
  });

  it('[critical] the automatic best pick is marked as automatic', () => {
    render(<OriginTag origin="best-pick" />);
    expect(screen.getByText('Best pick')).toBeInTheDocument();
    expect(screen.getByLabelText('placed by: best pick').getAttribute('title'))
      .toMatch(/Placed automatically from the best-pick card/);
  });
});
