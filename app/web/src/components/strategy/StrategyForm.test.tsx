import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { StrategyForm } from '@/components/strategy/StrategyForm';
import { DEFAULT_CONFIG, type Strategy } from '@/types/strategy';

const saveStrategy = vi.fn();
vi.mock('@/api/strategy', () => ({ saveStrategy: (...a: unknown[]) => saveStrategy(...a) }));

/**
 * The strategy form, on a phone.
 *
 * Four tabs instead of one long column; times picked on a clock with AM or PM;
 * each problem written under its field, its tab marked, and Save saying what is
 * left. What goes to the server is still 24-hour "HH:MM".
 */

const editing = (over: Partial<Strategy['config']> = {}, name = 'CE+PE'): Strategy => ({
  id: 's', name, enabled: false, createdAt: 0, updatedAt: 0,
  lastRunDate: null, ranToday: false, nextEntryAt: null, status: 'off',
  config: { ...DEFAULT_CONFIG, ...over },
});

const show = (s: Strategy | null = editing()) =>
  render(<StrategyForm editing={s} open onOpenChange={() => {}} onSaved={() => {}} balanceUsd={228} spot={77_000} />);

const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));
const saveButton = () => screen.getByRole('button', { name: /^(Save|Fix \d+ to save)$/ });
const pickTyped = (field: RegExp, text: string, set: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: field }));
  const box = screen.getByRole('textbox', { name: /^type the / });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: set }));
};

beforeEach(() => {
  vi.clearAllMocks();
  saveStrategy.mockResolvedValue({ ok: true });
});

describe('four tabs instead of one long page', () => {
  it('[critical] opens on When, and each tab shows only its own settings', () => {
    show();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['When', 'Sell', 'Entry & exit', 'Extras']);
    expect(screen.getByRole('tab', { name: 'When' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /^Entry time:/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('lots')).toBeNull();

    tab('Sell');
    expect(screen.getByLabelText('lots')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Entry time:/ })).toBeNull();

    tab('Entry & exit');
    expect(screen.getByLabelText('take profit pct')).toBeInTheDocument();

    tab('Extras');
    expect(screen.getByRole('switch', { name: /Add to the other leg/ })).toBeInTheDocument();
  });

  it('arrow keys move between tabs', () => {
    show();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Sell' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Extras' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a choice shows one line for what it does, not a card per option', () => {
    show();
    tab('Sell');
    const legs = screen.getByRole('radiogroup', { name: 'legs' });
    expect(within(legs).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByText('Both sides — the tested strategy.')).toBeInTheDocument();
    fireEvent.click(within(legs).getByRole('radio', { name: 'PE only' }));
    expect(screen.getByText('Profits if BTC does not fall much.')).toBeInTheDocument();
    expect(screen.queryByText('Both sides — the tested strategy.')).toBeNull();
  });
});

