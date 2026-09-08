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
    expect(screen.getByText('on the book now · target').nextSibling).toHaveTextContent('1.90');
    expect(screen.getByText('on the book now · stop').nextSibling).toHaveTextContent('none');
  });

  it('seeds the bar from that level, not from a default', () => {
    // 1 - 1.90/30.90 is 94%, and that is what the bar must say
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    expect(screen.getByText('−94%')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /take profit/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /stop loss/i })).not.toBeChecked();
  });

  it('does not claim a stop is on when only the plan has one', () => {
    // the plan wanted one and it never went on: the book is what counts
    render(<EditExitsSheet
      trade={trade({ plan: { ...trade().plan!, stopPrice: 80 }, onBook: { target: 1.9, stop: null } })}
      open onOpenChange={() => {}}
    />);
    expect(screen.getByText('on the book now · stop').nextSibling).toHaveTextContent('none');
  });

  it('says so when the desk and the book disagree', () => {
    // the case that made this panel worth having: the plan said 1.90 while
    // Delta's book held 20.80
    render(<EditExitsSheet trade={trade({ onBook: { target: 20.8, stop: null } })} open onOpenChange={() => {}} />);
    expect(screen.getByText('on the book now · target').nextSibling).toHaveTextContent('20.80');
    expect(screen.getByText(/asked for 1.90 and the book holds 20.80/)).toBeInTheDocument();
  });
});

describe('[critical] the poll must not undo your drag', () => {
  it('keeps what you dragged when the trade object is replaced', async () => {
    // the trade is refreshed every second; an effect that depends on anything
    // inside it puts the slider back where it started, mid-drag
    const { rerender } = render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);

    const slider = screen.getByRole('slider', { name: 'target percent' });
    slider.focus();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    const dragged = screen.getByText(/−\d+%/).textContent;
    expect(dragged).not.toBe('−94%');

    // a poll arrives: same trade, new object, new timestamp
    await act(async () => {
      rerender(<EditExitsSheet trade={trade({ updatedAt: Date.now() + 1_000 })} open onOpenChange={() => {}} />);
    });
    expect(screen.getByText(/−\d+%/).textContent).toBe(dragged);
  });

  it('sends what is on screen, not what it opened with', async () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    const slider = screen.getByRole('slider', { name: 'target percent' });
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });

    fireEvent.click(screen.getByRole('button', { name: /move them/i }));
    await waitFor(() => expect(updateExits).toHaveBeenCalled());
    const [, pct] = updateExits.mock.calls[0]!;
    expect(pct.takeProfitPct).toBeLessThan(0.94);
    expect(pct.takeProfitPct).toBeGreaterThan(0.9);
  });

  it('reseeds when it is opened again, so it never shows a stale drag', async () => {
    const { rerender } = render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    const slider = screen.getByRole('slider', { name: 'target percent' });
    slider.focus();
    for (let i = 0; i < 10; i++) fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(screen.getByText(/−\d+%/).textContent).not.toBe('−94%');

    // two commits, because that is what closing and reopening actually is --
    // batching them into one would test a thing the browser never does
    await act(async () => {
      rerender(<EditExitsSheet trade={trade()} open={false} onOpenChange={() => {}} />);
    });
    await act(async () => {
      rerender(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    });
    expect(screen.getByText('−94%')).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('turns a bar that is off into a zero, which means off', async () => {
    render(<EditExitsSheet trade={trade()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /take profit/i }));
    fireEvent.click(screen.getByRole('button', { name: /move them/i }));
    await waitFor(() => expect(updateExits).toHaveBeenCalledWith('t1', { takeProfitPct: 0, stopLossPct: 0 }));
  });

  it('closes and reports back when it lands', async () => {
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    render(<EditExitsSheet trade={trade()} open onOpenChange={onOpenChange} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /move them/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says why rather than closing on a failure', async () => {
    updateExits.mockRejectedValue(new Error('no such trade'));
    const onOpenChange = vi.fn();
    render(<EditExitsSheet trade={trade()} open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: /move them/i }));
    await waitFor(() => expect(screen.getByText('no such trade')).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
