import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ChainTable } from '@/components/chain/ChainTable';
import { CHAIN_COLUMNS, DEFAULT_ORDER, type ColumnState } from '@/components/chain/columns';

/** Every column on, which is what the old `columns={ALL}` meant. */
const ALL = Object.fromEntries(CHAIN_COLUMNS.map((c) => [c.key, true])) as ColumnState;
import type { Leg, SideRecommendation, SnapshotMeta } from '@/types/desk';

/**
 * The board is where a trade starts, so the two things tested here are the two
 * that would cost money: a tap must carry the strike and side it was made on,
 * and the SELL marks must come from the recommendation rather than from
 * anything that merely looks like one.
 */

const leg = (cp: 'C' | 'P', strike: number, over: Partial<Leg> = {}): Leg => ({
  cp, strike,
  bid: cp === 'C' ? 9 : 11,
  ask: cp === 'C' ? 11 : 13,
  mark: cp === 'C' ? 10 : 12,
  oi: 1000, volume: 500, ageMin: 0, delta: 0.1, iv: 0.5,
  pOtm: 0.96,
  zero: { adjusted: 0.99, model: 0.96, sample: 1200, outsideTable: false },
  ...over,
} as Leg);

const legs: Leg[] = [
  leg('C', 79_000), leg('P', 79_000),
  leg('C', 80_000), leg('P', 80_000),
  leg('C', 81_000), leg('P', 81_000),
];

const snap = {
  atm: 80_000, spot: 80_120, expiry: '080926', expiryTs: 1_700_040_000,
  live: true, ts: Date.now(), hoursToExpiry: 6, atmIv: 0.5,
  coverage: null,
} as unknown as SnapshotMeta;

const rowFor = (strike: number) =>
  screen.getByText(String(strike)).closest('tr') as HTMLTableRowElement;

describe('tapping a price', () => {
  it('hands back the strike, the side and that strike’s own book', () => {
    const onSell = vi.fn();
    render(<ChainTable legs={legs} snap={snap} onSell={onSell} columns={ALL} />);

    const row = rowFor(81_000);
    // the calls sit left of the strike, so the first sell button in the row is a call
    const [callButton] = within(row).getAllByRole('button', { name: /^sell at/ });
    callButton!.click();

    expect(onSell).toHaveBeenCalledTimes(1);
    expect(onSell.mock.calls[0]![0]).toEqual({
      cp: 'C', strike: 81_000, bid: 9, ask: 11, mark: 10,
    });
  });

  it('tells a put from a call in the same row', () => {
    const onSell = vi.fn();
    render(<ChainTable legs={legs} snap={snap} onSell={onSell} columns={ALL} />);
    const buttons = within(rowFor(79_000)).getAllByRole('button', { name: /^sell at/ });
    buttons.at(-1)!.click();          // the far right price is a put ask
    expect(onSell.mock.calls[0]![0]).toMatchObject({ cp: 'P', strike: 79_000, bid: 11, ask: 13 });
  });

  it('offers nothing to tap when the board is read-only', () => {
    render(<ChainTable legs={legs} snap={snap} columns={ALL} />);
    expect(screen.queryAllByRole('button', { name: /^sell at/ })).toHaveLength(0);
  });

  it('does not offer a price that does not exist', () => {
    const onSell = vi.fn();
    const thin = [leg('C', 80_000, { bid: null, ask: null }), leg('P', 80_000)];
    render(<ChainTable legs={thin} snap={snap} onSell={onSell} columns={ALL} />);
    const calls = within(rowFor(80_000)).getAllByRole('button', { name: /^sell at/ });
    // only the put's two prices are tappable
    expect(calls).toHaveLength(2);
  });
});

