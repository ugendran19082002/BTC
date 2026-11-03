import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReplayGroup, ReplaySide } from '@/types/option-replay';
import type { HeatTable } from '@/lib/heat-table-image';
import { compactInr, usdToInr } from '@/lib/format';

/**
 * The method × timeframe grid saved as a picture (owner, 3 Nov 2026: "image download vai click pana apidy image download
 * aakunum"). What the button hands the drawing: every row, not the ones in view; the columns as on screen; each square
 * as it says now; the range and the rules under the title.
 */
const downloadHeatTable = vi.fn<(t: HeatTable, name: string) => Promise<boolean>>();
vi.mock('@/lib/heat-table-image', () => ({ downloadHeatTable: (t: HeatTable, name: string) => downloadHeatTable(t, name) }));
const { MethodGrid } = await import('@/components/report/OptionHistory');

const side = (netUsd: number, o: Partial<ReplaySide> = {}): ReplaySide => ({ trades: 2, wins: 1, losses: 1, profitUsd: Math.max(netUsd, 0), lossUsd: Math.max(-netUsd, 0), netUsd, ...o });
const group = (key: string, trades: number, net: number, o: Partial<ReplayGroup> = {}): ReplayGroup =>
  ({ key, name: key, trades, open: 0, traded: trades, better: 0, worse: 0, actual: side(net), replay: side(net), daysUp: 2, daysDown: 1, ...o });
// 40 methods: more than the box shows at once.
const ROWS = Array.from({ length: 40 }, (_, i) => group(`m${i}`, 10 + i, 1 - i * 0.05, { name: `#${i + 1} Method ${i + 1}` }));
const COLS = [group('3m', 100, 2), group('chain', 50, -1)];
const CELLS = [group('m0|3m', 5, 0.8), group('m0|chain', 5, -0.2), group('m1|3m', 3, 0.1)];

beforeEach(() => { window.localStorage.clear(); downloadHeatTable.mockReset().mockResolvedValue(true); });

describe('the method × timeframe grid as a picture', () => {
  it('[critical] every row, ranked as shown, the columns as on screen, each square as it says -- and the range and rules under the title', async () => {
    render(<MethodGrid rows={ROWS} cells={CELLS} columns={COLS} caption={['Expiry days 2026-10-04 – 2026-11-03', 'Option SL 250% · Option TGT 90%']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));
    await waitFor(() => expect(downloadHeatTable).toHaveBeenCalledTimes(1));
    const [t, name] = downloadHeatTable.mock.lastCall!;
    expect(name).toMatch(/^option-history-method-timeframe-net-\d{4}-\d{2}-\d{2}$/);
    expect(t.columns).toEqual(['3m', 'Chain', 'All']);
    expect(t.rows).toHaveLength(40);
    expect(t.rows[0]!.rank).toBe('1');
    expect(t.rows[0]!.label).toBe('#1 Method 1');
    expect(t.rows[0]!.cells.map((c) => c?.main ?? null)).toEqual([compactInr(usdToInr(0.8)), compactInr(usdToInr(-0.2)), compactInr(usdToInr(1))]);
    expect(t.rows[0]!.cells[0]!.sub).toBe('5');
    expect(t.rows[1]!.cells[1]).toBeNull();
    expect(t.footer!.label).toBe('Every method');
    expect(t.footer!.cells.slice(0, 2).map((c) => c!.main)).toEqual([compactInr(usdToInr(2)), compactInr(usdToInr(-1))]);
    expect(t.lines).toEqual(['Expiry days 2026-10-04 – 2026-11-03', 'Option SL 250% · Option TGT 90%', 'Squares: Net ₹ · the small number is the trades · green makes money, red loses']);
  });

  it('the squares as they say now: win % chosen, the picture says win %', async () => {
    render(<MethodGrid rows={ROWS.slice(0, 2)} cells={CELLS} columns={COLS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Win %' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));
    await waitFor(() => expect(downloadHeatTable).toHaveBeenCalled());
    const [t, name] = downloadHeatTable.mock.lastCall!;
    expect(name).toMatch(/-win-/);
    expect(t.rows[0]!.cells[0]!.main).toBe('50.0%');
  });

  it('a browser that gives no picture is said; an empty grid has nothing to save', async () => {
    downloadHeatTable.mockResolvedValue(false);
    const { rerender } = render(<MethodGrid rows={ROWS.slice(0, 1)} cells={CELLS} columns={COLS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The picture could not be made in this browser.');
    rerender(<MethodGrid rows={[]} cells={[]} columns={COLS} />);
    expect(screen.getByRole('button', { name: 'Download image' })).toBeDisabled();
  });
});
