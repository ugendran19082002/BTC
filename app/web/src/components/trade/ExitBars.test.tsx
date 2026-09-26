import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ExitBars } from '@/components/trade/ExitBars';
import type { ExitInput } from '@/lib/exit-input';

/**
 * The exits' job is to turn a number into the two things a person actually
 * decides on: the price it exits at, and the money that changes hands. They
 * are typed now, as a percentage or as fixed points -- no slider, and no
 * ceiling on the stop short of the 2000% typo guard.
 */

const off: ExitInput = { on: false, mode: 'pct', pct: 0, points: 0, price: 0 };
const base = {
  entry: 10,
  size: 5,
  // one BTC per contract keeps these sums readable; the conversion has its own test
  contractValue: 1,
  target: off,
  stop: off,
  onTarget: vi.fn(),
  onStop: vi.fn(),
};

/** The component with its state wired up, the way the ticket holds it. */
function Live({ target = off, stop = off, entry = 10, liquidationPrice }: {
  target?: ExitInput; stop?: ExitInput; entry?: number | null; liquidationPrice?: number | null;
}) {
  const [t, setT] = useState(target);
  const [s, setS] = useState(stop);
  return (
    <ExitBars {...base} entry={entry} target={t} stop={s} liquidationPrice={liquidationPrice}
              onTarget={(p) => setT((x) => ({ ...x, ...p }))} onStop={(p) => setS((x) => ({ ...x, ...p }))} />
  );
}

const type = (label: string, text: string) => {
  const box = screen.getByRole('textbox', { name: label });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: text } });
  return box as HTMLInputElement;
};

describe('off by default', () => {
  it('shows two unticked boxes, and no slider anywhere', () => {
    render(<ExitBars {...base} />);
    expect(screen.getByRole('checkbox', { name: /take profit/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /stop loss/i })).not.toBeChecked();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('names the close-out as the real exit when there is no stop', () => {
    render(<ExitBars {...base} liquidationPrice={196.5} />);
    expect(screen.getByText(/liquidates/)).toBeInTheDocument();
    expect(screen.getByText('196.50')).toBeInTheDocument();
  });

  it('ticking a box asks for it to be turned on', () => {
    const onStop = vi.fn();
    render(<ExitBars {...base} onStop={onStop} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /stop loss/i }));
    expect(onStop).toHaveBeenCalledWith({ on: true });
  });

  it('a number set earlier does not apply while the box is unticked', () => {
    render(<ExitBars {...base} target={{ ...off, pct: 0.8 }} stop={{ ...off, pct: 1.5 }} />);
    expect(screen.queryByText('2.00')).toBeNull();
    expect(screen.queryByText('25.00')).toBeNull();
  });
});

describe('the target, in percent', () => {
  it('shows the buy-back price and the money kept', () => {
    render(<ExitBars {...base} target={{ ...off, on: true, pct: 0.8 }} />);
    expect(screen.getByText('−80%')).toBeInTheDocument();
    // sold at 10, bought back at 2, five contracts
    expect(screen.getByText('2.00')).toBeInTheDocument();
    expect(screen.getByText('$40.00')).toBeInTheDocument();
  });

  it('[critical] typing 82.5 keeps the decimal on the way there', () => {
    render(<Live target={{ ...off, on: true, pct: 0.8 }} />);
    const box = type('target percent', '82.');
    expect(box.value).toBe('82.');
    fireEvent.change(box, { target: { value: '82.5' } });
    expect(screen.getByText('−82.5%')).toBeInTheDocument();
    expect(screen.getByText('1.80')).toBeInTheDocument(); // 10 × (1 − 0.825) = 1.75 → 1.8
  });

  it('[critical] above 99% is refused under the box, not clamped', () => {
    render(<Live target={{ ...off, on: true, pct: 0.8 }} />);
    type('target percent', '100');
    expect(screen.getByRole('alert')).toHaveTextContent('Take profit must be between 0 and 99% of the credit.');
  });

  it('letters are not taken', () => {
    render(<Live target={{ ...off, on: true, pct: 0.8 }} />);
    const box = type('target percent', '8a');
    expect(box.value).toBe('80');
  });
});

