/**
 * A heat table as a picture (owner, 3 Nov 2026: "image download vai click pana apidy image download aakunum" -- the
 * Option history's method × timeframe grid, saved as an image).
 *
 * Drawn from the table's own figures on a canvas, not photographed off the page: the grid on screen scrolls inside its
 * box, and a picture of the page would hold only the rows in view. Every row is drawn, at twice the screen's
 * resolution, in the theme's own colours (read from its CSS variables, light or dark as the page is), each square
 * shaded as the screen shades it -- green as far as it makes money, red as far as it loses, the strongest the darkest.
 */

export type HeatCell = { main: string; sub?: string; value: number; shade: number } | null;
export type HeatRow = { rank?: string; label: string; cells: HeatCell[]; bold?: boolean };
export type HeatTable = {
  title: string;
  /** Under the title: the range, the rules, what the squares show. */
  lines?: string[];
  columns: string[];
  rows: HeatRow[];
  /** The bottom line, set apart: each column's total. */
  footer?: HeatRow | null;
};

const PAD = 16, RANK_W = 34, NAME_W = 300, CELL_W = 78, ROW_H = 40, HEAD_H = 28, TITLE_H = 26, LINE_H = 18;

/** The theme's colours, as the page has them now. */
function themeColours() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', '#0a0d10'), panel: v('--panel', '#14171c'), line: v('--line-soft', '#1f242c'),
    text: v('--text', '#e9edf2'), muted: v('--muted', '#98a3b3'), dim: v('--dim', '#6c7686'),
    up: v('--up', '#0ecb81'), down: v('--down', '#f6465d'),
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
  };
}

/** The table drawn on a canvas, `scale` times the size it is laid out at. */
export function drawHeatTable(t: HeatTable, scale = 2): HTMLCanvasElement {
  const c = themeColours();
  const lines = t.lines ?? [];
  const width = PAD * 2 + RANK_W + NAME_W + CELL_W * t.columns.length;
  const top = PAD + TITLE_H + lines.length * LINE_H + 10;
  const bodyRows = t.rows.length + (t.footer ? 1 : 0);
  const height = top + HEAD_H + ROW_H * bodyRows + PAD + LINE_H;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  g.scale(scale, scale);
  const font = (px: number, weight = 400) => `${weight} ${px}px ${c.font}`;
  const text = (s: string, x: number, y: number, o: { px?: number; weight?: number; colour?: string; align?: CanvasTextAlign; max?: number } = {}) => {
    g.font = font(o.px ?? 12.5, o.weight ?? 400);
    g.fillStyle = o.colour ?? c.text;
    g.textAlign = o.align ?? 'left';
    g.textBaseline = 'middle';
    let out = s;
    // A name too long for its column is cut with an ellipsis, as the screen truncates it.
    if (o.max !== undefined && g.measureText(out).width > o.max) {
      while (out.length > 1 && g.measureText(`${out}…`).width > o.max) out = out.slice(0, -1);
      out = `${out}…`;
    }
    g.fillText(out, x, y);
  };

  g.fillStyle = c.panel;
  g.fillRect(0, 0, width, height);
  text(t.title, PAD, PAD + TITLE_H / 2, { px: 16, weight: 600 });
  lines.forEach((l, i) => text(l, PAD, PAD + TITLE_H + i * LINE_H + LINE_H / 2, { px: 12, colour: c.muted }));

  const x0 = PAD, xCells = PAD + RANK_W + NAME_W;
  // The header
  text('#', x0 + 6, top + HEAD_H / 2, { px: 11, colour: c.muted });
  text('Method', x0 + RANK_W + 8, top + HEAD_H / 2, { px: 11, colour: c.muted });
  t.columns.forEach((name, i) => text(name, xCells + CELL_W * i + CELL_W / 2, top + HEAD_H / 2, { px: 11, colour: c.muted, align: 'center' }));

  const row = (r: HeatRow, y: number, apart: boolean) => {
    if (apart) { g.fillStyle = c.line; g.fillRect(x0, y - 1, width - PAD * 2, 2); }
    if (r.rank) text(r.rank, x0 + RANK_W - 8, y + ROW_H / 2, { colour: c.muted, align: 'right' });
    text(r.label, x0 + RANK_W + 8, y + ROW_H / 2, { weight: r.bold ? 600 : 400, max: NAME_W - 16 });
    r.cells.forEach((cell, i) => {
      const x = xCells + CELL_W * i;
      g.strokeStyle = c.line;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, CELL_W - 1, ROW_H - 1);
      if (!cell) { text('·', x + CELL_W / 2, y + ROW_H / 2, { colour: c.dim, align: 'center' }); return; }
      if (cell.value !== 0) {
        g.globalAlpha = Math.min(1, Math.max(0, cell.shade));
        g.fillStyle = cell.value > 0 ? c.up : c.down;
        g.fillRect(x + 1, y + 1, CELL_W - 2, ROW_H - 2);
        g.globalAlpha = 1;
      }
      const bold = r.bold || i === r.cells.length - 1;
      text(cell.main, x + CELL_W / 2, y + (cell.sub ? 15 : ROW_H / 2), { px: 12, weight: bold ? 600 : 400, align: 'center' });
      if (cell.sub) text(cell.sub, x + CELL_W / 2, y + 29, { px: 10.5, colour: c.muted, align: 'center' });
    });
  };
  t.rows.forEach((r, i) => row(r, top + HEAD_H + ROW_H * i, false));
  if (t.footer) row({ ...t.footer, bold: true }, top + HEAD_H + ROW_H * t.rows.length, true);
  text(`Saved ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} IST`,
    width - PAD, height - PAD / 2 - LINE_H / 2, { px: 10.5, colour: c.dim, align: 'right' });
  return canvas;
}

/** The table saved as a PNG under `filename`. Resolves false where the browser gives no picture to save. */
export async function downloadHeatTable(t: HeatTable, filename: string): Promise<boolean> {
  const blob = await new Promise<Blob | null>((done) => drawHeatTable(t).toBlob(done, 'image/png'));
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.png') ? filename : `${filename}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // After the click has been taken up: revoked at once, some browsers save nothing.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return true;
}