describe('pointing at a strike', () => {
  it('[critical] a click on a row’s call half selects the call, on its put half the put, and the board marks it', () => {
    const onFocus = vi.fn();
    const { rerender } = render(<ChainTable legs={legs} snap={snap} columns={ALL} onFocus={onFocus} />);
    const cells = [...rowFor(79_000).children] as HTMLTableCellElement[];
    const strikeAt = cells.findIndex((c) => c.classList.contains('strikecell'));
    fireEvent.click(cells[0]!);
    expect(onFocus).toHaveBeenLastCalledWith('C', 79_000);
    fireEvent.click(cells[cells.length - 1]!);
    expect(onFocus).toHaveBeenLastCalledWith('P', 79_000);
    fireEvent.click(cells[strikeAt]!);
    expect(onFocus).toHaveBeenCalledTimes(2);   // the strike cell itself is neither side
    rerender(<ChainTable legs={legs} snap={snap} columns={ALL} onFocus={onFocus} focus={{ cp: 'P', strike: 79_000 }} pair={{ C: 81_000, P: 79_000 }} />);
    expect(rowFor(79_000).classList.contains('focused-p')).toBe(true);
    expect(within(rowFor(79_000)).getByText('PE ◆')).toBeInTheDocument();
    // The other side's chosen strike is marked too, on its own row.
    expect(rowFor(81_000).classList.contains('focused-c')).toBe(true);
    expect(within(rowFor(81_000)).getByText('CE ◆')).toBeInTheDocument();
  });
});

describe('the SELL marks', () => {
  it('mark the strikes the desk actually recommended', () => {
    render(
      <ChainTable
        legs={legs}
        snap={snap}
        sides={[{ side: 'CE', leg: { strike: 81_000 } } as never]}
      />,
    );
    expect(within(rowFor(81_000)).getByText('CE')).toBeInTheDocument();
    expect(within(rowFor(79_000)).queryByText('CE')).toBeNull();
  });

  it('mark nothing when nothing was recommended', () => {
    render(<ChainTable legs={legs} snap={snap} sides={[]} />);
    expect(screen.queryByText(/^SELL/)).toBeNull();
  });
});

describe('the default columns', () => {
  it('shows the bid, because it is what a seller receives', () => {
    render(<ChainTable legs={legs} snap={snap} onSell={vi.fn()} />);
    // density 'default': four tappable prices a row -- the offer and the bid,
    // on each side of the strike
    expect(within(rowFor(80_000)).getAllByRole('button', { name: /^sell at/ })).toHaveLength(4);
  });

  it('marks a bid the spread is too wide to cross', () => {
    const wide = [leg('C', 80_000, { bid: 10, ask: 20 }), leg('P', 80_000)];
    const { container } = render(
      <ChainTable legs={wide} snap={snap} onSell={vi.fn()} maxSpreadPct={0.15} />,
    );
    // 10/20 is a 67% spread; the put at 11/13 is 17% -- also wide
    expect(container.querySelectorAll('td.bidcol.wide').length).toBeGreaterThan(0);
  });

  it('leaves an ordinary spread unmarked', () => {
    const tight = [leg('C', 80_000, { bid: 19.5, ask: 20 })];
    const { container } = render(
      <ChainTable legs={tight} snap={snap} onSell={vi.fn()} maxSpreadPct={0.15} />,
    );
    expect(container.querySelectorAll('td.bidcol.wide')).toHaveLength(0);
  });

  it('marks nothing when no limit was given', () => {
    const { container } = render(<ChainTable legs={legs} snap={snap} onSell={vi.fn()} />);
    expect(container.querySelectorAll('td.bidcol.wide')).toHaveLength(0);
  });
});

describe('the board itself', () => {
  it('puts the money in the middle and labels it', () => {
    render(<ChainTable legs={legs} snap={snap} />);
    expect(within(rowFor(80_000)).getByText('ATM')).toBeInTheDocument();
  });

  it('says when there is no book to read, rather than showing blanks', () => {
    const historical = legs.map((l) => ({ ...l, bid: null, ask: null }));
    render(<ChainTable legs={historical} snap={{ ...snap, live: false }} />);
    expect(screen.getByText(/no bid or ask/)).toBeInTheDocument();
  });
});