describe('the stop, in percent', () => {
  it('shows the buy-back price and the money lost', () => {
    render(<ExitBars {...base} stop={{ ...off, on: true, pct: 1.5 }} />);
    expect(screen.getByText('+150%')).toBeInTheDocument();
    // sold at 10, stopped at 25, five contracts
    expect(screen.getByText('25.00')).toBeInTheDocument();
    expect(screen.getByText('$75.00')).toBeInTheDocument();
  });

  it('[critical] a stop above 100% -- and above the old 300% end of the bar -- is taken', () => {
    render(<Live stop={{ ...off, on: true, pct: 1.5 }} />);
    type('stop percent', '450');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('+450%')).toBeInTheDocument();
    expect(screen.getByText('55.00')).toBeInTheDocument();
  });

  it('past 2000% is a typo, and says so', () => {
    render(<Live stop={{ ...off, on: true, pct: 1.5 }} />);
    type('stop percent', '2500');
    expect(screen.getByRole('alert')).toHaveTextContent(/2000%/);
  });

  it('warns while it is typed if the stop is past the close-out', () => {
    render(<ExitBars {...base} stop={{ ...off, on: true, pct: 2 }} liquidationPrice={25} />);
    expect(screen.getByText(/would never fire/)).toBeInTheDocument();
    expect(screen.getByText(/past the 25.00 liquidation/)).toBeInTheDocument();
  });

  it('does not warn when the stop sits safely inside the close-out', () => {
    render(<ExitBars {...base} stop={{ ...off, on: true, pct: 0.5 }} liquidationPrice={196} />);
    expect(screen.queryByText(/would never fire/)).toBeNull();
  });
});

