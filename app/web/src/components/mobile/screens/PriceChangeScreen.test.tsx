import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { PriceChange } from '@/api/desk';
import { PhoneContext, type PhoneData } from '@/components/mobile/phone-context';

/** Price changes, under More (owner, 7 Oct 2026): each window says from what, to what, how far. */

const getPriceChange = vi.fn();
vi.mock('@/api/desk', () => ({ getPriceChange: (...a: unknown[]) => getPriceChange(...a) }));

const { PriceChangeScreen } = await import('@/components/mobile/screens/PriceChangeScreen');

// Wed 7 Oct 2026, 19:55 IST
const NOW = Date.UTC(2026, 9, 7, 14, 25);
const NOWPX = 83_774;
const row = (minutes: number | null, then: number | null, mark: PriceChange['mark'] = null, at = NOW - (minutes ?? 0) * 60_000): PriceChange =>
  ({ minutes, mark, at, then, pts: then === null ? null : NOWPX - then, pct: then === null ? null : (NOWPX / then - 1) * 100 });
const ENTRY = Date.UTC(2026, 9, 7, 2, 0); // 07:30 IST
const ROWS = [row(1, 83_785), row(30, 84_991), row(240, 83_500), row(720, null), row(null, 84_254, 'entry', ENTRY), row(null, 86_211, 'dayStart', Date.UTC(2026, 9, 7, 12, 0))];
const trade = (position: number, ts: number) => ({ position, fills: [{ ts }, { ts: ts + 60_000 }] });
const show = (over: Partial<PhoneData> = {}) => render(
  <PhoneContext.Provider value={{ now: NOW, status: null, perp: 83_790, perpLive: true, ...over } as PhoneData}><PriceChangeScreen /></PhoneContext.Provider>,
);

beforeEach(() => {
  getPriceChange.mockReset();
  getPriceChange.mockResolvedValue({ at: NOW, spot: NOWPX, rows: ROWS });
});

describe('PriceChangeScreen', () => {
  it('[critical] the index now, and for each window: from what to what, the points, the percent, the way', async () => {
    show();
    const list = within(await screen.findByRole('list', { name: 'Price change by window' }));
    const rows = list.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('30m');
    expect(rows[1]).toHaveTextContent('19:25');
    expect(rows[1]).toHaveTextContent('84,991');
    expect(rows[1]).toHaveTextContent('83,774');
    expect(rows[1]).toHaveTextContent('−1,217 pts');
    expect(rows[1]).toHaveTextContent('−1.43%');
    expect(rows[1]).toHaveAccessibleName('30m, from 19:25: down −1,217 points, −1.43%, from 84,991 to 83,774');
    expect(rows[2]).toHaveTextContent('+274 pts');
    expect(rows[2]).toHaveAccessibleName(/^4h, from 15:55: up \+274 points/);
    // where the candles do not reach: a dash, not a zero
    expect(rows[3]).toHaveAccessibleName('12h, from 07:55: no record');
    expect(rows[3]).not.toHaveTextContent('pts');
    expect(screen.getByText('BTC index now').parentElement!.parentElement!).toHaveTextContent('83,774');
    expect(screen.getByText(/Perp last/)).toHaveTextContent('Perp last 83,790 · +16 to the index');
  });

  it('the desk\'s marks have a card of their own: since entry, and the last settlement', async () => {
    show();
    const marks = (await screen.findByText('Since the desk\'s marks')).closest('div')!.parentElement!;
    expect(within(marks).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual([
      'Since entry, from 07:30: down −480 points, −0.57%, from 84,254 to 83,774',
      'Last settlement, from 17:30: down −2,437 points, −2.83%, from 86,211 to 83,774',
    ]);
  });

  it('asks from the first fill of what the desk holds now, and the next settlement; with nothing held, no entry', async () => {
    show({ status: { open: [trade(-500, ENTRY + 3_600_000), trade(-500, ENTRY), trade(0, ENTRY - 9_000_000)] } as unknown as PhoneData['status'] });
    await screen.findByRole('list', { name: 'Price change by window' });
    // settles 8 Oct 17:30 IST: the 7th's has passed at 19:55
    expect(getPriceChange).toHaveBeenCalledWith(ENTRY, Date.UTC(2026, 9, 8, 12, 0) / 1000);
    getPriceChange.mockClear();
    show();
    await screen.findAllByRole('list', { name: 'Price change by window' });
    expect(getPriceChange).toHaveBeenCalledWith(null, Date.UTC(2026, 9, 8, 12, 0) / 1000);
  });

  it('no marks sent: no card for them; no rows at all: says so', async () => {
    getPriceChange.mockResolvedValue({ at: NOW, spot: NOWPX, rows: [] });
    show();
    expect(await screen.findByText('No price record yet.')).toBeInTheDocument();
    expect(screen.queryByText('Since the desk\'s marks')).toBeNull();
  });
});
