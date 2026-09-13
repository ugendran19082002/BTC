import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SuddenMove } from '@/components/desk/SuddenMove';
import type { SuddenMove as Shock } from '@/types/desk';

/**
 * Whether something is happening right now.
 *
 * Two properties carry the card. It is one line on an ordinary board — a
 * warning that takes the same room whether or not there is anything to warn
 * about is one nobody reads by the end of the week. And when it is raised it
 * says *why* in words: a risk number with nothing behind it is one nobody can
 * check or argue with.
 */

const shock = (over: Partial<Shock> = {}): Shock => ({
  score: 12,
  band: 'normal',
  parts: [
    { name: 'Move against expected', value: 0.1, weight: 0.3, note: '0.40× the 5-minute expected move' },
    { name: 'Volume spike', value: 0, weight: 0.25, note: '1.0× the 20-bar median' },
    { name: 'Volatility repricing', value: 0, weight: 0.2, note: null },
    { name: 'Open interest moving', value: 0, weight: 0.15, note: null },
    { name: 'One-sided positioning', value: 0.1, weight: 0.1, note: '1.02 puts per call' },
  ],
  reasons: [],
  direction: 0,
  directionLabel: 'no clear side',
  ...over,
});

describe('sudden move risk', () => {
  it('is one line on an ordinary board', () => {
    render(<SuddenMove shock={shock()} />);
    expect(screen.getByText(/Tape is ordinary/)).toBeInTheDocument();
    expect(screen.queryByText('Move against expected:')).not.toBeInTheDocument();
  });

  it('[critical] draws nothing at all when it could not take a single reading', () => {
    const { container } = render(<SuddenMove shock={shock({ score: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('[critical] names every reason once it is raised', () => {
    render(
      <SuddenMove
        shock={shock({
          score: 78,
          band: 'sudden',
          reasons: [
            '5m range is 3.0× what it was priced for',
            '5m volume is 4.0× its median',
            'implied volatility is up 9.0% in 15 minutes',
          ],
        })}
      />,
    );
    expect(screen.getByText('Sudden move')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
    expect(screen.getByText('5m volume is 4.0× its median')).toBeInTheDocument();
    expect(screen.getByText('implied volatility is up 9.0% in 15 minutes')).toBeInTheDocument();
  });

  it('carries each part’s own figure, so the score can be argued with', () => {
    render(<SuddenMove shock={shock({ score: 55, band: 'high' })} />);
    expect(screen.getByText('0.40× the 5-minute expected move')).toBeInTheDocument();
    expect(screen.getByText('1.02 puts per call')).toBeInTheDocument();
  });

  it('[critical] says a reading is missing rather than showing it as calm', () => {
    render(<SuddenMove shock={shock({ score: 55, band: 'high' })} />);
    // volatility and open interest have no history on a young desk
    expect(screen.getAllByText('no reading yet')).toHaveLength(2);
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
  });

  it('names the band it is in', () => {
    for (const [band, label] of [['watch', 'Watch'], ['high', 'High risk'], ['sudden', 'Sudden move']] as const) {
      const { unmount } = render(<SuddenMove shock={shock({ score: 60, band })} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it('reads direction as its own question', () => {
    render(<SuddenMove shock={shock({ score: 72, band: 'sudden', direction: -0.7, directionLabel: 'downside pressure' })} />);
    expect(screen.getByText('downside pressure')).toBeInTheDocument();
  });

  it('says on its face that nothing trades on it', () => {
    render(<SuddenMove shock={shock({ score: 72, band: 'sudden' })} />);
    expect(screen.getByText(/Nothing on the trading side reads this/)).toBeInTheDocument();
  });
});
