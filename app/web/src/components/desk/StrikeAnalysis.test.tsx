import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StrikeAnalysis } from '@/components/desk/StrikeAnalysis';
import type { Leg, SnapshotMeta } from '@/types/desk';

/**
 * Everything known about one strike, before any order exists.
 *
 * Two things are load-bearing. A strike is two contracts and the board's centre
 * cell belongs to both, so the sheet has to carry the other side rather than
 * making someone close it and find the opposite cell. And the reason a strike
 * says Avoid has to be *here*: the board has room for six columns on a phone,
 * the eligibility list is nine rules long, and a phone has no hover.
 */

const snap = { spot: 77_172, expiry: '120926', hoursToExpiry: 20.25 } as unknown as SnapshotMeta;

const mk = (cp: 'C' | 'P', over: Partial<Leg['ev']> = {}): Leg =>
  ({
    cp,
    strike: 80_000,
    bid: 18,
    ask: 19,
    mark: 18.5,
    sellPrice: 18,
    oi: 425_600,
    volume: 729,
    delta: cp === 'C' ? 0.032 : -0.95,
    ageMin: 4,
    pOtm: 0.98,
    zero: { adjusted: 0.99, model: 0.98, sample: 900, outsideTable: false },
    ev: {
      payoutPerBtc: 3.2,
      evPerBtc: 14.8,
      evUsd: 0.0714,
      chargesUsd: 0.0074,
      volumeToOi: 729 / 425_600,
      breakeven: cp === 'C' ? 80_018 : 79_982,
      maxProfitUsd: 0.0826,
      maxLossUsd: null,
      signal: 'watch',
      checks: [
        { ok: true, severity: 'block', text: '3.66% out of the money, past the 3% bar.' },
        { ok: false, severity: 'warn', text: 'Traded only 0.2% of its open interest today.' },
      ],
      ...over,
    },
  }) as unknown as Leg;

const sheet = (legs: Leg[], side: 'C' | 'P' = 'C', onSell?: (l: Leg) => void) =>
  render(
    <StrikeAnalysis
      legs={legs}
      strike={80_000}
      side={side}
      snap={snap}
      open
      onOpenChange={() => {}}
      onSell={onSell}
    />,
  );

describe('the strike sheet', () => {
  it('opens on the side that was tapped', () => {
    sheet([mk('C'), mk('P')], 'P');
    expect(screen.getByText('80,000 · put')).toBeInTheDocument();
  });

  it('[critical] carries the other side of the same strike', () => {
    sheet([mk('C'), mk('P')], 'C');
    expect(screen.getByText('80,000 · call')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Put' }));
    expect(screen.getByText('80,000 · put')).toBeInTheDocument();
  });

  it('offers no toggle when the exchange lists only one side', () => {
    sheet([mk('C')], 'C');
    expect(screen.queryByRole('radio', { name: 'Put' })).not.toBeInTheDocument();
  });

  it('[critical] spells out every rule, passed and failed', () => {
    sheet([mk('C')]);
    expect(screen.getByText('3.66% out of the money, past the 3% bar.')).toBeInTheDocument();
    expect(screen.getByText('Traded only 0.2% of its open interest today.')).toBeInTheDocument();
  });

  it('[critical] says the worst case is unbounded rather than printing a number for it', () => {
    sheet([mk('C')]);
    expect(screen.getByText('unbounded')).toBeInTheDocument();
  });

  it('says how stale the last print is — the column the board used to carry', () => {
    sheet([mk('C')]);
    expect(screen.getByText('Last traded')).toBeInTheDocument();
  });

  it('shows the money: expected value, the payout behind it, and break even', () => {
    sheet([mk('C')]);
    expect(screen.getByText('+$0.071')).toBeInTheDocument();
    expect(screen.getByText('$3.20')).toBeInTheDocument();
    expect(screen.getByText('80,018')).toBeInTheDocument();
  });

  it('says on its face that these rules are not what the desk trades on', () => {
    sheet([mk('C')]);
    expect(screen.getByText(/nothing on the trading side reads them/)).toBeInTheDocument();
  });

  it('hands the whole leg to the ticket rather than placing anything itself', () => {
    const onSell = vi.fn();
    sheet([mk('C')], 'C', onSell);
    screen.getByRole('button', { name: 'Open a ticket' }).click();
    expect(onSell).toHaveBeenCalledWith(expect.objectContaining({ cp: 'C', strike: 80_000 }));
  });

  it('offers no ticket on a board that cannot be traded', () => {
    sheet([mk('C')]);
    expect(screen.queryByRole('button', { name: 'Open a ticket' })).not.toBeInTheDocument();
  });

  it('renders nothing at all for a strike the board does not have', () => {
    const { container } = render(
      <StrikeAnalysis
        legs={[]} strike={80_000} side="C" snap={snap} open onOpenChange={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
