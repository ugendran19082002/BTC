import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BestTrade } from '@/components/desk/BestTrade';
import type { BestTrade as BestTradeData, Leg } from '@/types/desk';

/**
 * One trade, named.
 *
 * It replaced *Best expected value*, which ranked on one number and could not
 * say what the trade costs when it goes wrong. Three things must hold: an
 * uncapped loss is never printed as a number, the card says whether the tested
 * engine agrees, and nothing is placed from here.
 */

const pick = (over: Partial<NonNullable<BestTradeData['pick']>> = {}): NonNullable<BestTradeData['pick']> => ({
  cp: 'P', side: 'PE', strike: 75_400,
  premiumUsd: 11.92,
  expiryOtm: 0.958, touch: 0.241, nearZero: 0.912,
  emBuffer: 1.54, delta: -0.07,
  liquidity: 78,
  creditUsd: 1.18,
  maxLossUsd: 188,
  creditRisk: 0.46,
  hedge: { strike: 75_000, askUsd: 6.2, widthUsd: 400 },
  rank: 81,
  reasons: ['pays 46% of what it can lose', '95.8% to expire worthless', '1.54× the expected move away', 'liquidity 78/100'],
  ...over,
});

const data = (over: Partial<BestTradeData> = {}): BestTradeData => ({
  pick: pick(),
  runnersUp: [pick({ strike: 75_200, rank: 74 }), pick({ strike: 75_000, rank: 70 })],
  eligible: 6,
  why: null,
  agreesWithEngine: true,
  ...over,
});

const legs = [{ cp: 'P', strike: 75_400, bid: 11.92 } as unknown as Leg];

describe('the best trade card', () => {
  it('[critical] names one order, in the words it would be placed in', () => {
    render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText('SELL PE 75,400')).toBeInTheDocument();
    expect(screen.getByLabelText('rank')).toHaveTextContent('81/100');
  });

  it('[critical] shows the six numbers it was chosen on', () => {
    render(<BestTrade best={data()} legs={legs} />);
    const dl = within(screen.getByLabelText('the pick'));
    expect(dl.getByText('Premium (bid)').nextSibling).toHaveTextContent('11.92');
    expect(dl.getByText('Expiry OTM').nextSibling).toHaveTextContent('95.8%');
    expect(dl.getByText('Touch').nextSibling).toHaveTextContent('24%');
    expect(dl.getByText('Near-zero').nextSibling).toHaveTextContent('91%');
    expect(dl.getByText('EM×').nextSibling).toHaveTextContent('1.54×');
    expect(dl.getByText('Delta').nextSibling).toHaveTextContent('-0.070');
    expect(dl.getByText('Credit / risk').nextSibling).toHaveTextContent('0.46');
    expect(dl.getByText('Liquidity').nextSibling).toHaveTextContent('78/100');
  });

  it('[critical] a loss with a hedge is a number, and says which hedge caps it', () => {
    render(<BestTrade best={data()} legs={legs} />);
    const row = within(screen.getByLabelText('the pick')).getByText('Max loss (with hedge)').parentElement!;
    expect(row).toHaveTextContent('$188');
    expect(row).toHaveTextContent('buying 75,000 at 6.20');
    expect(row).toHaveTextContent('$400 wide');
  });

  it('[critical] a naked short says uncapped rather than printing a number', () => {
    render(
      <BestTrade
        best={data({ pick: pick({ maxLossUsd: null, creditRisk: null, hedge: null }) })}
        legs={legs}
      />,
    );
    expect(screen.getByText(/uncapped — no hedge/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('the pick')).getByText('Credit / risk').nextSibling)
      .toHaveTextContent('—');
  });

  it('[critical] says whether the tested engine picked the same strike', () => {
    const { rerender } = render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText('Engine agrees')).toBeInTheDocument();
    rerender(<BestTrade best={data({ agreesWithEngine: false })} legs={legs} />);
    expect(screen.getByText('Engine differs')).toBeInTheDocument();
    expect(screen.getByText(/follow the engine/)).toBeInTheDocument();
  });

  it('[critical] says on its face that this ranking is not the tested one', () => {
    render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText(/never been through the cross-period screen/)).toBeInTheDocument();
  });

  it('[critical] touch is shown, and said to be no part of the ranking', () => {
    render(<BestTrade best={data()} legs={legs} />);
    const touch = within(screen.getByLabelText('the pick')).getByText('Touch');
    expect(touch.getAttribute('title') ?? touch.parentElement?.textContent).toBeTruthy();
    expect(screen.getByTitle(/never ranked on — touching is not losing/)).toBeInTheDocument();
  });

  it('names the two behind it, so "why not that one" is answerable', () => {
    render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText(/Behind it: PE 75,200 \(74\), PE 75,000 \(70\)/)).toBeInTheDocument();
  });

  it('[critical] hands the leg to the ticket rather than placing anything', () => {
    const onSell = vi.fn();
    render(<BestTrade best={data()} legs={legs} onSell={onSell} />);
    fireEvent.click(screen.getByRole('button', { name: /Take it to the ticket/ }));
    expect(onSell).toHaveBeenCalledWith(legs[0]);
  });

  it('offers no ticket on a board that cannot be traded', () => {
    render(<BestTrade best={data()} legs={legs} />);
    expect(screen.queryByRole('button', { name: /ticket/ })).toBeNull();
  });

  it('[critical] nothing eligible is an answer, with the reason', () => {
    render(
      <BestTrade
        best={data({ pick: null, runnersUp: [], eligible: 0, why: 'No strike on this board clears the hard rules. The Signal column says which rule each one is failing.' })}
        legs={legs}
      />,
    );
    expect(screen.getByText(/No strike on this board clears the hard rules/)).toBeInTheDocument();
    expect(screen.getByText('nothing clears')).toBeInTheDocument();
    expect(screen.queryByLabelText('the pick')).toBeNull();
  });

  it('a call pick is green and a put pick is red, as on the board above', () => {
    const { rerender } = render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText('SELL PE 75,400').className).toContain('pe');
    rerender(<BestTrade best={data({ pick: pick({ cp: 'C', side: 'CE', strike: 78_000 }) })} legs={legs} />);
    expect(screen.getByText('SELL CE 78,000').className).toContain('ce');
  });
});