describe('a strike you are already short', () => {
  const short = (cp: 'C' | 'P', strike: number, size: number, pnlUsd: number | null) =>
    new Map([[`${cp}-${strike}`, { cp, strike, size, pnlUsd }]]);

  it('marks the row it is on, and only that row', () => {
    const { container } = render(
      <ChainTable legs={legs} snap={snap} held={short('C', 81_000, 1, 0.002)} />,
    );
    expect(rowFor(81_000).className).toContain('holding');
    expect(rowFor(79_000).className).not.toContain('holding');
    expect(container.querySelectorAll('tr.holding')).toHaveLength(1);
  });

  it('says which side and how many, as a count rather than a negative', () => {
    render(<ChainTable legs={legs} snap={snap} held={short('P', 79_000, 3, null)} />);
    expect(within(rowFor(79_000)).getByText(/PE 3/)).toBeInTheDocument();
  });

  it('carries the live P&L, because that is the same glance', () => {
    render(<ChainTable legs={legs} snap={snap} held={short('C', 80_000, 1, 2)} />);
    expect(within(rowFor(80_000)).getByText(/\+₹170/)).toBeInTheDocument();
  });

  it('[critical] does not colour a loss as a gain', () => {
    render(<ChainTable legs={legs} snap={snap} held={short('C', 80_000, 1, -2)} />);
    const chip = within(rowFor(80_000)).getByText(/−₹170/);
    expect(chip.className).toContain('down');
  });

  it('says the size even when the P&L is not known yet', () => {
    render(<ChainTable legs={legs} snap={snap} held={short('C', 80_000, 2, null)} />);
    const chip = within(rowFor(80_000)).getByText(/CE 2/);
    expect(chip.textContent).not.toContain('₹');
  });

  it('holding a strike replaces the suggestion to sell it, rather than stacking', () => {
    // the pick mark beside "CE 1" is the desk telling you to do what you have done
    render(
      <ChainTable
        legs={legs}
        snap={snap}
        sides={[{ side: 'CE', leg: { strike: 81_000 } } as never]}
        held={short('C', 81_000, 1, 0)}
      />,
    );
    expect(within(rowFor(81_000)).queryByText('CE')).toBeNull();
    expect(within(rowFor(81_000)).getByText(/CE 1/)).toBeInTheDocument();
  });

  it('still suggests a strike you are not short', () => {
    render(
      <ChainTable
        legs={legs}
        snap={snap}
        sides={[{ side: 'CE', leg: { strike: 81_000 } } as never]}
        held={short('P', 79_000, 1, 0)}
      />,
    );
    expect(within(rowFor(81_000)).getByText('CE')).toBeInTheDocument();
  });

  it('marks nothing when nothing is held', () => {
    const { container } = render(<ChainTable legs={legs} snap={snap} held={new Map()} />);
    expect(container.querySelectorAll('tr.holding')).toHaveLength(0);
  });
});

/**
 * The two columns added for the expected-value view. They are marked "for
 * information" everywhere they appear, and the tests pin the reason: a strike
 * the arithmetic dislikes must say so, and the reason must be reachable on a
 * phone, where there is no hover to put a tooltip behind.
 */
