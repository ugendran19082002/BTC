import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ColumnPicker } from '@/components/chain/ColumnPicker';
import {
  CHAIN_COLUMNS, DEFAULT_COLUMNS, DEFAULT_ORDER, moveColumn, normalise, normaliseOrder, shownCount,
  type ColumnState,
} from '@/components/chain/columns';

/**
 * Columns, one at a time.
 *
 * The presets were "key" and "all" and neither was what anyone wanted: key hid
 * open interest, all put twenty-seven columns on a phone. The two properties
 * worth pinning are that the bid can never be turned off — it is what a seller
 * receives, and a board without it cannot be acted on — and that a choice
 * stored by an older build survives a column being added.
 */

const open = (value: ColumnState = DEFAULT_COLUMNS, onChange = vi.fn()) => {
  render(<ColumnPicker value={value} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'which columns to show' }));
  return onChange;
};

describe('choosing columns', () => {
  it('lists every column the board has', () => {
    open();
    // a few columns are named the same as their heading — Score, Signal, EV —
    // so the label and the short form both match
    for (const c of CHAIN_COLUMNS) {
      expect(screen.getAllByText(c.label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByRole('button').filter((b) => b.className.includes('colpick-row')))
      .toHaveLength(CHAIN_COLUMNS.length);
  });

  it('says what each column is for, not just its heading', () => {
    open();
    expect(screen.getByText('What you receive when you sell.')).toBeInTheDocument();
    expect(screen.getByText(/how easily you get back out/)).toBeInTheDocument();
  });

  it('turns one on without touching the rest', () => {
    const onChange = open();
    // "Open interest" and "Open interest, change" are both columns, so the
    // name has to be anchored or the click is ambiguous
    fireEvent.click(
      screen.getAllByRole('button')
        .find((b) => b.querySelector('.colpick-label')?.textContent?.startsWith('Open interestOI'))!,
    );
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_COLUMNS, oi: true });
  });

  it('turns one off again', () => {
    const onChange = open();
    fireEvent.click(screen.getByRole('button', { name: /Expected value/ }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_COLUMNS, ev: false });
  });

  it('[critical] will not let the bid be turned off', () => {
    const onChange = open();
    const bid = screen.getByRole('button', { name: /^Bid/ });
    expect(bid).toBeDisabled();
    fireEvent.click(bid);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says how many of how many are showing', () => {
    render(<ColumnPicker value={DEFAULT_COLUMNS} onChange={vi.fn()} />);
    expect(screen.getByText(`${shownCount(DEFAULT_COLUMNS)}/${CHAIN_COLUMNS.length}`)).toBeInTheDocument();
  });

  it('puts everything back', () => {
    const all = Object.fromEntries(CHAIN_COLUMNS.map((c) => [c.key, true])) as ColumnState;
    const onChange = open(all);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_COLUMNS);
  });
});

describe('a choice stored by an older build', () => {
  it('[critical] keeps what it named and defaults what it did not', () => {
    // `score` did not exist when this was stored
    const stored = { oi: true, ev: false } as Partial<ColumnState>;
    const out = normalise(stored);
    expect(out.oi).toBe(true);
    expect(out.ev).toBe(false);
    expect(out.score).toBe(DEFAULT_COLUMNS.score);
  });

  it('turns the bid back on however it was stored', () => {
    expect(normalise({ bid: false }).bid).toBe(true);
  });

  it('falls back whole when there is nothing stored', () => {
    expect(normalise(null)).toEqual(DEFAULT_COLUMNS);
    expect(normalise(undefined)).toEqual(DEFAULT_COLUMNS);
  });

  it('ignores a value that is not a boolean', () => {
    expect(normalise({ oi: 'yes' } as unknown as Partial<ColumnState>).oi)
      .toBe(DEFAULT_COLUMNS.oi);
  });
});

/**
 * Moving them.
 *
 * Which column sits next to the strike is the one layout decision on this
 * screen -- it is the column the eye lands on -- and it was fixed in a source
 * file. Three ways to move a row, one pure function underneath, so they cannot
 * disagree about what "up" means.
 */
