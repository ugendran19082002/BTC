import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditExitsSheet } from '@/components/trade/EditExitsSheet';
import type { Trade } from '@/types/trade';

const updateExits = vi.fn();
vi.mock('@/api/trade', () => ({ updateExits: (...a: unknown[]) => updateExits(...a) }));

/** Sold one at 30.90 with a target at 1.90 — a 94% decay — and no stop. */
const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: 't1',
  symbol: 'P-BTC-76600-090926',
  productId: 1,
  optionSide: 'PE',
  phase: 'protected',
  position: -1,
  requestedSize: 1,
  entrySize: 1,
  entryAvgPrice: 30.9,
  exitSize: 0,
  exitAvgPrice: null,
  protection: { takeProfit: 'tp', stopLoss: null },
  realisedPnl: 0,
  fills: [],
  note: null,
  alarm: null,
  updatedAt: Date.now(),
  plan: {
    lots: 1,
    entry: { type: 'limit', limitPrice: 30.9, timeoutMs: 0, marketFallback: false },
    takeProfitPrice: 1.9,
    stopPrice: null,
    // set as a percentage, so it opens as one
    exitAsk: { takeProfitPct: 0.94 },
    leverage: 200,
  },
  onBook: { target: 1.9, stop: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  updateExits.mockResolvedValue({ ok: true });
});

describe('opening it', () => {
  it('shows the level that is actually on the book', () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    expect(screen.getByText('On Delta now · target').nextSibling).toHaveTextContent('1.90');
    expect(screen.getByText('On Delta now · stop').nextSibling).toHaveTextContent('none');
  });

  it('seeds the box from that level, not from a default', () => {
    // 1 - 1.90/30.90 is 93.85%, and that is what the box must say
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    expect(screen.getByText('−93.9%')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'target percent' })).toHaveValue('93.85');
    expect(screen.getByRole('checkbox', { name: /take profit/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /stop loss/i })).not.toBeChecked();
  });

  it('does not claim a stop is on when only the plan has one', () => {
    // the plan wanted one and it never went on: the book is what counts
    render(<EditExitsSheet
      trade={trade({ plan: { ...trade().plan!, stopPrice: 80 }, onBook: { target: 1.9, stop: null } })}
      open onOpenChange={() => {}}
    />);
    expect(screen.getByText('On Delta now · stop').nextSibling).toHaveTextContent('none');
  });

  it('says so when the desk and the book disagree', () => {
    // the case that made this panel worth having: the plan said 1.90 while
    // Delta's book held 20.80
    render(<EditExitsSheet trade={trade({ onBook: { target: 20.8, stop: null } })} open onOpenChange={() => {}} />);
    expect(screen.getByText('On Delta now · target').nextSibling).toHaveTextContent('20.80');
    expect(screen.getByText(/asked for 1.90 but Delta holds 20.80/)).toBeInTheDocument();
  });

  it('[critical] the box shows the book, not the plan, when they differ', () => {
    // −94% beside a book holding 25.10 is the box describing something that is
    // not there. 1 - 25.10/30.90 is 18.8%.
    render(<EditExitsSheet trade={trade({ onBook: { target: 25.1, stop: null } })} open onOpenChange={() => {}} />);
    expect(screen.getByText('−18.8%')).toBeInTheDocument();
    expect(screen.queryByText('−93.9%')).toBeNull();
    // the price sits in its own <b>, so match the value rather than the sentence
    expect(screen.getAllByText('25.10').length).toBeGreaterThan(0);
  });
});

/** Type into one of the exit boxes the way a person does: focus, then the text. */
const type = (label: string, text: string) => {
  const box = screen.getByRole('textbox', { name: label });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: text } });
};

