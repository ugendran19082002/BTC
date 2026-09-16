import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BestTrade } from '@/components/desk/BestTrade';
import type { BestTrade as BestTradeData, Leg } from '@/types/desk';

const getBestTradeSettings = vi.fn();
vi.mock('@/api/trade', () => ({
  getBestTradeSettings: (...a: unknown[]) => getBestTradeSettings(...a),
  setBestTradeSettings: vi.fn(),
}));
getBestTradeSettings.mockResolvedValue({ alertOn: false, minPremiumUsd: 5, telegram: { configured: true, on: true } });

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
  failing: [],
  ...over,
});

const data = (over: Partial<BestTradeData> = {}): BestTradeData => ({
  pick: pick(),
  runnersUp: [pick({ strike: 75_200, rank: 74 }), pick({ strike: 75_000, rank: 70 })],
  eligible: 6,
  why: null,
  agreesWithEngine: true,
  bestOfNone: false,
  minPremiumUsd: 5,
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
    expect(dl.getByText('You’d be paid').nextSibling).toHaveTextContent('11.92');
    expect(dl.getByText('Chance you keep it all').nextSibling).toHaveTextContent('95.8%');
    expect(dl.getByText('Chance price gets there first').nextSibling).toHaveTextContent('24%');
    expect(dl.getByText('Chance it collapses early').nextSibling).toHaveTextContent('91%');
    expect(dl.getByText('How far away, in usual moves').nextSibling).toHaveTextContent('1.54×');
    expect(dl.getByText('Sensitivity to BTC').nextSibling).toHaveTextContent('-0.070');
    expect(dl.getByText('Paid ÷ most you can lose').nextSibling).toHaveTextContent('0.46');
    expect(dl.getByText('How easy to trade').nextSibling).toHaveTextContent('78/100');
  });

  it('[critical] a loss with a hedge is a number, and says which hedge caps it', () => {
    render(<BestTrade best={data()} legs={legs} />);
    const row = within(screen.getByLabelText('the pick')).getByText('Most you can lose (with the safety leg)').parentElement!;
    expect(row).toHaveTextContent('$188');
    expect(row).toHaveTextContent('safety leg: buy 75,000 at 6.20');
    expect(row).toHaveTextContent('$400 apart');
  });

  it('[critical] a naked short says uncapped rather than printing a number', () => {
    render(
      <BestTrade
        best={data({ pick: pick({ maxLossUsd: null, creditRisk: null, hedge: null }) })}
        legs={legs}
     
      />,
    );
    expect(screen.getByText(/no limit — no safety leg/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('the pick')).getByText('Paid ÷ most you can lose').nextSibling)
      .toHaveTextContent('—');
  });

  it('[critical] only a pick that clears and the engine agrees with is "Recommended"', () => {
    // Three different states, and the word belongs to one of them.
    const { rerender } = render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    rerender(<BestTrade best={data({ bestOfNone: true, why: 'No strike clears the hard rules today.' })} legs={legs} />);
    expect(screen.queryByText('Recommended')).toBeNull();
    expect(screen.getByText('None pass the checks')).toBeInTheDocument();
  });

  it('[critical] says whether the tested engine picked the same strike', () => {
    const { rerender } = render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    rerender(<BestTrade best={data({ agreesWithEngine: false })} legs={legs} />);
    expect(screen.getByText('The tested rule picks differently')).toBeInTheDocument();
    expect(screen.getByText(/follow the tested rule/)).toBeInTheDocument();
  });

  it('[critical] says on its face that this ranking is not the tested one', () => {
    render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText(/not been checked against past years/)).toBeInTheDocument();
  });

  it('[critical] touch is shown, and said to be no part of the ranking', () => {
    render(<BestTrade best={data()} legs={legs} />);
    const touch = within(screen.getByLabelText('the pick')).getByText('Chance price gets there first');
    expect(touch.getAttribute('title') ?? touch.parentElement?.textContent).toBeTruthy();
    expect(screen.getByTitle(/never ranked on: touching is not losing/)).toBeInTheDocument();
  });

  it('names the two behind it, so "why not that one" is answerable', () => {
    render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText(/Behind it: PE 75,200 \(74\), PE 75,000 \(70\)/)).toBeInTheDocument();
  });

  it('[critical] hands the leg to the ticket rather than placing anything', () => {
    const onSell = vi.fn();
    render(<BestTrade best={data()} legs={legs} onSell={onSell} />);
    fireEvent.click(screen.getByRole('button', { name: /Open the order form with this/ }));
    expect(onSell).toHaveBeenCalledWith(legs[0]);
  });

  it('offers no ticket on a board that cannot be traded', () => {
    render(<BestTrade best={data()} legs={legs} />);
    expect(screen.queryByRole('button', { name: /order form/ })).toBeNull();
  });

  it('[critical] a board with nothing to sell says so, and shows no pick', () => {
    render(
      <BestTrade
        best={data({ pick: null, runnersUp: [], eligible: 0, why: 'Nothing on this board pays $5 or more, so there is nothing worth selling.' })}
        legs={legs}
     
      />,
    );
    expect(screen.getByText(/nothing worth selling/)).toBeInTheDocument();
    expect(screen.getByText('nothing to sell')).toBeInTheDocument();
    expect(screen.queryByLabelText('the pick')).toBeNull();
  });

  it('[critical] a morning when nothing clears names the closest and what it fails', () => {
    // An empty card cannot say which strike came nearest or why it was refused.
    render(
      <BestTrade
        best={data({
          bestOfNone: true,
          eligible: 0,
          why: 'No strike clears the hard rules today. This is the one that came closest — what it is failing is below.',
          pick: pick({ failing: ['Traded 2% of its open interest today, under the 10% bar.', 'Last traded 41 minutes ago.'] }),
        })}
        legs={legs}
     
      />,
    );
    expect(screen.getByText('None pass the checks')).toBeInTheDocument();
    expect(screen.getByText(/came closest/)).toBeInTheDocument();
    // the failures sit inside the warning, where "below" points -- not under the figures
    const banner = screen.getByText(/came closest/).parentElement!;
    const failing = within(within(banner).getByLabelText('what it is failing'));
    expect(failing.getByText(/under the 10% bar/)).toBeInTheDocument();
    expect(failing.getByText(/Last traded 41 minutes ago/)).toBeInTheDocument();
    expect(screen.getByText('SELL PE 75,400')).toBeInTheDocument();
  });

  it('an eligible pick shows no failures', () => {
    render(<BestTrade best={data()} legs={legs} />);
    expect(screen.queryByLabelText('what it is failing')).toBeNull();
  });

  it('a call pick is green and a put pick is red, as on the board above', () => {
    const { rerender } = render(<BestTrade best={data()} legs={legs} />);
    expect(screen.getByText('SELL PE 75,400').className).toContain('pe');
    rerender(<BestTrade best={data({ pick: pick({ cp: 'C', side: 'CE', strike: 78_000 }) })} legs={legs} />);
    expect(screen.getByText('SELL CE 78,000').className).toContain('ce');
  });
});