describe('expected value and the signal', () => {
  const withEv = (cp: 'C' | 'P', strike: number, signal: Leg['ev']['signal'], evUsd: number) =>
    leg(cp, strike, {
      ev: {
        evUsd, evPerBtc: evUsd, signal, volumeToOi: 0.017, payoutPerBtc: 3,
        tier: signal === 'sell' ? 'candidate' : signal, score: 72,
        chargesUsd: 0.01, breakeven: strike + 18, maxProfitUsd: 0.09, maxLossUsd: null,
        checks: signal === 'avoid'
          ? [{ ok: false, severity: 'block', text: 'Negative expected value.' }]
          : [{ ok: true, severity: 'block', text: 'Positive expected value.' }],
      },
    } as Partial<Leg>);

  const evLegs: Leg[] = [
    withEv('C', 79_000, 'sell', 0.3), withEv('P', 79_000, 'watch', 0.1),
    withEv('C', 80_000, 'avoid', -0.4), withEv('P', 80_000, 'sell', 0.2),
  ];

  it('shows the verdict on each side of a strike', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} />);
    const row = rowFor(79_000);
    expect(within(row).getByText('Candidate')).toBeInTheDocument();
    expect(within(row).getByText('Watch')).toBeInTheDocument();
  });

  it('[critical] marks a negative expected value as one to avoid', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} />);
    expect(within(rowFor(80_000)).getByText('Avoid')).toBeInTheDocument();
  });

  it('[critical] the reason is reachable on a phone, not left in a tooltip', () => {
    const onInspect = vi.fn();
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} onInspect={onInspect} />);
    within(rowFor(80_000)).getByRole('button', { name: /Avoid — why\?/ }).click();
    expect(onInspect).toHaveBeenCalledWith('C', 80_000);
  });

  it('keeps the signal and the expected value on the board it opens with', () => {
    render(<ChainTable legs={evLegs} snap={snap} />);
    // the default set is the seven a decision is read from; these two are in it
    expect(within(rowFor(79_000)).getByText('Candidate')).toBeInTheDocument();
    expect(within(rowFor(79_000)).getAllByText(/^[+-]\$/).length).toBeGreaterThan(0);
  });

  it('survives a board with no expected value on it at all', () => {
    // a past snapshot, or an older server: the columns read as absent
    render(<ChainTable legs={legs} snap={snap} columns={ALL} />);
    expect(within(rowFor(80_000)).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('says the two columns are not what the desk trades on', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} />);
    expect(screen.getByText(/neither has been tested across 2024, 2025 and/)).toBeInTheDocument();
  });
});

/**
 * Which half of the board is showing, and which rows are on it.
 *
 * Both halves at once is 27 columns, which on a phone is a board you swipe
 * rather than read. The filter hides only what the arithmetic refuses outright
 * — and says how much it hid, because a filter that silently removes rows is
 * how somebody concludes a strike does not exist.
 */
describe('the board’s view', () => {
  const sig = (signal: Leg['ev']['signal'], evUsd: number) =>
    ({
      ev: {
        signal, evUsd, evPerBtc: evUsd, checks: [],
        tier: signal === 'sell' ? 'candidate' : signal, score: 70,
      },
    } as unknown as Partial<Leg>);

  const evLegs: Leg[] = [
    leg('C', 79_000, sig('sell', 0.3)),
    leg('P', 79_000, sig('avoid', -0.1)),
    leg('C', 80_000, sig('avoid', -0.4)),
    leg('P', 80_000, sig('avoid', -0.2)),
  ];

  it('shows both sides by default', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} />);
    expect(screen.getByText('CALLS')).toBeInTheDocument();
    expect(screen.getByText('PUTS')).toBeInTheDocument();
  });

  it('[critical] drops the other half entirely, headers and cells together', () => {
    // The colSpan has to match what is rendered; over-claiming reserves width
    // for columns that are not there and pushes the bid off a phone's edge.
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} view="calls" />);
    expect(screen.getByText('CALLS')).toBeInTheDocument();
    expect(screen.queryByText('PUTS')).not.toBeInTheDocument();

    const header = screen.getByText('CALLS').closest('tr')!;
    const groups = within(header).getAllByRole('columnheader');
    const rendered = within(rowFor(79_000)).getAllByRole('cell').length;
    // every group header's span, summed, is exactly the cells in a body row
    const claimed = groups.reduce((a, th) => a + Number(th.getAttribute('colspan') ?? 1), 0);
    expect(claimed).toBe(rendered);
  });

  it('shows puts alone the same way', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} view="puts" />);
    expect(screen.getByText('PUTS')).toBeInTheDocument();
    expect(screen.queryByText('CALLS')).not.toBeInTheDocument();
  });

  it('[critical] hides only what is refused outright, and says how much', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} eligibleOnly />);
    // 79,000 survives on its call side; 80,000 is refused on both
    expect(screen.getByText('79000')).toBeInTheDocument();
    expect(screen.queryByText('80000')).not.toBeInTheDocument();
    expect(screen.getByText(/1 strike is hidden/)).toBeInTheDocument();
  });

  it('says nothing about hiding when nothing was hidden', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} />);
    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument();
  });

  it('judges eligibility on the side you are looking at', () => {
    // the 79,000 put is refused, so with puts alone that strike goes too
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} view="puts" eligibleOnly />);
    expect(screen.queryByText('79000')).not.toBeInTheDocument();
  });

  it('[critical] the strike opens everything known about it', () => {
    const onInspect = vi.fn();
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} onInspect={onInspect} />);
    screen.getByRole('button', { name: 'what is at strike 79000' }).click();
    expect(onInspect).toHaveBeenCalledWith('C', 79_000);
  });

  it('leaves the strike as plain text on a board that cannot be asked', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} />);
    expect(screen.queryByRole('button', { name: /what is at strike/ })).not.toBeInTheDocument();
  });
});