describe('fixed points', () => {
  it('[critical] switching to Fixed reads points from the entry: sold at 10, stop 10 pts buys back at 20', () => {
    render(<Live stop={{ ...off, on: true, mode: 'pct', pct: 1.5, points: 10 }} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Fixed' }));
    expect(screen.getByRole('textbox', { name: 'stop points' })).toHaveValue('10');
    expect(screen.getByText('+10 pts')).toBeInTheDocument();
    expect(screen.getByText('20.00')).toBeInTheDocument();
  });

  it('switching back finds the percentage where it was left', () => {
    render(<Live stop={{ ...off, on: true, mode: 'points', pct: 1.5, points: 10 }} />);
    fireEvent.click(screen.getByRole('radio', { name: '%' }));
    expect(screen.getByRole('textbox', { name: 'stop percent' })).toHaveValue('150');
  });

  it('a target in points buys back under the entry', () => {
    render(<ExitBars {...base} target={{ ...off, on: true, mode: 'points', points: 6 }} />);
    expect(screen.getByText('−6 pts')).toBeInTheDocument();
    expect(screen.getByText('4.00')).toBeInTheDocument();
    expect(screen.getByText('$30.00')).toBeInTheDocument();
  });

  it('a target of more points than the premium says it rests at 1% of it', () => {
    render(<ExitBars {...base} target={{ ...off, on: true, mode: 'points', points: 15 }} />);
    expect(screen.getByText(/more than the premium/)).toBeInTheDocument();
    expect(screen.getByText('0.10')).toBeInTheDocument();
  });
});

describe('Price: the level itself', () => {
  it('[critical] entry 16, stop typed as 70: shows 70, and that it is 54 points (+337.5%) over', () => {
    render(<Live entry={16} stop={{ ...off, on: true, mode: 'points', points: 10 }} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Price' }));
    // opens on the level the old mode meant: 16 + 10
    expect(screen.getByRole('textbox', { name: 'stop price' })).toHaveValue('26');
    type('stop price', '70');
    expect(screen.getByText('at 70.00 (+54 pts)')).toBeInTheDocument();
    expect(screen.getByText(/entry 16.00 \+ 54 pts \(\+337.5%\)/)).toBeInTheDocument();
  });

  it('a target typed as 4 against 16 is 12 points under', () => {
    render(<Live entry={16} target={{ ...off, on: true, mode: 'price', price: 4 }} />);
    expect(screen.getByText('at 4.00 (-12 pts)')).toBeInTheDocument();
    expect(screen.getByText(/entry 16.00 − 12 pts \(-75%\)/)).toBeInTheDocument();
  });

  it('[critical] a stop typed under the entry is refused under the box', () => {
    render(<Live entry={16} stop={{ ...off, on: true, mode: 'price', price: 70 }} />);
    type('stop price', '12');
    expect(screen.getByRole('alert')).toHaveTextContent('A stop of 12 must be over the 16 entry');
  });

  it('a target typed over the entry is refused too', () => {
    render(<Live entry={16} target={{ ...off, on: true, mode: 'price', price: 4 }} />);
    type('target price', '18');
    expect(screen.getByRole('alert')).toHaveTextContent('A target of 18 must be under the 16 entry');
  });
});

describe('before it fills', () => {
  it('[critical] a Price stays where it was typed; a % or Fixed moves with the fill -- said on the ticket only', () => {
    const { rerender } = render(<ExitBars {...base} entry={15} followsFill stop={{ ...off, on: true, mode: 'price', price: 70 }} />);
    expect(screen.getByText(/a Price stays where you typed it, and its balance is re-measured from the fill/)).toBeInTheDocument();
    expect(screen.queryByText(/moves with the fill/)).toBeNull();
    rerender(<ExitBars {...base} entry={15} followsFill stop={{ ...off, on: true, mode: 'points', points: 55 }} />);
    expect(screen.getByText(/a % or Fixed exit moves with the fill and keeps its distance/)).toBeInTheDocument();
    rerender(<ExitBars {...base} entry={15} stop={{ ...off, on: true, mode: 'price', price: 70 }} />);
    expect(screen.queryByText(/re-measured from the fill/)).toBeNull();
  });
  it('[critical] switching the entry from the offer to the bid re-reads the distance at once', () => {
    const { rerender } = render(<ExitBars {...base} entry={15} stop={{ ...off, on: true, mode: 'price', price: 70 }} />);
    expect(screen.getByText('at 70.00 (+55 pts)')).toBeInTheDocument();
    rerender(<ExitBars {...base} entry={14} stop={{ ...off, on: true, mode: 'price', price: 70 }} />);
    expect(screen.getByText('at 70.00 (+56 pts)')).toBeInTheDocument();
  });
});

describe('a quoted price is dollars per BTC', () => {
  it('turns a 0.001 BTC contract into the money that changes hands', () => {
    // sold at 10, target 80% -> buys back at 2, five contracts of 0.001 BTC
    render(<ExitBars {...base} contractValue={0.001} target={{ ...off, on: true, pct: 0.8 }} />);
    expect(screen.getByText('2.00')).toBeInTheDocument();
    expect(screen.getByText('$0.040')).toBeInTheDocument();
  });
});

describe('before a quote arrives', () => {
  it('shows no price rather than a made-up one', () => {
    render(<ExitBars {...base} entry={null} target={{ ...off, on: true, pct: 0.5 }} stop={{ ...off, on: true, pct: 0.5 }} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('a stop the desk refused to place', () => {
  it('[critical] says why, and does not read like a trade that chose to run naked', () => {
    /*
     * `stopAt: 70` means seventy whatever the entry -- until the entry fills
     * at seventy-five and the stop is under the position. Placed, it would
     * close the trade a second after opening it, so the engine leaves it off.
     * The screen has to say that: an unprotected position that looks
     * deliberate is the worst thing the desk can show.
     */
    render(
      <ExitBars
        target={{ on: false, mode: 'price', pct: 0, points: 0, price: 0 }}
        stop={{ on: false, mode: 'price', pct: 0, points: 0, price: 0 }}
        onTarget={() => {}} onStop={() => {}}
        entry={75} size={10}
        exitProblem="A stop of 70 must be over the 75 entry: at or under it, it fires at once."
      />,
    );
    expect(screen.getByText(/must be over the 75 entry/)).toBeInTheDocument();
    expect(screen.getByText(/would have fired at once|fired at once/)).toBeInTheDocument();
    expect(screen.queryByText(/runs until Delta liquidates it/)).toBeNull();
  });
});
