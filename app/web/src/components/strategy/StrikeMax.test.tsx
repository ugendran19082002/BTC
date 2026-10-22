import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { StrikeMax } from '@/components/strategy/StrikeMax';
import { LimitsBlock } from '@/components/mobile/OpenLimits';
import { strikeCapOf, strikeMaxProblem, strikeWords } from '@/lib/side-max';

/**
 * The most open at once on one strike (owner's list #1, 22 Oct 2026): a per cent of "at most open", as each side's
 * limit is (owner: "strike max as a %, based on max open"). The runner holds each strike to it (server:
 * signal-strategy.test.ts); here, the same sum, the control that sets it and what the desk and the phone say back.
 */
describe('the most on one strike, worked out', () => {
  it('[critical] its per cent of "at most open" to the nearest trade, at least one; none without a limit, or at 100%', () => {
    expect(strikeCapOf(100, 10)).toBe(10);   // account 1, the default
    expect(strikeCapOf(88, 10)).toBe(9);     // account 2
    expect(strikeCapOf(5, 1)).toBe(1);
    expect(strikeCapOf(0, 10)).toBeNull();
    expect(strikeCapOf(100, 100)).toBeNull();
    expect(strikeMaxProblem(0)).toBe('The most on one strike must be a whole number of per cent of "at most open", from 1 to 100.');
    expect(strikeMaxProblem(10)).toBeNull();
  });
});

describe('StrikeMax', () => {
  const show = (over: Partial<Parameters<typeof StrikeMax>[0]> = {}) => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onInvalid = vi.fn();
    render(<StrikeMax pct={10} cap={100} busiest={{ symbol: 'P-BTC-83000-221026', open: 7 }} onSave={onSave} onInvalid={onInvalid} {...over} />);
    return { onSave, onInvalid, box: within(screen.getByRole('group', { name: 'most on one strike' })) };
  };

  it('[critical] the default, 10% of 100: the busiest strike in words, of the ten; the per cents offered', () => {
    const { box } = show();
    expect(box.getByLabelText('most on one strike')).toHaveValue('10');
    expect(box.getByLabelText('busiest strike now, of the most')).toHaveTextContent('PE 83000: 7 of 10');
    expect(box.getAllByRole('option').map((o) => o.textContent))
      .toEqual(['5%', '10% · default', '15%', '20%', '30%', '50%', '100% · no limit', 'Custom…']);
  });

  it('[critical] at the most: full; on the 88 account, nine', () => {
    show({ cap: 88, busiest: { symbol: 'C-BTC-85200-221026', open: 9 } });
    expect(screen.getByLabelText('busiest strike now, of the most')).toHaveTextContent('CE 85200: 9 of 9 · full');
  });

  it('none open; no "at most open"; 100%', () => {
    const { unmount } = render(<StrikeMax pct={10} cap={100} busiest={null} onSave={vi.fn()} onInvalid={vi.fn()} />);
    expect(screen.getByLabelText('busiest strike now, of the most')).toHaveTextContent('10 a strike · none open');
    unmount();
    const again = render(<StrikeMax pct={10} cap={0} busiest={{ symbol: 'P-BTC-83000-221026', open: 12 }} onSave={vi.fn()} onInvalid={vi.fn()} />);
    expect(screen.getByLabelText('busiest strike now, of the most')).toHaveTextContent('no limit (no "at most open" set) · PE 83000: 12');
    again.unmount();
    render(<StrikeMax pct={100} cap={100} busiest={null} onSave={vi.fn()} onInvalid={vi.fn()} />);
    expect(screen.getByLabelText('busiest strike now, of the most')).toHaveTextContent(/^no limit$/);
  });

  it('[critical] a per cent picked is saved; a custom one is checked first', () => {
    const { onSave, onInvalid, box } = show();
    fireEvent.change(box.getByLabelText('most on one strike'), { target: { value: '5' } });
    expect(onSave).toHaveBeenCalledWith(5);
    fireEvent.change(box.getByLabelText('most on one strike'), { target: { value: 'custom' } });
    const input = screen.getByLabelText('most on one strike, per cent');
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.blur(input);
    expect(onSave).toHaveBeenLastCalledWith(12);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('the phone: the busiest strike as a bar of its share of "at most open"', () => {
    expect(strikeWords('P-BTC-83000-221026')).toBe('PE 83000');
    render(<LimitsBlock d={{ signalMaxOpen: 100, openNow: 7, signalSideMaxPct: { CE: 80, PE: 80 }, openBySide: { CE: 0, PE: 7 }, signalStrikeMaxPct: 10, busiestStrike: { symbol: 'P-BTC-83000-221026', open: 7 } }} />);
    const bar = screen.getByRole('progressbar', { name: 'busiest strike, of the most on one strike' });
    expect(bar).toHaveAttribute('aria-valuenow', '7');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
    expect(screen.getByText(/PE 83000 · max 10% = 10 a strike, then the next out/)).toBeInTheDocument();
  });
});

describe('StrikeMax, when a strike is full', () => {
  it('[critical] the next strike out by default, or skip -- saved as picked; nothing to pick without a most', () => {
    const onSaveFull = vi.fn().mockResolvedValue(true);
    const { unmount } = render(<StrikeMax pct={10} cap={100} busiest={null} onSave={vi.fn()} onSaveFull={onSaveFull} onInvalid={vi.fn()} />);
    const pick = screen.getByLabelText('when a strike is full');
    expect(pick).toHaveValue('next');
    fireEvent.change(pick, { target: { value: 'skip' } });
    expect(onSaveFull).toHaveBeenCalledWith('skip');
    unmount();
    render(<StrikeMax pct={10} cap={0} busiest={null} onSave={vi.fn()} onSaveFull={onSaveFull} onInvalid={vi.fn()} />);
    expect(screen.queryByLabelText('when a strike is full')).toBeNull();
  });
});