/**
 * The shape a phone gets.
 *
 * Both sides is 27 columns with the strike in the middle — right on a desk, and
 * the wrong shape twice over on a phone: too wide to read, and the one column
 * you keep your place with sits where nothing can pin it. One side moves the
 * strike to the front, where it can stay put while the rest slides under it.
 */
describe('one side at a time', () => {
  const evLegs: Leg[] = [
    leg('C', 79_000), leg('P', 79_000),
    leg('C', 80_000), leg('P', 80_000),
  ];

  it('[critical] leads with the strike so it can be pinned', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} view="calls" />);
    const first = within(rowFor(79_000)).getAllByRole('cell')[0]!;
    expect(first).toHaveTextContent('79000');
    expect(first.className).toContain('strikecell');
  });

  it('keeps the strike in the middle when both sides show', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} />);
    const cells = within(rowFor(79_000)).getAllByRole('cell');
    expect(cells[0]!.className).not.toContain('strikecell');
    expect(cells.find((c) => c.className.includes('strikecell'))).toBeDefined();
  });

  it('[critical] the header still spans exactly the cells that are drawn', () => {
    // The span and the cells come from one list, and this is what says so.
    for (const view of ['calls', 'puts', 'both'] as const) {
      const { unmount } = render(<ChainTable legs={evLegs} snap={snap} columns={ALL} view={view} />);
      const groups = within(screen.getAllByRole('row')[0]!).getAllByRole('columnheader');
      const claimed = groups.reduce((a, th) => a + Number(th.getAttribute('colspan') ?? 1), 0);
      expect(claimed).toBe(within(rowFor(79_000)).getAllByRole('cell').length);
      unmount();
    }
  });

  it('names the side it is showing', () => {
    const { unmount } = render(<ChainTable legs={evLegs} snap={snap} columns={ALL} view="puts" />);
    expect(screen.getByText('PUTS')).toBeInTheDocument();
    expect(screen.queryByText('CALLS')).not.toBeInTheDocument();
    unmount();
  });
});

describe('where the board opens', () => {
  const evLegs: Leg[] = [
    leg('C', 79_000), leg('P', 79_000),
    leg('C', 80_000), leg('P', 80_000),
    leg('C', 81_000), leg('P', 81_000),
  ];
  const side = (strike: number, s: 'CE' | 'PE' = 'CE') =>
    ({ side: s, leg: { strike } }) as unknown as SideRecommendation;

  it('[critical] opens on what the desk picked, not on the money', () => {
    // Sixty-five strikes exist; the ten around the pick are the ones being
    // decided between, and the money may be nowhere near them.
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} sides={[side(81_000)]} />);
    const picked = rowFor(81_000);
    expect(picked.className).toContain('sold');
  });

  it('falls back to the money when the desk picked nothing', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} sides={[]} />);
    // snap.atm is 80,000 in these fixtures
    expect(rowFor(80_000).className).toContain('atm');
  });
});

