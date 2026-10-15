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
    expect(screen.getByText('No method matches “zzz”.')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    expect(list.getAllByRole('option')).toHaveLength(13);
    expect(latest).toEqual(['m10']);
    expect(list.getByRole('option', { name: /#10/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('[critical] the chip says its kind, the one name chosen, or its kind and how many; and the row takes every choice off at once', () => {
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
    expect(row.getByRole('button', { name: 'Strategy filter: 1h time' })).toHaveTextContent(/^1h time$/);
    expect(row.getByRole('button', { name: 'Method filter: 2 of 2 methods' })).toHaveTextContent(/^Method2$/);
    // the way to take them all off comes first in the row, so it is on screen however far the row runs
    expect(row.getAllByRole('button')[0]).toHaveAccessibleName('Clear all');
    fireEvent.click(row.getByRole('button', { name: 'Clear all' }));
    expect(cleared).toBe(1);
    expect(row.getByRole('button', { name: 'Strategy filter: All strategies' })).toHaveTextContent(/^Strategy$/);
    expect(row.getByRole('button', { name: 'Method filter: All methods' })).toHaveTextContent(/^Method$/);
    // nothing chosen: nothing to clear
    expect(row.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });
});

describe('searching by more than the name', () => {
  it('[critical] a strategy is found by typing its account\'s name, as well as its own', () => {
    const options: FilterOption[] = ['5m time', '15m time', '1h time', '2h time', '4h time'].flatMap((n, i) => [
      { key: `s${i}`, name: n, note: 'Savings · 8 methods', also: 'Savings' },
      { key: `e${i}`, name: `${n} delta`, note: 'Expenses · 8 methods', also: 'Expenses' },
    ]);
    render(<FilterPicker noun={STRATEGIES} options={options} picked={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Strategy filter: All strategies' }));
    const search = screen.getByLabelText('Search strategies');
    const names = () => within(screen.getByRole('listbox')).queryAllByRole('option').map((o) => o.textContent ?? '');
    fireEvent.change(search, { target: { value: 'expen' } });
    expect(names().filter((t) => !t.startsWith('All')).every((t) => t.includes('delta'))).toBe(true);
    expect(names().some((t) => t.startsWith('5m time delta'))).toBe(true);
    fireEvent.change(search, { target: { value: '1h' } });
    expect(names().filter((t) => !t.startsWith('All')).length).toBe(2);
    fireEvent.change(search, { target: { value: 'nobody' } });
    expect(screen.getByText('No strategy matches “nobody”.')).toBeInTheDocument();
  });
});

describe('profit and loss tabs', () => {
  const options: FilterOption[] = [
    { key: 'a', name: '#1 Breakout', note: '12 trades · +₹265', tone: 'up', value: 265 },
    { key: 'b', name: '#2 Retest', note: '8 trades · −₹40', tone: 'down', value: -40 },
    { key: 'c', name: '#3 Sweep', note: '30 trades · +₹900', tone: 'up', value: 900 },
    { key: 'd', name: '#4 FVG', note: '5 trades · −₹310', tone: 'down', value: -310 },
    { key: 'e', name: '#5 Order block', note: 'no trade' },
  ];
  function Host({ split = true }: { split?: boolean }) {
    const [picked, setPicked] = useState<string[]>([]);
    return <FilterPicker noun={METHODS} options={options} picked={picked} onChange={setPicked} split={split} />;
  }
  const names = () => within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent ?? '');

  it('[critical] All, In profit (the most first) and In loss (the worst first), each with its count', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    const tabs = within(screen.getByRole('group', { name: 'Methods by profit and loss' }));
    expect(tabs.getAllByRole('button').map((b) => b.textContent)).toEqual(['All 5', 'In profit 2', 'In loss 2']);   // no win rates: no Win tab
    expect(names().length).toBe(6);                                   // "All methods" and the five
    fireEvent.click(tabs.getByRole('button', { name: /In profit/ }));
    expect(names().slice(1).map((t) => t.slice(0, 8))).toEqual(['#3 Sweep', '#1 Break']);
    fireEvent.click(tabs.getByRole('button', { name: /In loss/ }));
    expect(names().slice(1).map((t) => t.slice(0, 6))).toEqual(['#4 FVG', '#2 Ret']);
    expect(tabs.getByRole('button', { name: /In loss/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('[critical] one tap chooses every method on a tab and no other', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Methods by profit and loss' })).getByRole('button', { name: /In profit/ }));
    fireEvent.click(screen.getByText('Only the 2 in profit'));
    expect(screen.getByRole('button', { name: 'Method filter: 2 of 5 methods' })).toBeInTheDocument();
    expect(within(screen.getByRole('listbox')).getAllByRole('option', { selected: true }).length).toBe(3);   // the row itself, and its two
  });

  it('no tabs where they were not asked for, or where nothing has made or lost', () => {
    const { unmount } = render(<Host split={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    expect(screen.queryByRole('group', { name: 'Methods by profit and loss' })).not.toBeInTheDocument();
    unmount();
    render(<FilterPicker noun={METHODS} options={[{ key: 'x', name: 'X' }, { key: 'y', name: 'Y' }]} picked={[]} onChange={() => {}} split />);
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    expect(screen.queryByRole('group', { name: 'Methods by profit and loss' })).not.toBeInTheDocument();
  });
});

describe('the Win tab: won at least a line, 30% to begin with', () => {
  // 3 of 10 is 30% exactly, 1 of 4 is 25%, 2 of 3 is 67%; one with no trade has no rate at all.
  const options: FilterOption[] = [
    { key: 'a', name: '#1 Breakout', tone: 'up', value: 265, winRate: 3 / 10 },
    { key: 'b', name: '#2 Retest', tone: 'down', value: -40, winRate: 1 / 4 },
    { key: 'c', name: '#3 Sweep', tone: 'up', value: 900, winRate: 2 / 3 },
    { key: 'd', name: '#4 FVG', tone: 'down', value: -310, winRate: 0.5 },
    { key: 'e', name: '#5 Order block' },
  ];
  function Host({ line }: { line?: number }) {
    const [picked, setPicked] = useState<string[]>([]);
    const [pct, setPct] = useState(line);
    return (
      <>
        <FilterPicker noun={METHODS} options={options} picked={picked} onChange={setPicked} split
          winAtLeast={pct} onWinAtLeast={line === undefined ? undefined : setPct} />
        <output aria-label="kept line">{pct ?? ''}</output>
      </>
    );
  }
  const open = () => {
    fireEvent.click(screen.getByRole('button', { name: /Method filter/ }));
    return within(screen.getByRole('group', { name: 'Methods by profit and loss' }));
  };
  const names = () => within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent ?? '');

  it('[critical] 30% by default, at or over it -- 3 of 10 counts -- the most won first', () => {
    render(<Host />);
    const tabs = open();
    expect(tabs.getAllByRole('button').map((b) => b.textContent)).toEqual(['All 5', 'In profit 2', 'In loss 2', 'Win ≥30% 3']);
    fireEvent.click(tabs.getByRole('button', { name: /Win/ }));
    expect(screen.getByRole('textbox', { name: 'Win rate at least, percent' })).toHaveValue('30');
    expect(names().slice(1).map((t) => t.slice(0, 6))).toEqual(['#3 Swe', '#4 FVG', '#1 Bre']);
    expect(names()[0]).toContain('Only the 3 that won 30% or more');
  });

  it('[critical] the line is typed: 50 keeps 50% and over, and is handed back to be kept', () => {
    render(<Host line={30} />);
    fireEvent.click(open().getByRole('button', { name: /Win/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Win rate at least, percent' }), { target: { value: '50' } });
    expect(names().slice(1).map((t) => t.slice(0, 6))).toEqual(['#3 Swe', '#4 FVG']);
    expect(screen.getByRole('button', { name: /Win ≥50%/ })).toBeInTheDocument();
    expect(screen.getByLabelText('kept line')).toHaveTextContent('50');
    // an empty box while typing is not 0%: the list holds until a number lands
    fireEvent.change(screen.getByRole('textbox', { name: 'Win rate at least, percent' }), { target: { value: '' } });
    expect(names().slice(1).length).toBe(2);
    // and nothing over 100, nothing but digits
    fireEvent.change(screen.getByRole('textbox', { name: 'Win rate at least, percent' }), { target: { value: '150' } });
    expect(screen.getByLabelText('kept line')).toHaveTextContent('100');
  });

  it('steps five at a time; one tap chooses every method on the tab', () => {
    render(<Host line={30} />);
    fireEvent.click(open().getByRole('button', { name: /Win/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Five less' }));
    expect(screen.getByRole('textbox', { name: 'Win rate at least, percent' })).toHaveValue('25');
    expect(names().slice(1).length).toBe(4);
    fireEvent.click(screen.getByText('Only the 4 that won 25% or more'));
    expect(screen.getByRole('button', { name: 'Method filter: 4 of 5 methods' })).toBeInTheDocument();
  });

  it('a line nothing reaches says so, and how to widen it', () => {
    render(<Host line={90} />);
    fireEvent.click(open().getByRole('button', { name: /Win/ }));
    expect(screen.getByText('No method won 90% or more here. Lower the line above.')).toBeInTheDocument();
  });
});

describe('the sort row (15 Oct 2026)', () => {
  it('[critical] P&L high and low, most and fewest trades, win % high -- one with no trade always last', async () => {
    const { sortOptions } = await import('@/components/mobile/FilterPicker');
    const xs = [
      { key: 'a', value: 265, trades: 12, winRate: 0.5 }, { key: 'b', value: -40, trades: 8, winRate: 0.25 },
      { key: 'c', value: 900, trades: 30, winRate: 0.4 }, { key: 'd', value: -310, trades: 5, winRate: 0.8 }, { key: 'e' },
    ];
    const keys = (s: Parameters<typeof sortOptions>[1]) => sortOptions(xs, s).map((x) => x.key).join('');
    expect(keys('default')).toBe('abcde');
    expect(keys('pnl-high')).toBe('cabde');
    expect(keys('pnl-low')).toBe('dbace');
    expect(keys('trades-high')).toBe('cabde');
    expect(keys('trades-low')).toBe('dbace');
    expect(keys('win-high')).toBe('dacbe');
  });

  it('[critical] in the picker: a row of sorts under the tabs, the list in that order, handed back to be kept', () => {
    const options: FilterOption[] = [
      { key: 'a', name: '#1 Breakout', tone: 'up', value: 265, trades: 12, winRate: 0.5 },
      { key: 'b', name: '#2 Retest', tone: 'down', value: -40, trades: 40, winRate: 0.25 },
      { key: 'c', name: '#3 Sweep', tone: 'up', value: 900, trades: 3, winRate: 0.9 },
    ];
    const kept: string[] = [];
    function Host() {
      const [picked, setPicked] = useState<string[]>([]);
      return <FilterPicker noun={METHODS} options={options} picked={picked} onChange={setPicked} split onSort={(s) => kept.push(s)} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    const row = within(screen.getByRole('group', { name: 'Sort' }));
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual(['Default', 'P&L high', 'P&L low', 'Most trades', 'Fewest trades', 'Win % high']);
    const names = () => within(screen.getByRole('listbox')).getAllByRole('option').slice(1).map((o) => o.textContent!.slice(0, 3));
    fireEvent.click(row.getByRole('button', { name: 'Most trades' }));
    expect(names()).toEqual(['#2 ', '#1 ', '#3 ']);
    fireEvent.click(row.getByRole('button', { name: 'Win % high' }));
    expect(names()).toEqual(['#3 ', '#1 ', '#2 ']);
    expect(row.getByRole('button', { name: 'Win % high' })).toHaveAttribute('aria-pressed', 'true');
    expect(kept).toEqual(['trades-high', 'win-high']);
  });

  it('no sort row where the options carry no record', () => {
    render(<FilterPicker noun={METHODS} options={[{ key: 'x', name: 'X' }, { key: 'y', name: 'Y' }]} picked={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Method filter: All methods' }));
    expect(screen.queryByRole('group', { name: 'Sort' })).toBeNull();
  });
});
