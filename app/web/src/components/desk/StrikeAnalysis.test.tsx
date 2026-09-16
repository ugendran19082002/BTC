import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

const snap = {
  spot: 77_172, expiry: '120926', hoursToExpiry: 20.25, expectedMove: 756,
} as unknown as SnapshotMeta;

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
    probs: { expireWorthless: 0.98, touch: 0.24, nearZero: 0.91 },
    emBuffer: 3.74,
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

/**
 * The five questions, together.
 *
 * Reading them apart is how a strike looks safe: 96.9% to expire worthless and
 * touched one day in four are both true of the same put, and a short position
 * is lived through the second one. What must never happen here is the two being
 * added up into one sense of risk, or a touch being drawn as a failure.
 */
describe('path and settlement', () => {
  const row = () => screen.getByLabelText('path and settlement');

  it('[critical] shows where it finishes and what it does on the way, as different numbers', () => {
    sheet([mk('C')]);
    const r = within(row());
    expect(r.getByText('Expiry OTM').nextSibling).toHaveTextContent('99.0%');
    expect(r.getByText('Touch').nextSibling).toHaveTextContent('24%');
    expect(r.getByText('Near-zero').nextSibling).toHaveTextContent('91%');
    expect(r.getByText('EM×').nextSibling).toHaveTextContent('3.74×');
  });

  it('[critical] a touch is never drawn as a failure', () => {
    // A day that touches and comes back settles worthless like any other, so a
    // moderate touch is marked and a high one warned — neither is red-as-wrong.
    sheet([mk('C')]);
    expect(within(row()).getByText('24%').className).not.toContain('--down');
    expect(screen.getByText(/that is the drawdown to sit through, not a second chance of losing/)).toBeInTheDocument();
  });

  it('[critical] says in words that neither number refuses the strike', () => {
    sheet([mk('C')]);
    expect(screen.getByText(/Nothing here refuses a strike on its own/)).toBeInTheDocument();
  });

  it('[critical] a move of one expected move that cannot reach the strike costs nothing', () => {
    // 77,172 + 756 = 77,928, nowhere near the 80,000 call.
    sheet([mk('C')]);
    expect(within(row()).getByText('At ±1 EM').nextSibling).toHaveTextContent('nothing');
  });

  it('[critical] a move that does reach it is priced, per contract', () => {
    // A put at 80,000 with spot 77,172: one expected move down settles at
    // 76,416, which is 3,584 in the money — $3.58 a contract.
    sheet([mk('P')], 'P');
    expect(within(row()).getByText('At ±1 EM').nextSibling).toHaveTextContent('$3.58');
  });

  it('shows a dash rather than a number where the board has none', () => {
    const bare = { ...mk('C'), probs: { expireWorthless: null, touch: null, nearZero: null }, emBuffer: null } as Leg;
    sheet([bare]);
    const r = within(row());
    expect(r.getByText('Touch').nextSibling).toHaveTextContent('—');
    expect(r.getByText('Near-zero').nextSibling).toHaveTextContent('—');
    expect(r.getByText('EM×').nextSibling).toHaveTextContent('—');
  });
});
