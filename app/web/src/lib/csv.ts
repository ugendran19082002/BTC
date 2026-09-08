/**
 * A CSV that opens cleanly in Excel.
 *
 * Three things that are easy to get wrong and expensive when you do:
 *
 *  - a field containing a comma, a quote or a newline has to be quoted, and the
 *    quotes inside it doubled. Without that, one option symbol with a comma in
 *    it shifts every column after it and the sheet is silently wrong;
 *  - a leading BOM, or Excel opens a UTF-8 file as Latin-1 and the rupee sign
 *    becomes â‚¹;
 *  - CRLF line endings, which is what Excel expects on Windows.
 *
 * Numbers go in unformatted -- no currency symbols, no thousands separators --
 * because the point of the download is to do arithmetic on it. The formatting
 * belongs on the screen.
 */

export type CsvColumn<T> = {
  header: string;
  value: (row: T) => string | number | null | undefined;
};

const cell = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','));
  return lines.join('\r\n');
}

/**
 * Hand the file to the browser.
 *
 * The object URL is revoked on the next tick rather than immediately: Safari
 * cancels the download if the URL disappears in the same frame as the click.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
