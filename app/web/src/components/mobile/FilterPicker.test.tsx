import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FilterBar, FilterPicker, METHODS, STRATEGIES, pickedWords, type FilterNoun, type FilterOption } from '@/components/mobile/FilterPicker';

/**
 * The phone's tick-several filter (owner, 8 Oct 2026): one button, a list to tick any number in -- strategies, or
 * entry methods -- none ticked being all of them.
 */

const OPTIONS: FilterOption[] = [
  { key: 's1', name: '15m time', note: '12 trades · +₹265.00', tone: 'up' },
  { key: 's2', name: '1h time', note: '4 trades · −₹313.00', tone: 'down' },
  { key: 'manual', name: 'By hand', note: '1 trade · +₹12.00', tone: 'up' },
];
let latest: string[] = [];
function Host({ start = [] as string[], options = OPTIONS, noun = STRATEGIES }: { start?: string[]; options?: FilterOption[]; noun?: FilterNoun }) {
  const [picked, setPicked] = useState(start);
  latest = picked;
  return <FilterPicker noun={noun} options={options} picked={picked} onChange={setPicked} />;
}
const trigger = () => screen.getByRole('button', { name: /^Strategy filter:/ });
const option = (name: RegExp) => within(screen.getByRole('listbox', { name: 'Strategies' })).getByRole('option', { name });
const tick = (name: RegExp) => fireEvent.click(option(name).querySelector('button')!);

describe('FilterPicker', () => {
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

  it('every row is a thumb high, and the chip as tall as the screen\'s other chips', () => {
    render(<Host />);
    expect(trigger().className).toMatch(/\bh-10\b/);
    fireEvent.click(trigger());
    for (const o of screen.getAllByRole('option')) expect(o.querySelector('button')!.className).toMatch(/min-h-\[44px\]/);
  });

  it('[critical] the same control for entry methods: its own words on the button and the list', () => {
    const methods: FilterOption[] = [{ key: 'pd', name: '#16 Previous day H/L rejection' }, { key: 'vwap', name: '#19 VWAP reclaim / loss' }];
    render(<Host noun={METHODS} options={methods} />);
    const button = screen.getByRole('button', { name: 'Method filter: All methods' });
    fireEvent.click(button);
    const list = within(screen.getByRole('listbox', { name: 'Methods' }));
    expect(list.getAllByRole('option').map((o) => o.textContent)).toEqual(['All methods2 in this list', '#16 Previous day H/L rejection', '#19 VWAP reclaim / loss']);
    fireEvent.click(list.getByRole('option', { name: /#19/ }).querySelector('button')!);
    expect(latest).toEqual(['vwap']);
    expect(screen.getByRole('button', { name: 'Method filter: #19 VWAP reclaim / loss' })).toBeInTheDocument();
    expect(pickedWords(methods, ['pd', 'vwap'], METHODS)).toBe('2 of 2 methods');
    // A short list has no search box.
    expect(screen.queryByRole('textbox', { name: 'Search methods' })).not.toBeInTheDocument();
  });

  it('[critical] a long list can be searched by name; what is ticked while searching stays ticked', () => {
    const many: FilterOption[] = Array.from({ length: 12 }, (_, i) => ({ key: `m${i + 1}`, name: `#${i + 1} ${i === 4 ? 'Liquidity sweep' : i === 9 ? 'Liquidity replenishment' : `Method ${i + 1}`}` }));
    render(<Host noun={METHODS} options={many} />);
    fireEvent.click(screen.getByRole('button', { name: /^Method filter:/ }));
    const search = screen.getByRole('textbox', { name: 'Search methods' });
    expect(search).toHaveAttribute('placeholder', 'Search 12 methods');
    fireEvent.change(search, { target: { value: 'liquid' } });
    const list = within(screen.getByRole('listbox', { name: 'Methods' }));
    expect(list.getAllByRole('option').map((o) => o.textContent)).toEqual(['#5 Liquidity sweep', '#10 Liquidity replenishment']);
    fireEvent.click(list.getByRole('option', { name: /#10/ }).querySelector('button')!);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No method named “zzz”.')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    expect(list.getAllByRole('option')).toHaveLength(13);
    expect(latest).toEqual(['m10']);
    expect(list.getByRole('option', { name: /#10/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('[critical] the chip says its kind, then the one name chosen or how many; and the row takes every choice off at once', () => {
    let cleared = 0;
    function Row() {
      const [a, setA] = useState<string[]>(['s2']);
      const [b, setB] = useState<string[]>(['pd', 'vwap']);
      const methods: FilterOption[] = [{ key: 'pd', name: '#16 Previous day H/L rejection' }, { key: 'vwap', name: '#19 VWAP reclaim / loss' }];
      const any = a.length + b.length > 0;
      return (
        <FilterBar onClear={any ? () => { cleared++; setA([]); setB([]); } : null}>
          <FilterPicker noun={STRATEGIES} options={OPTIONS} picked={a} onChange={setA} />
          <FilterPicker noun={METHODS} options={methods} picked={b} onChange={setB} />
        </FilterBar>
      );
    }
    render(<Row />);
    const row = within(screen.getByRole('group', { name: 'Filters' }));
    // one chosen: the name; several: the count -- the whole of it still read out
    expect(row.getByRole('button', { name: 'Strategy filter: 1h time' })).toHaveTextContent('Strategy1h time');
    expect(row.getByRole('button', { name: 'Method filter: 2 of 2 methods' })).toHaveTextContent('Method2');
    fireEvent.click(row.getByRole('button', { name: 'Clear all' }));
    expect(cleared).toBe(1);
    expect(row.getByRole('button', { name: 'Strategy filter: All strategies' })).toHaveTextContent(/^Strategy$/);
    expect(row.getByRole('button', { name: 'Method filter: All methods' })).toHaveTextContent(/^Method$/);
    // nothing chosen: nothing to clear
    expect(row.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });
});