/**
 * The columns sit where they were put.
 *
 * The board's own order is calls read outward, puts the mirror of it; a saved
 * arrangement has to hold both of those, and the header and the cells have to
 * move together or the table draws one thing under another's heading.
 */
describe('the order of the columns', () => {
  // A board with both sides at 79,000 and 80,000, as the view tests use.
  const evLegs: Leg[] = [
    leg('C', 79_000), leg('P', 79_000), leg('C', 80_000), leg('P', 80_000),
  ];
  const headings = (row: HTMLElement) =>
    within(row).getAllByRole('columnheader').map((th) => th.textContent);
  const shortsOf = (keys: readonly string[]) =>
    keys.map((k) => CHAIN_COLUMNS.find((c) => c.key === k)!.short);

  it('[critical] draws the columns in the order it is given, calls outward', () => {
    const order = ['bid', 'ask', ...DEFAULT_ORDER.filter((k) => k !== 'bid' && k !== 'ask')] as const;
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} columnOrder={order} view="calls" />);
    const heads = headings(screen.getAllByRole('row')[1]!);
    expect(heads.slice(0, 3)).toEqual(['Strike', ...shortsOf(['bid', 'ask'])]);
  });

  it('[critical] the puts side stays the mirror of it', () => {
    const order = ['bid', 'ask', ...DEFAULT_ORDER.filter((k) => k !== 'bid' && k !== 'ask')] as const;
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} columnOrder={order} />);
    const heads = headings(screen.getAllByRole('row')[1]!);
    expect(heads.slice(0, 2)).toEqual(shortsOf(['bid', 'ask']));
    expect(heads.slice(-2)).toEqual(shortsOf(['ask', 'bid']));
  });

  it('[critical] the cells move with their headings', () => {
    // Bid first: the first cell of a call row is the bid, not the open interest.
    const order = ['bid', ...DEFAULT_ORDER.filter((k) => k !== 'bid')] as const;
    render(
      <ChainTable
        legs={evLegs} snap={snap} view="calls"
        columns={{ ...ALL, oi: true, bid: true }} columnOrder={order}
      />,
    );
    const heads = headings(screen.getAllByRole('row')[1]!);
    const cells = within(rowFor(79_000)).getAllByRole('cell').map((td) => td.className);
    // heading 1 is the strike, so cell 1 is the strike and cell 2 answers heading 2
    expect(heads[1]).toBe('Bid');
    expect(cells[1]).toContain('bid');
  });

  it('a hidden column takes its place with it, wherever it was moved to', () => {
    const order = ['bid', 'oi', ...DEFAULT_ORDER.filter((k) => k !== 'bid' && k !== 'oi')] as const;
    render(
      <ChainTable
        legs={evLegs} snap={snap} view="calls"
        columns={{ ...ALL, oi: false }} columnOrder={order}
      />,
    );
    const heads = headings(screen.getAllByRole('row')[1]!);
    expect(heads).not.toContain('OI');
    expect(heads[1]).toBe('Bid');
  });

  it('no order given is the order the file declares', () => {
    render(<ChainTable legs={evLegs} snap={snap} columns={ALL} view="calls" />);
    const heads = headings(screen.getAllByRole('row')[1]!);
    expect(heads.slice(1)).toEqual(CHAIN_COLUMNS.map((c) => c.short));
  });

  it('[critical] the header still spans exactly the cells that are drawn, whatever the order', () => {
    const order = ['bid', 'score', 'oi', ...DEFAULT_ORDER.filter((k) => !['bid', 'score', 'oi'].includes(k))] as const;
    for (const view of ['calls', 'puts', 'both'] as const) {
      const { unmount } = render(
        <ChainTable legs={evLegs} snap={snap} columns={ALL} columnOrder={order} view={view} />,
      );
      const groups = within(screen.getAllByRole('row')[0]!).getAllByRole('columnheader');
      const claimed = groups.reduce((a, th) => a + Number(th.getAttribute('colspan') ?? 1), 0);
      expect(claimed).toBe(within(rowFor(79_000)).getAllByRole('cell').length);
      unmount();
    }
  });
});