describe('times on a clock', () => {
  it('[critical] shows entry and exit with AM and PM', () => {
    show();
    expect(screen.getByRole('button', { name: 'Entry time: 5:30 AM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit time: 5:29 PM' })).toBeInTheDocument();
    expect(screen.getByText(/Runs 11 h 59 min/)).toBeInTheDocument();
  });

  it('[critical] saves the picked times as 24-hour', async () => {
    show();
    pickTyped(/^Entry time:/, '6:15 am', /^Set 6:15 AM$/);
    pickTyped(/^Exit time:/, '3:00 pm', /^Set 3:00 PM$/);
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config).toMatchObject({ entryTime: '06:15', exitTime: '15:00' });
  });

  it('[critical] the exit picker will not go before entry or past 5:29 PM', () => {
    show(editing({ entryTime: '09:00' }));
    fireEvent.click(screen.getByRole('button', { name: /^Exit time:/ }));
    expect(screen.getByText('Allowed: 9:01 AM to 5:29 PM')).toBeInTheDocument();
  });

  it('[critical] an exit before the entry is written under the exit, marks the tab, and stops the save', () => {
    show(editing({ entryTime: '10:00', exitTime: '09:00' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Exit (9:00 AM) must be later in the day than entry (10:00 AM).');
    expect(within(screen.getByRole('tab', { name: /When/ })).getByLabelText('has a problem')).toBeInTheDocument();
    expect(saveButton()).toHaveTextContent('Fix 1 to save');
    fireEvent.click(saveButton());
    expect(saveStrategy).not.toHaveBeenCalled();
  });

  it('offers the fix in one tap', () => {
    show(editing({ entryTime: '10:00', exitTime: '09:00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set exit to 5:29 PM' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton()).toHaveTextContent('Save');
  });

  it('Save takes you to the tab with the problem', () => {
    show(editing({ lots: 0 }));
    expect(screen.getByText(/1 thing to fix on/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(screen.getByRole('tab', { name: /Sell/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Lots must be a whole number, at least 1.');
  });

  it('a new strategy needs a name before it saves', () => {
    show(null);
    expect(saveButton()).toHaveTextContent('Fix 1 to save');
    fireEvent.change(screen.getByLabelText('strategy name'), { target: { value: 'Morning' } });
    expect(saveButton()).toHaveTextContent('Save');
  });
});

describe('adding to the other leg', () => {
  it('is off by default, with nothing to fill in', () => {
    show();
    tab('Extras');
    expect(screen.getByRole('switch', { name: /Add to the other leg/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('add minimum price')).toBeNull();
  });

  it('[critical] turning it on starts at $3, 2x, and half an hour before the exit', () => {
    show(editing({ exitTime: '15:00' }));
    tab('Extras');
    fireEvent.click(screen.getByRole('switch', { name: /Add to the other leg/ }));
    expect(screen.getByLabelText('add minimum price')).toHaveValue('3');
    expect(screen.getByLabelText('add maximum multiple')).toHaveValue('2');
    expect(screen.getByRole('button', { name: 'Latest time to add: 2:30 PM' })).toBeInTheDocument();
    const examples = within(screen.getByLabelText('add examples'));
    expect(examples.getAllByText('adds — sells 425 more')).toHaveLength(2);
    expect(examples.getByText('no — below $3')).toBeInTheDocument();
  });

  it('[critical] the latest time to add can only be picked between entry and exit', () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' } }));
    tab('Extras');
    fireEvent.click(screen.getByRole('button', { name: /^Latest time to add:/ }));
    expect(screen.getByText('Allowed: 5:31 AM to 5:28 PM')).toBeInTheDocument();
  });

  it('[critical] moving the exit before the latest time to add flags Extras, and offers the fix', () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' } }));
    pickTyped(/^Exit time:/, '3 pm', /^Set 3:00 PM$/);
    expect(within(screen.getByRole('tab', { name: /Extras/ })).getByLabelText('has a problem')).toBeInTheDocument();
    tab('Extras');
    expect(screen.getByRole('alert')).toHaveTextContent('The latest time to add (4:59 PM) must be after entry (5:30 AM) and before exit (3:00 PM).');
    fireEvent.click(screen.getByRole('button', { name: 'Use 2:30 PM (30 min before exit)' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[critical] the minimum is dynamic: typing $5 redraws the examples and the sentence', () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' } }));
    tab('Extras');
    fireEvent.change(screen.getByLabelText('add minimum price'), { target: { value: '5' } });
    const examples = within(screen.getByLabelText('add examples'));
    expect(examples.getByText('$4.00')).toBeInTheDocument();
    expect(examples.getByText('no — below $5')).toBeInTheDocument();
    expect(screen.getByText(/bid is \$5 or more/)).toBeInTheDocument();
  });

  it('[critical] saves exactly the numbers and the time chosen', async () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' } }));
    tab('Extras');
    fireEvent.change(screen.getByLabelText('add minimum price'), { target: { value: '4.5' } });
    fireEvent.change(screen.getByLabelText('add maximum multiple'), { target: { value: '1.5' } });
    pickTyped(/^Latest time to add:/, '12:15 pm', /^Set 12:15 PM$/);
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config.addToOpposite).toEqual({ minPriceUsd: 4.5, maxMultiple: 1.5, addUntil: '12:15' });
  });

  it('turning it off saves it as off', async () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' } }));
    tab('Extras');
    fireEvent.click(screen.getByRole('switch', { name: /Add to the other leg/ }));
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config.addToOpposite).toBeNull();
  });

  it('a one-legged strategy with the add on is caught before the save', () => {
    show(editing({ legs: 'CE', doubleWhenOneSided: false, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' } }));
    tab('Extras');
    expect(screen.getByRole('alert')).toHaveTextContent('Adding to the other leg needs both legs selected.');
  });

  it('shows the server\'s objection when it refuses anyway', async () => {
    saveStrategy.mockRejectedValue(new Error('Something the server checks that the form does not.'));
    show();
    fireEvent.click(saveButton());
    expect(await screen.findByText('Something the server checks that the form does not.')).toBeInTheDocument();
  });
});