describe('the order of the columns', () => {
  const openWith = (order = DEFAULT_ORDER) => {
    const onOrderChange = vi.fn();
    render(
      <ColumnPicker
        value={DEFAULT_COLUMNS}
        onChange={vi.fn()}
        order={order}
        onOrderChange={onOrderChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'which columns to show' }));
    return onOrderChange;
  };
  const rowOrder = () =>
    [...document.querySelectorAll('.colpick-item .colpick-label')].map((n) => n.firstChild?.textContent);

  it('[critical] lists the columns in the order given, not the order declared', () => {
    openWith(['bid', 'oi', ...DEFAULT_ORDER.filter((k) => k !== 'bid' && k !== 'oi')]);
    expect(rowOrder().slice(0, 2)).toEqual(['Bid', 'Open interest']);
  });

  it('[critical] the arrows move one row, and hand back the whole new order', () => {
    const onOrderChange = openWith();
    fireEvent.click(screen.getByRole('button', { name: 'Move Traded today earlier' }));
    expect(onOrderChange).toHaveBeenCalledWith(['volume', 'oi', ...DEFAULT_ORDER.slice(2)]);
  });

  it('the ends stop: nothing above the first, nothing below the last', () => {
    openWith();
    expect(screen.getByRole('button', { name: `Move ${CHAIN_COLUMNS[0]!.label} earlier` })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Move ${CHAIN_COLUMNS.at(-1)!.label} later` })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Move ${CHAIN_COLUMNS[0]!.label} later` })).toBeEnabled();
  });

  it('[critical] a row can be dragged onto another one', () => {
    const onOrderChange = openWith();
    const rows = [...document.querySelectorAll('.colpick-item')];
    fireEvent.dragStart(rows[0]!, { dataTransfer: { effectAllowed: '' } });
    fireEvent.dragOver(rows[3]!);
    fireEvent.drop(rows[3]!);
    // 'oi' moved to where 'volumeToOi' was: the rest close up behind it
    expect(onOrderChange).toHaveBeenCalledWith(['volume', 'oiChange', 'volumeToOi', 'oi', ...DEFAULT_ORDER.slice(4)]);
  });

  it('a drop on itself moves nothing', () => {
    const onOrderChange = openWith();
    const rows = [...document.querySelectorAll('.colpick-item')];
    fireEvent.dragStart(rows[2]!, { dataTransfer: { effectAllowed: '' } });
    fireEvent.drop(rows[2]!);
    expect(onOrderChange).not.toHaveBeenCalled();
  });

  it('[critical] a row can be moved without a mouse: Space to hold, arrows to move', () => {
    const onOrderChange = openWith();
    const grip = screen.getByRole('button', { name: /^Move Traded today\./ });
    // not held yet: the arrow keys belong to the list
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(onOrderChange).not.toHaveBeenCalled();
    fireEvent.keyDown(grip, { key: ' ' });
    expect(screen.getByRole('button', { name: /Held — use the arrow keys/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    expect(onOrderChange).toHaveBeenCalledWith(['volume', 'oi', ...DEFAULT_ORDER.slice(2)]);
  });

  it('the handle says where the row sits, for a reader who cannot see the list', () => {
    openWith();
    expect(screen.getByRole('button', { name: `Move ${CHAIN_COLUMNS[0]!.label}. Position 1 of ${CHAIN_COLUMNS.length}.` }))
      .toBeInTheDocument();
  });

  it('Select all turns every column on, Deselect all turns every one off, and each is dead at its own end', () => {
    const onChange = vi.fn();
    render(<ColumnPicker value={{ ...DEFAULT_COLUMNS }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'which columns to show' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(Object.values(onChange.mock.calls.at(-1)![0]).every(Boolean)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(Object.values(onChange.mock.calls.at(-1)![0]).some(Boolean)).toBe(false);
    cleanup();
    render(<ColumnPicker value={Object.fromEntries(CHAIN_COLUMNS.map((c) => [c.key, true])) as ColumnState} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'which columns to show' }));
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deselect all' })).toBeEnabled();
  });

  it('[critical] Reset puts the arrangement back as well as the choices', () => {
    const onChange = vi.fn();
    const onOrderChange = vi.fn();
    render(
      <ColumnPicker
        value={{ ...DEFAULT_COLUMNS, oi: true }}
        onChange={onChange}
        order={['bid', ...DEFAULT_ORDER.filter((k) => k !== 'bid')]}
        onOrderChange={onOrderChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'which columns to show' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_COLUMNS);
    expect(onOrderChange).toHaveBeenCalledWith(DEFAULT_ORDER);
  });

  it('no handler, no handles: the panel is the chooser it always was', () => {
    render(<ColumnPicker value={DEFAULT_COLUMNS} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'which columns to show' }));
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
  });
});

/**
 * The stored arrangement, made safe to draw from. This is where a release that
 * adds a column either works or makes it invisible to everyone who has ever
 * touched the panel.
 */
describe('a remembered arrangement', () => {
  it('[critical] a column this build has and the stored order does not is still drawn', () => {
    const old = DEFAULT_ORDER.filter((k) => k !== 'ev' && k !== 'signal');
    const got = normaliseOrder(old);
    expect(got).toHaveLength(CHAIN_COLUMNS.length);
    expect(got).toContain('ev');
    expect(got).toContain('signal');
  });

  it('drops what this build does not have, and keeps a repeat once', () => {
    expect(normaliseOrder(['bid', 'gamma', 'bid'])[0]).toBe('bid');
    expect(normaliseOrder(['bid', 'gamma', 'bid']).filter((k) => k === 'bid')).toHaveLength(1);
    expect(normaliseOrder(['bid', 'gamma', 'bid'])).toHaveLength(CHAIN_COLUMNS.length);
  });

  it('nothing stored, and nonsense stored, both read as the declared order', () => {
    expect(normaliseOrder(null)).toEqual(DEFAULT_ORDER);
    expect(normaliseOrder(undefined)).toEqual(DEFAULT_ORDER);
    expect(normaliseOrder('bid')).toEqual(DEFAULT_ORDER);
    expect(normaliseOrder([1, 2, 3])).toEqual(DEFAULT_ORDER);
  });

  it('[critical] moving a column is a pure rearrangement: same columns, new places', () => {
    const moved = moveColumn(DEFAULT_ORDER, 'bid', 0);
    expect(moved[0]).toBe('bid');
    expect([...moved].sort()).toEqual([...DEFAULT_ORDER].sort());
    // past either end clamps rather than throwing away the column
    expect(moveColumn(DEFAULT_ORDER, 'oi', 99).at(-1)).toBe('oi');
    expect(moveColumn(DEFAULT_ORDER, 'bid', -5)[0]).toBe('bid');
    // a column that is not there changes nothing
    expect(moveColumn(DEFAULT_ORDER, 'nope' as never, 0)).toEqual(DEFAULT_ORDER);
  });
});
