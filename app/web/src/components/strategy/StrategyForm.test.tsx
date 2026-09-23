import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrategyForm } from '@/components/strategy/StrategyForm';
import { DEFAULT_CONFIG, type Strategy } from '@/types/strategy';

const saveStrategy = vi.fn();
vi.mock('@/api/strategy', () => ({
  saveStrategy: (...a: unknown[]) => saveStrategy(...a),
}));

/**
 * The strategy form, on a phone.
 *
 * Three tabs instead of one long column; times picked on a clock with AM or PM;
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

describe('three tabs instead of one long page', () => {
  it('[critical] opens on When, and each tab shows only its own settings', () => {
    show();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['When', 'Sell', 'Entry & exit']);
    expect(screen.getByRole('tab', { name: 'When' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /^Entry time:/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('lots')).toBeNull();

    tab('Sell');
    expect(screen.getByLabelText('lots')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Entry time:/ })).toBeNull();

    tab('Entry & exit');
    expect(screen.getByLabelText('Take profit percent')).toBeInTheDocument();

  });

  it('arrow keys move between tabs', () => {
    show();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Sell' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Entry & exit' })).toHaveAttribute('aria-selected', 'true');
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

describe('exits as a price: the level fixed, the balance shown against the entry', () => {
  it('[critical] Offer at $15: SL typed 70 shows the balance +55 and saves the level', async () => {
    show(editing({ premium: { mode: 'atLeast', usd: 15 }, entryPrice: 'offer' }));
    tab('Entry & exit');
    const sl = exitBox('Stop loss');
    fireEvent.click(within(sl).getByRole('radio', { name: 'Price' }));
    typeInto('Stop loss price', '70', sl);
    expect(within(sl).getByText(/stops at/)).toBeInTheDocument();
    expect(within(sl).getByText('+55 pts')).toBeInTheDocument();
    expect(within(sl).getByText(/offer ≈ 15.00 → balance/)).toBeInTheDocument();
    expect(within(sl).getByText(/the balance changes, not the stop/)).toBeInTheDocument();
    expect(await saved()).toMatchObject({ stopMode: 'price', stopLossAt: 70 });
  });

  it('[critical] Bid now reads the same level against the bid, and the balance updates as the premium changes', () => {
    show(editing({ premium: { mode: 'atLeast', usd: 15 }, entryPrice: 'now', stopMode: 'price', stopLossAt: 70 }));
    tab('Sell');
    const usd = screen.getByRole('textbox', { name: 'premium usd' });
    fireEvent.change(usd, { target: { value: '20' } });
    tab('Entry & exit');
    const sl = exitBox('Stop loss');
    expect(within(sl).getByText(/bid ≈ 20.00 → balance/)).toBeInTheDocument();
    expect(within(sl).getByText('+50 pts')).toBeInTheDocument();
  });

  it('My price reads it against your own price', () => {
    show(editing({ entryPrice: 'set', entryLimit: 16, targetMode: 'price', takeProfitAt: 4 }));
    tab('Entry & exit');
    expect(within(exitBox('Take profit')).getByText(/your price 16.00 → balance/)).toBeInTheDocument();
    expect(within(exitBox('Take profit')).getByText('−12 pts')).toBeInTheDocument();
  });

  it('[critical] a stop typed under the entry is warned about before the save', () => {
    show(editing({ premium: { mode: 'atLeast', usd: 15 }, stopMode: 'price', stopLossAt: 12 }));
    tab('Entry & exit');
    expect(within(exitBox('Stop loss')).getByText(/this stop is not over the entry, so the order would be refused/)).toBeInTheDocument();
  });

  it('a rule that picks the strike by position says the balance is worked out when it runs', () => {
    show(editing({ strikeRule: 'strict', stopMode: 'price', stopLossAt: 70 }));
    tab('Entry & exit');
    expect(within(exitBox('Stop loss')).getByText(/The entry is not known until the strike is picked/)).toBeInTheDocument();
  });

  it('the read-back sentence says the level', () => {
    show(editing({ stopMode: 'price', stopLossAt: 70 }));
    expect(screen.getAllByText(/stop at 70/).length).toBeGreaterThan(0);
  });
});

describe('warnings for what is allowed but probably not meant', () => {
  it('[critical] a name that says CE on a put strategy is warned about', () => {
    show(editing({ legs: 'PE' }, 'UG-CE'));
    expect(screen.getAllByText('The name says CE, but this sells a put (PE).').length).toBeGreaterThan(0);
  });
  it('[critical] a step that repeats the value before it is warned about', () => {
    show(editing({ takeProfitPct: 0.8, targetSteps: [{ at: '07:30', value: 0.8 }, { at: '09:30', value: 0.85 }] }));
    tab('Entry & exit');
    expect(screen.getByText(/The 7:30 AM step keeps 80% -- it changes nothing/)).toBeInTheDocument();
  });
});
