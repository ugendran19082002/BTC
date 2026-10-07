import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PressureStrip } from '@/components/mobile/PressureStrip';
import type { Pressure } from '@/components/mobile/usePressure';
import type { PriceMove } from '@/lib/price-change';

/** Home's four cards in one row over today's P&L (owner, 7 Oct 2026): CE flow, PE flow, Big move, BTC -- and their window under them. */

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
  it('[critical] one row of four: each tape\'s word and the share that leads, the band with its percent and lean, and BTC', () => {
    const h = show();
    const group = screen.getByRole('group', { name: 'Pressure and price' });
    const cards = within(group);
    const ce = cards.getByRole('button', { name: 'CE flow, 15m: sell pressure, 72% sells. Open Pressure' });
    // (what only a wider row shows is in the page all the same: the window beside the name, the lean in a word, the time, the percent)
    expect(ce).toHaveTextContent('CE flow · 15mSELL72% sellsSELLBUY');
    const pe = cards.getByRole('button', { name: 'PE flow, 15m: buy pressure, 68% buys. Open Pressure' });
    expect(pe).toHaveTextContent('PE flow · 15mBUY68% buysSELLBUY');
    const big = cards.getByRole('button', { name: 'Big move: calm, 31 percent, pressure down, over 15m. Open Pressure' });
    expect(big).toHaveTextContent('Big move15mCALM31%down ↓');
    const btc = cards.getByRole('button', { name: 'BTC index 83,810, perp −50 to the index; since entry −444 points, −0.53%, from 84,254 to 83,810. Open Price changes' });
    expect(btc).toHaveTextContent('BTC index08:1383,810perp −50−444−0.53%since entry 07:30');
    // one row, four across, at every width: the four cards are the row's only children
    const row = ce.parentElement!;
    expect(row.className).toContain('grid-cols-4');
    expect(row.className).not.toMatch(/grid-cols-2/);
    expect([...row.children]).toEqual([ce, pe, big.parentElement, btc]);
    fireEvent.click(ce); fireEvent.click(pe); fireEvent.click(big);
    expect(h.onOpen).toHaveBeenCalledTimes(3);
    fireEvent.click(btc);
    expect(h.onOpenPrice).toHaveBeenCalledOnce();
  });

  it('the window all three readings share is a small dropdown in the big-move card: the desk\'s own list, not the browser\'s', () => {
    const h = show(read(), { window: '60' });
    const open = screen.getByRole('button', { name: 'Window: 1h. Change' });
    // in the card, under its button; what shows of it is the window chosen
    const card = screen.getByRole('button', { name: /^Big move:/ }).parentElement!;
    expect(card).toContainElement(open);
    expect(card).toHaveTextContent('1h');
    expect(screen.getByRole('button', { name: /^CE flow, 1h:/ })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(open);
    const menu = within(screen.getByRole('menu', { name: 'Window' }));
    expect(menu.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['5m5 minutes', '15m15 minutes', '1h1 hour', '4h4 hours']);
    expect(menu.getByRole('menuitemradio', { name: /1 hour/ })).toBeChecked();
    fireEvent.click(menu.getByRole('menuitemradio', { name: /4 hours/ }));
    expect(h.onWindow).toHaveBeenCalledWith('240');
    // chosen, the list closes; and picking a window is not opening a screen
    expect(screen.queryByRole('menu')).toBeNull();
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it('a level tape, a band with no lean, and a desk holding nothing: the move since the last settlement', () => {
    show(read({ ce: side('BALANCED', 0.51), band: 'watch', pressure: 56, lean: 0 }), { price: { ...PRICE, marks: [move('dayStart', 86_211)] }, perp: null });
    expect(screen.getByRole('button', { name: 'CE flow, 15m: balanced, 51% buys. Open Pressure' })).toHaveTextContent('BALANCED51% buys');
    const big = screen.getByRole('button', { name: 'Big move: watch, 56 percent, over 15m. Open Pressure' });
    expect(big).toHaveTextContent('WATCH56%');
    expect(big).not.toHaveTextContent(/↑|↓/);
    const btc = screen.getByRole('button', { name: /^BTC index 83,810; last settlement −2,401 points/ });
    expect(btc).toHaveTextContent('perp —−2,401−2.79%since 17:30');
  });

  it('not read yet is not "no prints": dots while reading, a dash where the tape has nothing, and no move without a mark', () => {
    const { rerender } = render(<PressureStrip pressure={read({ perpRead: false, flow: false, warning: false })} window="60" price={{ at: null, index: null, read: false, marks: [] }} perp={null} onWindow={() => {}} onOpen={() => {}} onOpenPrice={() => {}} />);
    expect(screen.getByRole('button', { name: 'CE flow, 1h: reading. Open Pressure' })).toHaveTextContent('…reading');
    expect(screen.getByRole('button', { name: 'Big move: reading. Open Pressure' })).toHaveTextContent('…reading');
    expect(screen.getByRole('button', { name: 'BTC index: reading. Open Price changes' })).toHaveTextContent('…reading');
    rerender(<PressureStrip pressure={read({ flow: false, pressure: null })} window="60" price={{ ...PRICE, marks: [] }} perp={83_760} onWindow={() => {}} onOpen={() => {}} onOpenPrice={() => {}} />);
    expect(screen.getByRole('button', { name: 'CE flow, 1h: no prints. Open Pressure' })).toHaveTextContent('—no prints');
    expect(screen.getByRole('button', { name: /^Big move: calm, pressure down, over 1h/ })).toHaveTextContent('CALM—');
    expect(screen.getByRole('button', { name: 'BTC index 83,810, perp −50 to the index. Open Price changes' })).toHaveTextContent('—no mark');
  });
});
