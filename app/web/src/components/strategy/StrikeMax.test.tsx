import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { StrikeMax } from '@/components/strategy/StrikeMax';
import { LimitsBlock } from '@/components/mobile/OpenLimits';
import { fixedFromPct, strikeCapOf, strikeFixedProblem, strikeMaxProblem, strikeMostOf, strikeWords } from '@/lib/side-max';

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

describe('StrikeMax, by a per cent or a fixed number (26 Nov 2026, owner: "% and fixed rendu-um venum")', () => {
  const show = (over: Partial<Parameters<typeof StrikeMax>[0]> = {}) => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onSaveFixed = vi.fn().mockResolvedValue(true);
    const onInvalid = vi.fn();
    render(<StrikeMax pct={12} cap={400} busiest={null} onSave={onSave} onSaveFixed={onSaveFixed} onInvalid={onInvalid} {...over} />);
    return { onSave, onSaveFixed, onInvalid, box: within(screen.getByRole('group', { name: 'most on one strike' })) };
  };

  it('[critical] switching to Fixed saves the number the per cent holds now -- 12% of 400 is 48: nothing moves', () => {
    const { onSaveFixed, onSave, box } = show();
    expect(box.getByRole('radio', { name: 'per cent of at most open' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box.getByRole('radio', { name: 'fixed number a strike' }));
    expect(onSaveFixed).toHaveBeenCalledWith(48);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('[critical] fixed: its numbers offered, a pick saved as a fixed number, the limit said as the number; back to % saves the per cent as it is', () => {
    const { onSaveFixed, onSave, box } = show({ fixed: 30, busiest: { symbol: 'P-BTC-83000-221026', open: 30 } });
    expect(box.getByRole('radio', { name: 'fixed number a strike' })).toHaveAttribute('aria-checked', 'true');
    expect(box.getByLabelText('most on one strike')).toHaveValue('30');
    expect(box.getAllByRole('option').map((o) => o.textContent).slice(0, 8))
      .toEqual(['5 a strike', '10 a strike', '15 a strike', '20 a strike', '25 a strike', '30 a strike', '40 a strike', '48 a strike · Delta max']);
    expect(box.getByLabelText('busiest strike now, of the most')).toHaveTextContent('PE 83000: 30 of 30 · full');
    fireEvent.change(box.getByLabelText('most on one strike'), { target: { value: '20' } });
    expect(onSaveFixed).toHaveBeenCalledWith(20);
    fireEvent.click(box.getByRole('radio', { name: 'per cent of at most open' }));
    expect(onSave).toHaveBeenCalledWith(12);
  });

  it('[critical] a custom fixed number is checked first: 49 refused in words, nothing saved', () => {
    const { onSaveFixed, onInvalid, box } = show({ fixed: 30 });
    fireEvent.change(box.getByLabelText('most on one strike'), { target: { value: 'custom' } });
    const input = screen.getByLabelText('most on one strike, trades');
    fireEvent.change(input, { target: { value: '49' } });
    fireEvent.blur(input);
    expect(onInvalid).toHaveBeenCalledWith(strikeFixedProblem(49));
    expect(onSaveFixed).not.toHaveBeenCalled();
    // Still open to type in, the saved number back in it.
    const again = screen.getByLabelText('most on one strike, trades');
    expect(again).toHaveValue('30');
    fireEvent.change(again, { target: { value: '33' } });
    fireEvent.blur(again);
    expect(onSaveFixed).toHaveBeenCalledWith(33);
  });

  it('a fixed number holds with no "at most open", under the cap where there is one; a server from before it offers only the per cent', () => {
    expect([strikeMostOf(0, 12, 30), strikeMostOf(20, 12, 30), strikeMostOf(400, 12, null), fixedFromPct(400, 100), fixedFromPct(100, 10)]).toEqual([30, 20, 48, 48, 10]);
    render(<StrikeMax pct={12} cap={400} busiest={null} onSave={vi.fn()} onInvalid={vi.fn()} />);
    expect(screen.queryByRole('radiogroup', { name: 'strike max by' })).toBeNull();
  });

  it('the phone: a fixed number said as one', () => {
    render(<LimitsBlock d={{ signalMaxOpen: 400, openNow: 30, signalSideMaxPct: { CE: 80, PE: 80 }, openBySide: { CE: 0, PE: 30 }, signalStrikeMaxPct: 12, signalStrikeFixed: 30, busiestStrike: { symbol: 'P-BTC-83000-221026', open: 30 } }} />);
    expect(screen.getByRole('progressbar', { name: 'busiest strike, of the most on one strike' })).toHaveAttribute('aria-valuemax', '30');
    expect(screen.getByText(/PE 83000 · max 30 a strike \(fixed\), then the next out/)).toBeInTheDocument();
  });
});
