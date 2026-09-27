import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OriginTag } from './OriginTag';

/**
 * Which strategy placed this order.
 *
 * Both call sites passed `plan.strategyId` into the `strategyName` prop, whose
 * own docstring says the id is not worth showing. The ids are historical —
 * `5-01-copy` is the strategy named "3.55" and enters at 15:55 — so an order
 * placed at 15:55 was tagged `5-01-copy`, which reads as 5:01.
 */
describe('the origin tag', () => {
  it('[critical] shows the strategy name, not its id', () => {
    render(<OriginTag origin="strategy" strategyName="3.55" strategyId="5-01-copy" />);
    expect(screen.getByText('3.55')).toBeVisible();
    expect(screen.queryByText('5-01-copy')).not.toBeInTheDocument();
  });

  it('[critical] falls back to the id only when no name was recorded, and says so', () => {
    render(<OriginTag origin="strategy" strategyId="5-01-copy" />);
    expect(screen.getByText('5-01-copy')).toBeVisible();
    expect(screen.getByText('5-01-copy').closest('span'))
      .toHaveAttribute('title', expect.stringContaining('before the name was recorded'));
  });

  it('a named strategy does not carry the "this is its id" caveat', () => {
    render(<OriginTag origin="strategy" strategyName="3.55" strategyId="5-01-copy" />);
    expect(screen.getByText('3.55').closest('span'))
      .not.toHaveAttribute('title', expect.stringContaining('before the name was recorded'));
  });

  it('a hand-placed order says Manual', () => {
    render(<OriginTag origin="manual" />);
    expect(screen.getByText('Manual')).toBeVisible();
  });

  it('an order from before the field existed reads as Manual, which is what it was', () => {
    render(<OriginTag />);
    expect(screen.getByText('Manual')).toBeVisible();
  });

  it('the best-pick card is named as itself', () => {
    render(<OriginTag origin="best-pick" />);
    expect(screen.getByText('Best pick')).toBeVisible();
  });

  it('a strategy with neither name nor id still says Strategy rather than nothing', () => {
    render(<OriginTag origin="strategy" />);
    expect(screen.getByText('Strategy')).toBeVisible();
  });
});
