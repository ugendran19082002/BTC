import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawHeatTable, downloadHeatTable, type HeatTable } from '@/lib/heat-table-image';

/** The picture drawn from the table's figures (3 Nov 2026): every row's words on it, twice the size, saved as a PNG. */
const TABLE: HeatTable = {
  title: 'Option history · method × timeframe', lines: ['Expiry days 2026-10-04 – 2026-11-03'],
  columns: ['3m', 'All'],
  rows: Array.from({ length: 30 }, (_, i) => ({ rank: String(i + 1), label: `#${i + 1} Method`, cells: [{ main: '+₹1.8K', sub: '1,982', value: 1, shade: 0.6 }, null] })),
  footer: { label: 'Every method', cells: [{ main: '+₹9K', value: 1, shade: 0.6 }, { main: '', value: 0, shade: 0 }] },
};

/** A 2D context that keeps what was written on it. */
function fakeContext() {
  const said: string[] = [];
  const ctx = new Proxy({ fillText: (s: string) => { said.push(s); }, measureText: (s: string) => ({ width: s.length * 6 }) } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : () => {}), set: (t, k, v) => { t[k as string] = v; return true; } });
  return { said, ctx };
}

afterEach(() => vi.restoreAllMocks());

describe('heat table image', () => {
  it('[critical] every row is drawn -- its rank, its name, its squares -- under the title and the lines, at twice the size', () => {
    const { said, ctx } = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    const canvas = drawHeatTable(TABLE);
    expect(said).toContain('Option history · method × timeframe');
    expect(said).toContain('Expiry days 2026-10-04 – 2026-11-03');
    for (let i = 1; i <= 30; i++) expect(said).toContain(`#${i} Method`);
    expect(said.filter((s) => s === '+₹1.8K')).toHaveLength(30);
    expect(said).toContain('Every method');
    expect(said.filter((s) => s === '·')).toHaveLength(30);
    expect(canvas.width).toBe(2 * (16 * 2 + 34 + 300 + 78 * 2));
  });

  it('saved as a PNG, under its name', async () => {
    const { ctx } = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) { cb(new Blob(['png'], { type: 'image/png' })); });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    expect(await downloadHeatTable(TABLE, 'grid')).toBe(true);
    expect(clicked).toEqual(['grid.png']);
  });

  it('a browser that gives no picture: nothing saved, and false', async () => {
    const { ctx } = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(null));
    expect(await downloadHeatTable(TABLE, 'grid')).toBe(false);
  });
});
