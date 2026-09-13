import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TopCandidates } from '@/components/desk/TopCandidates';
import type { Leg, SideRecommendation } from '@/types/desk';

/**
 * The card ranks on arithmetic the desk does not trade on, so the two things
 * worth pinning are that it never promotes a strike the server refused, and
 * that where it disagrees with the tested engine the disagreement is visible
 * rather than left for a reader to spot by comparing two numbers.
 */

/** The body rows, in the order they are drawn. */
const rows = () => screen.getAllByRole('row').slice(1);

const leg = (
  strike: number,
  signal: Leg['ev']['signal'],
  evUsd: number,
  over: Partial<Leg> = {},
): Leg =>
  ({
    cp: 'C',
    strike,
    sellPrice: 18,
    zero: { adjusted: 0.99, model: 0.97, sample: 900, outsideTable: false },
    ev: {
      evUsd, evPerBtc: evUsd, signal, checks: [], volumeToOi: 0.2,
      tier: signal === 'sell' ? 'candidate' : signal, score: 70,
    },
    ...over,
  }) as unknown as Leg;

const legs = [
  leg(79_400, 'sell', 30.5),
  leg(80_000, 'sell', 31.2),
  leg(82_000, 'avoid', 99),
];

const withThin = (strike: number, evUsd: number) =>
  leg(strike, 'watch', evUsd, {
    ev: {
      evUsd, evPerBtc: evUsd, signal: 'watch', volumeToOi: 0.0017, tier: 'watch', score: 88,
      checks: [{ ok: false, severity: 'warn', text: 'Traded only 0.2% of its open interest today.' }],
    },
  } as unknown as Partial<Leg>);

const side = (strike: number): SideRecommendation =>
  ({ side: 'CE', leg: { strike } }) as unknown as SideRecommendation;

describe('best expected value', () => {
  it('ranks the richest first', () => {
    render(<TopCandidates legs={legs} sides={[]} spot={77_172} />);
    const r = rows();
    expect(within(r[0]!).getByText('80,000')).toBeInTheDocument();
    expect(within(r[1]!).getByText('79,400')).toBeInTheDocument();
  });

  it('[critical] leaves out a strike the server refused, however large its number', () => {
    render(<TopCandidates legs={legs} sides={[]} spot={77_172} />);
    expect(screen.queryByText('82,000')).not.toBeInTheDocument();
    expect(rows()).toHaveLength(2);
  });

  it('[critical] keeps a thin strike and marks it, rather than showing an empty card', () => {
    render(<TopCandidates legs={[...legs, withThin(81_000, 12)]} sides={[]} spot={77_172} />);
    const r = rows();
    expect(r).toHaveLength(3);
    // the clear ones rank above it whatever the numbers say
    expect(within(r.at(-1)!).getByText('81,000')).toBeInTheDocument();
    expect(within(r.at(-1)!).getByText('thin')).toBeInTheDocument();
  });

  it('[critical] marks the strike the tested engine actually picked', () => {
    render(<TopCandidates legs={legs} sides={[side(79_400)]} spot={77_172} />);
    const pickedRow = screen.getByText('79,400').closest('tr')!;
    expect(within(pickedRow).getByText('pick')).toBeInTheDocument();

    // and the one at the top of this list is *not* the desk's pick, which is
    // the case the card exists to make visible
    expect(within(rows()[0]!).queryByText('pick')).not.toBeInTheDocument();
  });

  it('says which of the two to follow when they disagree', () => {
    render(<TopCandidates legs={legs} sides={[side(79_400)]} spot={77_172} />);
    expect(screen.getByText(/“What to sell” is the one that was\s+measured/)).toBeInTheDocument();
  });

  it('opens a ticket from a row', () => {
    const onSell = vi.fn();
    render(<TopCandidates legs={legs} sides={[]} spot={77_172} onSell={onSell} />);
    within(rows()[0]!).getByRole('button', { name: 'Sell' }).click();
    expect(onSell).toHaveBeenCalledWith(expect.objectContaining({ strike: 80_000 }));
  });

  it('asks for the whole strike when the strike itself is tapped', () => {
    const onInspect = vi.fn();
    render(<TopCandidates legs={legs} sides={[]} spot={77_172} onInspect={onInspect} />);
    screen.getByRole('button', { name: /inspect call 80000/ }).click();
    expect(onInspect).toHaveBeenCalledWith(expect.objectContaining({ strike: 80_000 }));
  });

  it('shows no Sell button on a board that cannot be traded', () => {
    render(<TopCandidates legs={legs} sides={[]} spot={77_172} />);
    expect(screen.queryByRole('button', { name: 'Sell' })).not.toBeInTheDocument();
  });

  it('explains what thin means, since most real candidates are', () => {
    render(<TopCandidates legs={[...legs, withThin(81_000, 12)]} sides={[]} spot={77_172} />);
    expect(screen.getByText(/fails one about the fill/)).toBeInTheDocument();
  });

  it('says so plainly when nothing qualifies, rather than showing an empty list', () => {
    render(<TopCandidates legs={[leg(82_000, 'avoid', 99)]} sides={[]} spot={77_172} />);
    expect(screen.getByText(/No strike clears the rules right now/)).toBeInTheDocument();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
});
