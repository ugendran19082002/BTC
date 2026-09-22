import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrategyForm } from '@/components/strategy/StrategyForm';
import { DEFAULT_CONFIG, DEFAULT_REBALANCE, type Strategy } from '@/types/strategy';

const saveStrategy = vi.fn();
const rebalanceSettings = {
  defaults: {
    enabled: true, lotsPerStep: 30, steps: 3, upStartPct: 30, downStartPct: 20, incrementPct: 10,
    confirmTicks: 2, endTime: '13:30', lockDirection: true, maxLotsPerSide: 200, allowPartial: true, maxSpreadPct: 0.15,
  },
  limits: {
    maxSteps: 20, maxLotsPerStep: 10_000, maxUpPct: 500, maxDownPct: 99,
    maxIncrementPct: 500, maxConfirmTicks: 10, maxLotsPerSide: 100_000,
  },
  ceilings: {
    maxSteps: 100, maxLotsPerStep: 100_000, maxUpPct: 10_000, maxDownPct: 99,
    maxIncrementPct: 10_000, maxConfirmTicks: 60, maxLotsPerSide: 1_000_000,
  },
};
vi.mock('@/api/strategy', () => ({
  saveStrategy: (...a: unknown[]) => saveStrategy(...a),
  // The form reads the desk's rebalance defaults and limits rather than holding its own.
  getRebalanceSettings: () => Promise.resolve(rebalanceSettings),
  setRebalanceSettings: vi.fn(),
}));

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
    expect(screen.getByLabelText('Take profit percent')).toBeInTheDocument();

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

  it('[critical] an overnight window saves, and says it runs into the next morning', async () => {
    show(editing({ entryTime: '23:30', exitTime: '05:30' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Runs 6 h, into the next day/)).toBeInTheDocument();
    // The day picker is about the entry, which is the half people get wrong.
    expect(screen.getByText(/The day the entry starts/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config).toMatchObject({ entryTime: '23:30', exitTime: '05:30' });
  });

  it('[critical] a window that would run past the settlement is written under the exit, marks the tab, and stops the save', () => {
    show(editing({ entryTime: '10:00', exitTime: '09:00' }));
    expect(screen.getByRole('alert'))
      .toHaveTextContent('Exit (9:00 AM) comes after the 5:30 PM settlement that ends the contract entered at 10:00 AM. The last exit is 5:29 PM.');
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
    expect(screen.getByText(/1 thing to fix:/)).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(screen.getByRole('tab', { name: /Sell/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Lots must be a whole number, at least 1.');
  });

  /*
   * On the live desk, 11 September: a new strategy opened with a red dot on When
   * and "1 thing to fix on When" -- the empty name, which is not on When and had
   * no message beside it.
   */
  it('[critical] a new form does not open complaining, and no tab is marked for the name', () => {
    show(null);
    expect(saveButton()).toHaveTextContent('Save');
    expect(screen.queryByLabelText('has a problem')).toBeNull();
    expect(screen.queryByText(/thing to fix/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[critical] Save without a name says so under the name box, and saves nothing', () => {
    show(null);
    fireEvent.click(saveButton());
    expect(saveStrategy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Give the strategy a name.');
    expect(screen.getByText(/1 thing to fix:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Name' })).toBeInTheDocument();
    expect(screen.queryByLabelText('has a problem')).toBeNull();
    expect(screen.getByLabelText('strategy name')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('strategy name'), { target: { value: 'Morning' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton()).toHaveTextContent('Save');
  });
});

/**
 * Two bars, each off until it is switched on.
 *
 * They are different rules and the difference matters at the moment they stop
 * something: the sell-score bar stands the day down, the sudden-move limit
 * waits and looks again. Nothing about either appears on the form until it is
 * armed -- a number on a form for a rule that is not running is a setting that
 * looks live and is not.
 */
describe('the two score bars', () => {
  it('[critical] both start off, with no number to fill in', () => {
    show();
    tab('Extras');
    expect(screen.getByRole('switch', { name: /scores too low/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: /sudden move/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('minimum sell score')).toBeNull();
    expect(screen.queryByLabelText('maximum sudden move score')).toBeNull();
  });

  it('[critical] switching one on reveals its number, and leaves the other alone', () => {
    show();
    tab('Extras');
    fireEvent.click(screen.getByRole('switch', { name: /scores too low/ }));
    expect(screen.getByLabelText('minimum sell score')).toHaveValue('65');
    expect(screen.queryByLabelText('maximum sudden move score')).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: /sudden move/ }));
    expect(screen.getByLabelText('maximum sudden move score')).toHaveValue('25');
  });

  it('[critical] saves the numbers that were chosen', async () => {
    show();
    tab('Extras');
    fireEvent.click(screen.getByRole('switch', { name: /scores too low/ }));
    fireEvent.click(screen.getByRole('switch', { name: /sudden move/ }));
    fireEvent.change(screen.getByLabelText('minimum sell score'), { target: { value: '70' } });
    fireEvent.change(screen.getByLabelText('maximum sudden move score'), { target: { value: '25' } });
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    const cfg = saveStrategy.mock.calls[0]![0].config;
    expect(cfg.minSellScore).toBe(70);
    expect(cfg.maxShockScore).toBe(25);
  });

  it('[critical] switching one off saves it as off, not as zero', async () => {
    // Zero would be the strictest possible bar rather than no bar at all: a
    // sell-score bar of 0 refuses nothing, but a risk limit of 0 holds every
    // day there is.
    show(editing({ minSellScore: 70, maxShockScore: 25 }));
    tab('Extras');
    fireEvent.click(screen.getByRole('switch', { name: /scores too low/ }));
    fireEvent.click(screen.getByRole('switch', { name: /sudden move/ }));
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    const cfg = saveStrategy.mock.calls[0]![0].config;
    expect(cfg.minSellScore).toBeNull();
    expect(cfg.maxShockScore).toBeNull();
  });

  it('an editing strategy opens with its own numbers, already on', () => {
    show(editing({ minSellScore: 80, maxShockScore: 40 }));
    tab('Extras');
    expect(screen.getByRole('switch', { name: /scores too low/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('minimum sell score')).toHaveValue('80');
    expect(screen.getByLabelText('maximum sudden move score')).toHaveValue('40');
  });

  it('a bar outside 1-100 is caught before the save, under its own field', () => {
    show(editing({ minSellScore: 65 }));
    tab('Extras');
    fireEvent.change(screen.getByLabelText('minimum sell score'), { target: { value: '150' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The sell-score bar must be a whole number from 1 to 100, or off.');
    expect(saveButton()).toHaveTextContent(/^Fix 1 to save$/);
  });

  it('says which one waits and which one stands the day down', () => {
    show(editing({ minSellScore: 65, maxShockScore: 25 }));
    tab('Extras');
    expect(screen.getByText(/stood down for the day/)).toBeInTheDocument();
    expect(screen.getByText(/waits and looks again/)).toBeInTheDocument();
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

  /*
   * "If not filled, sell at bid after N seconds", on the add.
   *
   * The add rests at the other leg's offer at 11 in the morning with nobody
   * watching it, so it carries its own seconds. Blank keeps the entry's, which
   * is what every strategy saved before the control existed does.
   */
  it('[critical] blank means the entry\'s seconds, and says so', () => {
    show(editing({ crossAfterSec: 7, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' } }));
    tab('Extras');
    const box = screen.getByLabelText('add cross after seconds');
    expect(box).toHaveValue('');
    expect(box).toHaveAttribute('placeholder', '7');
    expect(screen.getByText(/blank — the entry's 7 sec/)).toBeInTheDocument();
  });

  it('[critical] the add\'s own seconds are saved on the rule, not on the entry', async () => {
    show(editing({ crossAfterSec: 7, addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59' } }));
    tab('Extras');
    fireEvent.change(screen.getByLabelText('add cross after seconds'), { target: { value: '90' } });
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    const cfg = saveStrategy.mock.calls[0]![0].config;
    expect(cfg.addToOpposite).toEqual({ minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59', crossAfterSec: 90 });
    expect(cfg.crossAfterSec).toBe(7);
  });

  it('zero rests at the offer, and the hint says the window still ends it', () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59', crossAfterSec: 0 } }));
    tab('Extras');
    expect(screen.getByLabelText('add cross after seconds')).toHaveValue('0');
    expect(screen.getByText(/rests at the offer; the add window still ends it/)).toBeInTheDocument();
  });

  it('more than ten minutes is refused before it can be saved', () => {
    show(editing({ addToOpposite: { minPriceUsd: 3, maxMultiple: 2, addUntil: '16:59', crossAfterSec: 601 } }));
    tab('Extras');
    expect(screen.getByText(/whole number from 0 to 600/)).toBeInTheDocument();
    expect(saveButton()).toHaveTextContent(/Fix \d+ to save/);
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

/**
 * How late is too late.
 *
 * It was one constant for the whole desk — sixty minutes — and invisible, so a
 * strategy that quietly did not run at 07:00 looked broken rather than late.
 */
describe('the late-entry window', () => {
  it('[critical] shows sixty minutes by default, and says what it means', () => {
    show();
    const box = screen.getByLabelText('late entry window') as HTMLInputElement;
    expect(box.value).toBe('60');
    expect(screen.getByText(/Up to 60 minutes after 5:30 AM the desk still takes the entry/)).toBeInTheDocument();
    expect(screen.getByText(/After that the day is skipped and you are told/)).toBeInTheDocument();
  });

  it('[critical] a strategy that was saved with its own window opens on that one', () => {
    show(editing({ graceMin: 15 }));
    expect((screen.getByLabelText('late entry window') as HTMLInputElement).value).toBe('15');
    expect(screen.getByText(/Up to 15 minutes after/)).toBeInTheDocument();
  });

  it('[critical] the window is sent with the strategy', async () => {
    show();
    fireEvent.change(screen.getByLabelText('late entry window'), { target: { value: '20' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config.graceMin).toBe(20);
  });

  it('the chips are the windows anyone actually picks', () => {
    show();
    const box = screen.getByLabelText('late entry window') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: '5m' }));
    expect(box.value).toBe('5');
    expect(screen.getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    expect(box.value).toBe('60');
  });

  it('[critical] nothing, or more than four hours, is refused before it can be saved', async () => {
    show();
    for (const bad of ['0', '241']) {
      fireEvent.change(screen.getByLabelText('late entry window'), { target: { value: bad } });
      expect(screen.getByText(/whole number of minutes from 1 to 240/)).toBeInTheDocument();
      expect(saveButton()).toHaveTextContent(/Fix \d+ to save/);
    }
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveStrategy).not.toHaveBeenCalled());
  });

  /*
   * The rebalance rule's own controls.
   *
   * Two things bit on 18 September: the sell had no "if not filled, sell at bid
   * after" of its own, and a desk default cap of 200 on a strategy that sells
   * 700 a side blocked every stage before it started.
   */
  it('[critical] turning it on picks a cap that fits the lots, not the desk default', () => {
    show(editing({ lots: 700, rebalance: null }));
    tab('Extras');
    fireEvent.click(screen.getByRole('switch', { name: /Rebalance one side into the other/ }));
    // 700 a side, 30 a stage over 3 stages: it can reach 790
    expect(screen.getByLabelText('rebalance cap per side')).toHaveValue('790');
    expect(screen.queryByText(/is under the 700 lots/)).toBeNull();
    expect(screen.queryByText(/stage \d+ is refused/)).toBeNull();
  });

  it('[critical] the cap follows the numbers while it is automatic', () => {
    show(editing({ lots: 100, rebalance: { ...DEFAULT_REBALANCE, capAuto: true, maxLotsPerSide: 200 } }));
    tab('Extras');
    const cap = screen.getByLabelText('rebalance cap per side');
    // 100 a side, 30 a stage, 3 stages: 90 lots can move, so it reaches 190
    expect(cap).toHaveValue('190');
    expect(cap).toBeDisabled();
    // five stages of 30 is 150 to move, and only 100 are there: 200
    fireEvent.change(screen.getByLabelText('rebalance stages'), { target: { value: '5' } });
    expect(screen.getByLabelText('rebalance cap per side')).toHaveValue('200');
    // 60 a stage cannot move more than the 100 that exist either
    fireEvent.change(screen.getByLabelText('rebalance lots per stage'), { target: { value: '60' } });
    expect(screen.getByLabelText('rebalance cap per side')).toHaveValue('200');
    // a bigger strategy moves it: 700 a side, 30 a stage, 5 stages
    show(editing({ lots: 700, rebalance: { ...DEFAULT_REBALANCE, capAuto: true, maxLotsPerSide: 200 } }));
    tab('Extras');
    expect(screen.getAllByLabelText('rebalance cap per side')[1]).toHaveValue('790');
  });

  it('[critical] it can be typed by hand, and then it stays where it is put', async () => {
    show(editing({ lots: 100, rebalance: { ...DEFAULT_REBALANCE, capAuto: true, maxLotsPerSide: 200 } }));
    tab('Extras');
    fireEvent.click(screen.getByRole('button', { name: 'set the cap by hand' }));
    const cap = screen.getByLabelText('rebalance cap per side');
    expect(cap).toBeEnabled();
    fireEvent.change(cap, { target: { value: '160' } });
    // changing the stages no longer moves it
    fireEvent.change(screen.getByLabelText('rebalance stages'), { target: { value: '5' } });
    expect(screen.getByLabelText('rebalance cap per side')).toHaveValue('160');
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config.rebalance.maxLotsPerSide).toBe(160);
    expect(saveStrategy.mock.calls[0]![0].config.rebalance.capAuto).toBe(false);
  });

  it('[critical] a cap that is too small says which stages it refuses', () => {
    show(editing({ lots: 100, rebalance: { ...DEFAULT_REBALANCE, capAuto: false, maxLotsPerSide: 160 } }));
    tab('Extras');
    expect(screen.getByText(/The cap stops it after stage 2: stage 3 is refused\. Raise it to 190 for all 3\./))
      .toBeInTheDocument();
    const stages = within(screen.getByLabelText('rebalance stage table'));
    expect(stages.getAllByText('capped')).toHaveLength(1);
  });

  it('[critical] a cap with no room at all says no stage can run', () => {
    show(editing({ lots: 100, rebalance: { ...DEFAULT_REBALANCE, capAuto: false, maxLotsPerSide: 100 } }));
    tab('Extras');
    expect(screen.getByText(/No stage can run: the cap \(100\) leaves no room above the 100 lots each side opens with\./))
      .toBeInTheDocument();
  });

  it('a cap under the lots says why nothing could ever run, and what the rule reaches', () => {
    show(editing({ lots: 700, rebalance: { ...DEFAULT_REBALANCE, capAuto: false, maxLotsPerSide: 200 } }));
    tab('Extras');
    expect(screen.getByText(/The cap \(200\) is under the 700 lots the strategy opens with, so no stage could ever run/))
      .toBeInTheDocument();
    expect(screen.getByText(/This rule reaches 790 lots at most/)).toBeInTheDocument();
  });

  it('[critical] the sell has its own seconds, and blank keeps the entry\'s', async () => {
    show(editing({ lots: 100, crossAfterSec: 7, rebalance: { ...DEFAULT_REBALANCE, capAuto: false, maxLotsPerSide: 200 } }));
    tab('Extras');
    const box = screen.getByLabelText('rebalance cross after seconds');
    expect(box).toHaveValue('');
    expect(box).toHaveAttribute('placeholder', '7');
    expect(screen.getByText(/blank — the entry's 7 sec/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '45' } });
    fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
    expect(saveStrategy.mock.calls[0]![0].config.rebalance.crossAfterSec).toBe(45);
    expect(saveStrategy.mock.calls[0]![0].config.crossAfterSec).toBe(7);
  });

  it('the stage table says what the cap does, in words', () => {
    show(editing({ lots: 100, rebalance: { ...DEFAULT_REBALANCE, capAuto: false, maxLotsPerSide: 160 } }));
    tab('Extras');
    // the cap bites, so the table says which stage it refuses rather than the
    // plain "neither side passes" line
    expect(screen.getByText(/stage 3 is refused\. Raise it to/)).toBeInTheDocument();
    const stages = within(screen.getByLabelText('rebalance stage table'));
    // 100 + 100, 30 a stage, capped at 160: 130, 160, then the cap holds it
    expect(stages.getByText('130 / 70')).toBeInTheDocument();
    // stage 2 reaches the cap, and stage 3 can add nothing more
    expect(stages.getAllByText('160 / 40')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ exits: typed, % or fixed, on a timetable */

const typeInto = (label: string | RegExp, text: string, root: HTMLElement = document.body) => {
  const box = within(root).getByRole('textbox', { name: label });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.blur(box);
};
const exitBox = (name: 'Take profit' | 'Stop loss') => screen.getByRole('region', { name });
const saved = async () => {
  fireEvent.click(saveButton());
  await vi.waitFor(() => expect(saveStrategy).toHaveBeenCalled());
  return saveStrategy.mock.calls[0]![0].config;
};

describe('exits: typed, not dragged', () => {
  it('[critical] a stop above 100% is taken and saved as typed', async () => {
    show();
    tab('Entry & exit');
    typeInto('Stop loss percent', '250');
    expect(within(exitBox('Stop loss')).queryByRole('alert')).toBeNull();
    expect(within(exitBox('Stop loss')).getByText(/buys back 250% above the entry/)).toBeInTheDocument();
    expect((await saved()).stopLossPct).toBe(2.5);
  });

  it('[critical] a target above 99% is said under its box and holds the save', () => {
    show();
    tab('Entry & exit');
    typeInto('Take profit percent', '100');
    expect(within(exitBox('Take profit')).getByRole('alert')).toHaveTextContent('Take profit must be between 0 and 99% of the credit.');
    fireEvent.click(saveButton());
    expect(saveStrategy).not.toHaveBeenCalled();
  });

  it('shows the level against the premium the rule asks for', () => {
    show(editing({ premium: { mode: 'atLeast', usd: 15 }, takeProfitPct: 0.8 }));
    tab('Entry & exit');
    expect(within(exitBox('Take profit')).getByText('3.00')).toBeInTheDocument();  // 15 × 0.2
  });

  it('[critical] Fixed reads points from the entry and saves the mode with them', async () => {
    show(editing({ premium: { mode: 'atLeast', usd: 15 } }));
    tab('Entry & exit');
    const stop = exitBox('Stop loss');
    fireEvent.click(within(stop).getByRole('radio', { name: 'Fixed' }));
    typeInto('Stop loss points', '10', stop);
    expect(within(stop).getByText(/buys back 10 pts above the entry/)).toBeInTheDocument();
    expect(within(stop).getByText('25.00')).toBeInTheDocument();  // 15 + 10
    const c = await saved();
    expect(c).toMatchObject({ stopMode: 'points', stopLossPoints: 10 });
  });

  it('switching mode keeps each mode\'s number and drops steps written in the other units', () => {
    show(editing({ takeProfitPct: 0.8, targetSteps: [{ at: '07:30', value: 0.85 }] }));
    tab('Entry & exit');
    const tp = exitBox('Take profit');
    expect(within(tp).getByRole('list', { name: 'Take profit steps' })).toBeInTheDocument();
    fireEvent.click(within(tp).getByRole('radio', { name: 'Fixed' }));
    expect(within(tp).queryByRole('list')).toBeNull();
    fireEvent.click(within(tp).getByRole('radio', { name: '%' }));
    expect(within(tp).getByRole('textbox', { name: 'Take profit percent' })).toHaveValue('80');
  });
});

describe('exits on a timetable', () => {
  it('[critical] entry 5:30, 80% -- Fill every 2 h by +5 builds 7:30 85%, 9:30 90%, 11:30 95% ... and saves it', async () => {
    show(editing({ entryTime: '05:30', exitTime: '17:29', takeProfitPct: 0.8 }));
    tab('Entry & exit');
    const tp = exitBox('Take profit');
    fireEvent.click(within(tp).getByRole('button', { name: 'Fill steps…' }));
    typeInto('Take profit fill every hours', '2', tp);
    typeInto('Take profit fill change by', '5', tp);
    fireEvent.click(within(tp).getByRole('button', { name: 'Fill' }));

    expect(within(tp).getByRole('button', { name: 'Take profit step 1 time: 7:30 AM' })).toBeInTheDocument();
    expect(within(tp).getByRole('textbox', { name: 'Take profit step 1 percent' })).toHaveValue('85');
    expect(within(tp).getByRole('button', { name: 'Take profit step 3 time: 11:30 AM' })).toBeInTheDocument();
    expect(within(tp).getByRole('textbox', { name: 'Take profit step 4 percent' })).toHaveValue('99');
    expect(within(tp).queryByRole('textbox', { name: 'Take profit step 5 percent' })).toBeNull();

    const c = await saved();
    expect(c.targetSteps).toEqual([
      { at: '07:30', value: 0.85 }, { at: '09:30', value: 0.9 }, { at: '11:30', value: 0.95 }, { at: '13:30', value: 0.99 },
    ]);
  });

  it('the same for the stop, in points', async () => {
    show(editing({ entryTime: '05:30', exitTime: '12:00', stopMode: 'points', stopLossPoints: 10 }));
    tab('Entry & exit');
    const sl = exitBox('Stop loss');
    fireEvent.click(within(sl).getByRole('button', { name: 'Fill steps…' }));
    typeInto('Stop loss fill every hours', '2', sl);
    typeInto('Stop loss fill change by', '10', sl);
    fireEvent.click(within(sl).getByRole('button', { name: 'Fill' }));
    const c = await saved();
    expect(c.stopSteps).toEqual([{ at: '07:30', value: 20 }, { at: '09:30', value: 30 }, { at: '11:30', value: 40 }]);
  });

  it('Add a time step puts one an hour on, carrying the value; ✕ takes it away', () => {
    show(editing({ entryTime: '05:30', takeProfitPct: 0.8 }));
    tab('Entry & exit');
    const tp = exitBox('Take profit');
    fireEvent.click(within(tp).getByRole('button', { name: /Add a time step/ }));
    expect(within(tp).getByRole('button', { name: 'Take profit step 1 time: 6:30 AM' })).toBeInTheDocument();
    expect(within(tp).getByRole('textbox', { name: 'Take profit step 1 percent' })).toHaveValue('80');
    fireEvent.click(within(tp).getByRole('button', { name: /Add a time step/ }));
    expect(within(tp).getByRole('button', { name: 'Take profit step 2 time: 7:30 AM' })).toBeInTheDocument();
    fireEvent.click(within(tp).getByRole('button', { name: 'remove take profit step 1' }));
    expect(within(tp).getByRole('button', { name: 'Take profit step 1 time: 7:30 AM' })).toBeInTheDocument();
  });

  it('[critical] a step at or after the exit time is refused, and the tab is marked', () => {
    show(editing({ entryTime: '05:30', exitTime: '11:00', targetSteps: [{ at: '11:30', value: 0.9 }] }));
    tab('Entry & exit');
    expect(within(exitBox('Take profit')).getByRole('alert'))
      .toHaveTextContent('Take profit step 1 (11:30 AM) must be after entry (5:30 AM) and before exit (11:00 AM).');
    fireEvent.click(saveButton());
    expect(saveStrategy).not.toHaveBeenCalled();
  });

  it('steps out of order are refused', () => {
    show(editing({ stopLossPct: 1, stopSteps: [{ at: '09:30', value: 2 }, { at: '07:30', value: 3 }] }));
    tab('Entry & exit');
    expect(within(exitBox('Stop loss')).getByRole('alert')).toHaveTextContent('Stop loss step 2 (7:30 AM) must come after step 1.');
  });

  it('the read-back sentence says the timetable', () => {
    show(editing({ takeProfitPct: 0.8, targetSteps: [{ at: '07:30', value: 0.85 }], stopMode: 'points', stopLossPoints: 10 }));
    expect(screen.getAllByText(/buys back at 80% decay → 85% at 7:30 AM, stop at entry \+ 10 pts/).length).toBeGreaterThan(0);
  });
});

describe('premium fallback', () => {
  it('[critical] at most $20, else the last strike at or below $50 -- switched on, set, and saved', async () => {
    show(editing({ premium: { mode: 'atMost', usd: 20 } }));
    tab('Sell');
    const sw = screen.getByRole('switch', { name: /If nothing is at or below it, try a higher cap/ });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    typeInto('premium fallback usd', '50');
    expect(screen.getByText('No strike at or below $20? Sells the last strike at or below $50.')).toBeInTheDocument();
    expect((await saved()).premium).toEqual({ mode: 'atMost', usd: 20, fallbackUsd: 50 });
  });

  it('a fallback that could never find more is refused, with a quick fix', () => {
    show(editing({ premium: { mode: 'atMost', usd: 20, fallbackUsd: 10 } }));
    tab('Sell');
    expect(screen.getByText('The fallback must be above $20: it is tried when nothing is at or below $20.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use $50' }));
    expect(screen.queryByText(/The fallback must be above/)).toBeNull();
  });

  it('at least reads the other way: a lower floor', () => {
    show(editing({ premium: { mode: 'atLeast', usd: 20 } }));
    tab('Sell');
    fireEvent.click(screen.getByRole('switch', { name: /If nothing pays it, try a lower floor/ }));
    expect(screen.getByText('No strike paying $20? Sells the furthest still paying $10.')).toBeInTheDocument();
  });

  it('off is saved as null, and a strict or wall rule has no fallback to offer', async () => {
    show(editing({ premium: { mode: 'atMost', usd: 20, fallbackUsd: 50 } }));
    tab('Sell');
    fireEvent.click(screen.getByRole('switch', { name: /try a higher cap/ }));
    expect((await saved()).premium.fallbackUsd).toBeNull();
  });

  it('is not offered under the strict rule', () => {
    show(editing({ strikeRule: 'strict' }));
    tab('Sell');
    expect(screen.queryByRole('switch', { name: /try a/ })).toBeNull();
  });
});