describe('[critical] the poll must not undo what you typed', () => {
  it('keeps what you typed when the trade object is replaced', async () => {
    // the trade is refreshed every second; an effect that depends on anything
    // inside it puts the number back where it started, mid-typing
    const { rerender } = render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    type('target percent', '90');
    expect(screen.getByText('−90%')).toBeInTheDocument();

    // a poll arrives: same trade, new object, new timestamp
    await act(async () => {
      rerender(<EditExitsSheet trade={trade({ updatedAt: Date.now() + 1_000 })} open onOpenChange={() => {}} />);
    });
    expect(screen.getByText('−90%')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'target percent' })).toHaveValue('90');
  });

  it('sends what is on screen, not what it opened with', async () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    type('target percent', '92.5');

    fireEvent.click(screen.getByRole('button', { name: /save exits/i }));
    await waitFor(() => expect(updateExits).toHaveBeenCalled());
    const [, ask] = updateExits.mock.calls[0]!;
    expect(ask.takeProfitPct).toBeCloseTo(0.925);
    expect(ask.takeProfitPoints).toBe(0);
  });

  it('reseeds when it is opened again, so it never shows a stale edit', async () => {
    const { rerender } = render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    type('target percent', '50');
    expect(screen.getByText('−50%')).toBeInTheDocument();

    // two commits, because that is what closing and reopening actually is --
    // batching them into one would test a thing the browser never does
    await act(async () => {
      rerender(<EditExitsSheet trade={trade()} open={false} onOpenChange={() => {}} />);
    });
    await act(async () => {
      rerender(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    });
    expect(screen.getByText('−93.9%')).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('turns an exit that is off into a zero, which means off', async () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /take profit/i }));
    fireEvent.click(screen.getByRole('button', { name: /save exits/i }));
    await waitFor(() => expect(updateExits).toHaveBeenCalledWith('t1', {
      takeProfitPct: 0, takeProfitPoints: 0, stopLossPct: 0, stopLossPoints: 0,
    }));
  });

  it('[critical] a stop above 100% is saved as typed', async () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /stop loss/i }));
    type('stop percent', '250');
    fireEvent.click(screen.getByRole('button', { name: /save exits/i }));
    await waitFor(() => expect(updateExits).toHaveBeenCalled());
    expect(updateExits.mock.calls[0]![1].stopLossPct).toBe(2.5);
  });

  it('[critical] a fixed stop is sent as points, and the level shown is entry + points', async () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /stop loss/i }));
    fireEvent.click(screen.getAllByRole('radio', { name: 'Fixed' })[1]!);
    type('stop points', '20');
    expect(screen.getAllByText('50.90').length).toBeGreaterThan(0);  // 30.90 + 20
    fireEvent.click(screen.getByRole('button', { name: /save exits/i }));
    await waitFor(() => expect(updateExits).toHaveBeenCalled());
    expect(updateExits.mock.calls[0]![1]).toMatchObject({ stopLossPct: 0, stopLossPoints: 20 });
  });

  it('opening on a live target fills the Fixed box with the same level in points', () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getAllByRole('radio', { name: 'Fixed' })[0]!);
    expect(screen.getByRole('textbox', { name: 'target points' })).toHaveValue('29');  // 30.90 - 1.90
  });

  it('[critical] a stop typed as a price is sent as that price', async () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /stop loss/i }));
    fireEvent.click(screen.getAllByRole('radio', { name: 'Price' })[1]!);
    type('stop price', '70');
    expect(screen.getByText(/entry 30.90 \+ 39.1 pts/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save exits/i }));
    await waitFor(() => expect(updateExits).toHaveBeenCalled());
    expect(updateExits.mock.calls[0]![1]).toMatchObject({ stopLossPct: 0, stopLossPoints: 0, stopPrice: 70 });
  });

  it('Price opens on the level that is live on the book', () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getAllByRole('radio', { name: 'Price' })[0]!);
    expect(screen.getByRole('textbox', { name: 'target price' })).toHaveValue('1.9');
  });

  it('[critical] a stop price under the entry holds Save back', () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /stop loss/i }));
    fireEvent.click(screen.getAllByRole('radio', { name: 'Price' })[1]!);
    type('stop price', '20');
    expect(screen.getByRole('alert')).toHaveTextContent('A stop of 20 must be over the 30.9 entry');
    expect(screen.getByRole('button', { name: /save exits/i })).toBeDisabled();
  });

  it('[critical] Save is held back while a number is out of range', () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    type('target percent', '120');
    expect(screen.getByRole('alert')).toHaveTextContent(/between 0 and 99%/);
    expect(screen.getByRole('button', { name: /save exits/i })).toBeDisabled();
  });

  it('closes and reports back when it lands', async () => {
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    render(<EditExitsSheet trade={trade()} open onOpenChange={onOpenChange} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /save exits/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says why rather than closing on a failure', async () => {
    updateExits.mockRejectedValue(new Error('no such trade'));
    const onOpenChange = vi.fn();
    render(<EditExitsSheet trade={trade()} open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: /save exits/i }));
    await waitFor(() => expect(screen.getByText('no such trade')).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

/**
 * The price you are setting the exit against.
 *
 * Dragging a target without being able to see where the mark is, is guesswork
 * — and the case that matters is a target set at or above the mark, which
 * closes the position the moment it is moved. That is not hypothetical: a
 * target that fired on placement bought a short back at the price it had just
 * been sold at, twice, on 9 September.
 */
describe('the live figures', () => {
  const withLive = (over: Partial<NonNullable<Trade['live']>> = {}) => ({
    ...trade(),
    entryAvgPrice: 19,
    onBook: { target: 16.3, stop: null },
    plan: { ...trade().plan!, takeProfitPrice: 16.3, stopPrice: null },
    live: {
      markPrice: 17.5, unrealisedPnl: 0.0015, decayed: 0.08, liquidationPrice: 216.76,
      ...over,
    },
  }) as Trade;

  it('shows the mark, so the level is set against something', () => {
    render(<EditExitsSheet trade={withLive()} open onOpenChange={() => {}} />);
    expect(screen.getByText('Price now')).toBeInTheDocument();
    expect(screen.getByText('17.50')).toBeInTheDocument();
  });

  it('shows the profit in rupees with the dollars underneath', () => {
    render(<EditExitsSheet trade={withLive({ unrealisedPnl: 2 })} open onOpenChange={() => {}} />);
    expect(screen.getByText('+₹170')).toBeInTheDocument();
    expect(screen.getByText('+$2.00')).toBeInTheDocument();
  });

  it('colours a loss as a loss', () => {
    render(<EditExitsSheet trade={withLive({ unrealisedPnl: -2 })} open onOpenChange={() => {}} />);
    expect(screen.getByText('−₹170').className).toContain('--down');
  });

  it('says how far the mark still has to fall', () => {
    // seeded from the book at 16.30 against a mark of 17.50
    render(<EditExitsSheet trade={withLive()} open onOpenChange={() => {}} />);
    expect(screen.getByText('To target')).toBeInTheDocument();
    expect(screen.getByText('1.20')).toBeInTheDocument();
  });

  it('[critical] warns when the target is already at or above the mark', () => {
    // the mark has fallen past the target: moving it closes the position now
    render(<EditExitsSheet trade={withLive({ markPrice: 15 })} open onOpenChange={() => {}} />);
    expect(screen.getByText('reached')).toBeInTheDocument();
    expect(screen.getByText(/fills as soon as it is set/)).toBeInTheDocument();
  });

  it('says nothing about a distance when the target is switched off', () => {
    const off = { ...withLive(), onBook: { target: null, stop: null } } as Trade;
    off.plan = { ...off.plan!, takeProfitPrice: null };
    render(<EditExitsSheet trade={off} open onOpenChange={() => {}} />);
    expect(screen.queryByText(/fills as soon as it is set/)).toBeNull();
  });

  it('has nothing to claim when the exchange has not sent a mark', () => {
    render(<EditExitsSheet trade={withLive({ markPrice: null })} open onOpenChange={() => {}} />);
    expect(screen.queryByText(/fills as soon as it is set/)).toBeNull();
  });
});

describe('[critical] each exit opens in the terms it was set in', () => {
  /** 22 Sep: UG-PE sold 100 × 83,800 PE at 20 -- target 80% (follows the fill), stop at 70 (a fixed price). */
  const ug = () => trade({
    symbol: 'P-BTC-83800-230926', position: -100, entrySize: 100, entryAvgPrice: 20,
    plan: { ...trade().plan!, takeProfitPrice: 4, stopPrice: 70, exitAsk: { takeProfitPct: 0.8 } },
    onBook: { target: 4, stop: 70 },
  });

  it('the stop set as a price opens as Price 70 -- not as "+250%"', () => {
    render(<EditExitsSheet trade={ug()} open onOpenChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'stop price' })).toHaveValue('70');
    expect(screen.queryByText('+250%')).toBeNull();
    expect(screen.getByText('at 70.00 (+50 pts)')).toBeInTheDocument();
    // the target was a percentage, and stays one
    expect(screen.getByRole('textbox', { name: 'target percent' })).toHaveValue('80');
  });

  it('[critical] saving without touching anything keeps the stop fixed at 70', async () => {
    render(<EditExitsSheet trade={ug()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /save exits/i }));
    await waitFor(() => expect(updateExits).toHaveBeenCalled());
    expect(updateExits.mock.calls[0]![1]).toMatchObject({ stopPrice: 70, stopLossPct: 0, stopLossPoints: 0, takeProfitPct: 0.8 });
  });

  it('a stop set as points opens as Fixed', () => {
    render(<EditExitsSheet trade={trade({ plan: { ...ug().plan!, exitAsk: { stopLossPoints: 50 } }, onBook: { target: 4, stop: 70 }, entryAvgPrice: 20 })} open onOpenChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'stop points' })).toHaveValue('50');
  });
});
