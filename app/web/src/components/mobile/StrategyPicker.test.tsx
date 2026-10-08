import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { StrategyPicker, pickedWords, type StrategyOption } from '@/components/mobile/StrategyPicker';

/**
 * The phone's strategy filter (owner, 8 Oct 2026): one button, a list to tick any number of strategies in, none
 * ticked being all of them.
 */

const OPTIONS: StrategyOption[] = [
  { key: 's1', name: '15m time', note: '12 trades · +₹265.00', tone: 'up' },
  { key: 's2', name: '1h time', note: '4 trades · −₹313.00', tone: 'down' },
  { key: 'manual', name: 'By hand', note: '1 trade · +₹12.00', tone: 'up' },
];
let latest: string[] = [];
function Host({ start = [] as string[], options = OPTIONS }: { start?: string[]; options?: StrategyOption[] }) {
  const [picked, setPicked] = useState(start);
  latest = picked;
  return <StrategyPicker options={options} picked={picked} onChange={setPicked} />;
}
const trigger = () => screen.getByRole('button', { name: /^Strategy filter:/ });
const option = (name: RegExp) => within(screen.getByRole('listbox', { name: 'Strategies' })).getByRole('option', { name });
const tick = (name: RegExp) => fireEvent.click(option(name).querySelector('button')!);

describe('StrategyPicker', () => {
  it('says what is chosen: all, the one name, or how many of how many', () => {
    expect(pickedWords(OPTIONS, [])).toBe('All strategies');
    expect(pickedWords(OPTIONS, ['s2'])).toBe('1h time');
    expect(pickedWords(OPTIONS, ['s1', 'manual'])).toBe('2 of 3 strategies');
    // A choice no longer in the list is not counted.
    expect(pickedWords(OPTIONS, ['gone'])).toBe('All strategies');
    expect(pickedWords(OPTIONS, ['gone', 's1'])).toBe('15m time');
  });

  it('[critical] several can be ticked without the list closing; Done closes it', () => {
    render(<Host />);
    expect(trigger()).toHaveAccessibleName('Strategy filter: All strategies');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(trigger());
    expect(option(/All strategies/)).toHaveAttribute('aria-selected', 'true');
    expect(option(/15m time/)).toHaveTextContent('12 trades · +₹265.00');
    tick(/15m time/);
    expect(latest).toEqual(['s1']);
    expect(screen.getByRole('listbox', { name: 'Strategies' })).toBeInTheDocument();
    tick(/By hand/);
    expect(latest).toEqual(['s1', 'manual']);
    expect(option(/15m time/)).toHaveAttribute('aria-selected', 'true');
    expect(option(/1h time/)).toHaveAttribute('aria-selected', 'false');
    expect(option(/All strategies/)).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Strategy filter: 2 of 3 strategies');
  });

  it('[critical] a second tap takes a strategy off; "All strategies" and Clear take them all off', () => {
    render(<Host start={['s1', 's2']} />);
    fireEvent.click(trigger());
    tick(/15m time/);
    expect(latest).toEqual(['s2']);
    tick(/All strategies/);
    expect(latest).toEqual([]);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    tick(/1h time/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(latest).toEqual([]);
  });

  it('a choice no longer in the list is dropped at the next tick, and with nothing to choose from there is no control', () => {
    const { unmount } = render(<Host start={['gone', 's2']} />);
    fireEvent.click(trigger());
    tick(/By hand/);
    expect(latest).toEqual(['s2', 'manual']);
    unmount();
    render(<Host options={[]} />);
    expect(screen.queryByRole('button', { name: /^Strategy filter:/ })).not.toBeInTheDocument();
  });

  it('every row and the button itself are a thumb high', () => {
    render(<Host />);
    expect(trigger().className).toMatch(/\bh-11\b/);
    fireEvent.click(trigger());
    for (const o of screen.getAllByRole('option')) expect(o.querySelector('button')!.className).toMatch(/min-h-\[44px\]/);
  });
});
