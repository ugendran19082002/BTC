import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PressureStrip } from '@/components/mobile/PressureStrip';
import type { Pressure } from '@/components/mobile/usePressure';
import type { PriceMove } from '@/lib/price-change';

/** Home's four cards over today's P&L (owner, 7 Oct 2026): CE flow, PE flow, Big move with its window, and BTC. */

const side = (pressure: string | null, aggressorBuyPct: number | null) => ({ pressure, aggressorBuyPct, cvd: [{ delta: -3 }, { delta: 1 }, { delta: -2 }] });
const read = (o: { ce?: unknown; pe?: unknown; band?: string; pressure?: number | null; lean?: -1 | 0 | 1; perpRead?: boolean; flow?: boolean; warning?: boolean } = {}): Pressure => ({
  chain: null, chainError: null, perpRead: o.perpRead ?? true, perpError: null, leg: null, shock: null, window: '15', perpCvd: [5, 3, 4, 1],
  flow: o.flow === false ? null : { ce: o.ce ?? side('SELL PRESSURE', 0.28), pe: o.pe ?? side('BUY PRESSURE', 0.68) },
  warning: o.warning === false ? null : { band: o.band ?? 'calm', pressure: o.pressure === undefined ? 31 : o.pressure, lean: o.lean ?? -1, triggers: [], score: null, action: '' },
}) as unknown as Pressure;
const AT = Date.UTC(2026, 9, 7, 2, 43); // 08:13 IST
const move = (mark: 'entry' | 'dayStart', from: number, to = 83_810): PriceMove => ({
  key: mark, label: mark === 'entry' ? 'Since entry' : 'Last settlement', mark, at: mark === 'entry' ? Date.UTC(2026, 9, 7, 2, 0) : Date.UTC(2026, 9, 6, 12, 0),
  from, to, pts: to - from, pct: (to / from - 1) * 100, way: to > from ? 'up' : 'down', share: 1,
});
const PRICE = { at: AT, index: 83_810, read: true, marks: [move('entry', 84_254), move('dayStart', 86_211)] };
const show = (pressure = read(), over: Partial<Parameters<typeof PressureStrip>[0]> = {}) => {
  const h = { onWindow: vi.fn(), onOpen: vi.fn(), onOpenPrice: vi.fn() };
  render(<PressureStrip pressure={pressure} window="15" price={PRICE} perp={83_760} {...h} {...over} />);
  return h;
};

describe('PressureStrip', () => {
  it('[critical] four cards: each tape\'s word and the share that leads, the band with its percent and lean, and BTC', () => {
    const h = show();
    const cards = within(screen.getByRole('group', { name: 'Pressure and price' }));
    const ce = cards.getByRole('button', { name: 'CE flow, 15m: sell pressure, 72% sells. Open Pressure' });
    expect(ce).toHaveTextContent('CE flow · 15m');
    expect(ce).toHaveTextContent('72%');
    expect(ce).toHaveTextContent('SELLpressure');
    expect(ce).toHaveTextContent('SELLBUY');
    const pe = cards.getByRole('button', { name: 'PE flow, 15m: buy pressure, 68% buys. Open Pressure' });
    expect(pe).toHaveTextContent('68%');
    expect(pe).toHaveTextContent('BUYpressure');
    const big = cards.getByRole('button', { name: 'Big move: calm, 31 percent, pressure down, over 15m. Open Pressure' });
    expect(big).toHaveTextContent('Big moveCALM');
    expect(big).toHaveTextContent('31%down ↓');
    const btc = cards.getByRole('button', { name: 'BTC index 83,810, perp −50 to the index; since entry −444 points, −0.53%, from 84,254 to 83,810. Open Price changes' });
    expect(btc).toHaveTextContent('08:13');
    expect(btc).toHaveTextContent('83,810');
    expect(btc).toHaveTextContent('perp −50');
    expect(btc).toHaveTextContent('Since entry 07:30');
    expect(btc).toHaveTextContent('−444−0.53%');
    expect(btc).toHaveTextContent('84,254 83,810');
    // two by two: four across would cut the words off
    expect(screen.getByRole('group', { name: 'Pressure and price' }).className).toContain('grid-cols-2');
    fireEvent.click(ce); fireEvent.click(big);
    expect(h.onOpen).toHaveBeenCalledTimes(2);
    fireEvent.click(btc);
    expect(h.onOpenPrice).toHaveBeenCalledOnce();
  });

  it('the window is picked on the big-move card, and the tapes say which they were read over', () => {
    const h = show(read(), { window: '60' });
    const pick = within(screen.getByRole('radiogroup', { name: 'Window' }));
    expect(pick.getAllByRole('radio').map((r) => r.textContent)).toEqual(['5m', '15m', '1h', '4h']);
    expect(pick.getByRole('radio', { name: '1 hour' })).toBeChecked();
    expect(screen.getByRole('button', { name: /^CE flow, 1h:/ })).toBeInTheDocument();
    fireEvent.click(pick.getByRole('radio', { name: '4 hours' }));
    expect(h.onWindow).toHaveBeenCalledWith('240');
    // picking a window is not opening the screen
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it('a level tape, a band with no lean, and a desk holding nothing: the move since the last settlement', () => {
    show(read({ ce: side('BALANCED', 0.51), band: 'watch', pressure: 56, lean: 0 }), { price: { ...PRICE, marks: [move('dayStart', 86_211)] }, perp: null });
    expect(screen.getByRole('button', { name: 'CE flow, 15m: balanced, 51% buys. Open Pressure' })).toHaveTextContent('BALANCEDboth sides');
    const big = screen.getByRole('button', { name: 'Big move: watch, 56 percent, over 15m. Open Pressure' });
    expect(big).toHaveTextContent('WATCH');
    expect(big).not.toHaveTextContent(/↑|↓/);
    const btc = screen.getByRole('button', { name: /^BTC index 83,810; last settlement −2,401 points/ });
    expect(btc).toHaveTextContent('Last settlement 17:30');
    expect(btc).toHaveTextContent('perp —');
  });

  it('not read yet is not "no prints": dots while reading, a dash where the tape has nothing, and no move without a mark', () => {
    const { rerender } = render(<PressureStrip pressure={read({ perpRead: false, flow: false, warning: false })} window="60" price={{ at: null, index: null, read: false, marks: [] }} perp={null} onWindow={() => {}} onOpen={() => {}} onOpenPrice={() => {}} />);
    expect(screen.getByRole('button', { name: 'CE flow, 1h: reading. Open Pressure' })).toHaveTextContent('…reading');
    expect(screen.getByRole('button', { name: 'Big move: reading. Open Pressure' })).toHaveTextContent('…reading');
    expect(screen.getByRole('button', { name: 'BTC index: reading. Open Price changes' })).toHaveTextContent('…reading');
    rerender(<PressureStrip pressure={read({ flow: false, pressure: null })} window="60" price={{ ...PRICE, marks: [] }} perp={83_760} onWindow={() => {}} onOpen={() => {}} onOpenPrice={() => {}} />);
    expect(screen.getByRole('button', { name: 'CE flow, 1h: no prints. Open Pressure' })).toHaveTextContent('—no prints');
    expect(screen.getByRole('button', { name: /^Big move: calm, pressure down, over 1h/ })).toHaveTextContent('CALM—');
    expect(screen.getByRole('button', { name: 'BTC index 83,810, perp −50 to the index. Open Price changes' })).not.toHaveTextContent('Since');
  });
});
