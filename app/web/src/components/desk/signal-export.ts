import type { StateHistoryRow } from '@/api/desk';

/**
 * The signal history as a spreadsheet.
 *
 * Everything the screen shows and the two things it cannot: the exact
 * timestamp, and the outcome as the journal stored it. A trader checking last
 * Tuesday against their own broker statement needs both, and needs them in a
 * file rather than in a list they have to scroll and retype.
 *
 * CSV rather than a real spreadsheet on purpose: every tool opens it, it needs
 * no library, and there is nothing here that a cell format would improve.
 */

const IST_STAMP = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** The day a moment falls on in IST, as `2026-09-26`. */
export const istDay = (at: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at);

const cell = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  const text = String(v);
  // A comma, a quote or a newline in a field has to be quoted, or the file
  // silently gains a column and every row after it is wrong.
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const SIGNAL_COLUMNS = [
  'Time (IST)', 'Timeframe', 'Signal', 'Side', 'Score', 'Status',
  'Trigger', 'Target', 'Stop', 'BTC at call', 'BTC after', 'Points',
  'Triggered At', 'First Hit', 'First Hit Price', 'First Hit Time',
  'MFE (pts)', 'MAE (pts)', 'MFE Price', 'MAE Price',
] as const;

export function signalsToCsv(rows: readonly StateHistoryRow[], words: (o: string | null) => string): string {
  const lines = [SIGNAL_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([
      IST_STAMP.format(r.at).replace(', ', ' '),
      r.tf,
      r.event,
      r.side ?? '',
      r.confidence,
      words(r.outcome ?? null),
      r.plan?.trigger ?? '',
      r.plan?.target1 ?? '',
      r.plan?.invalidation ?? '',
      Math.round(r.close),
      r.resolvedClose === null || r.resolvedClose === undefined ? '' : Math.round(r.resolvedClose),
      r.movePts === null || r.movePts === undefined ? '' : Math.round(r.movePts),
      r.triggeredAt ? IST_STAMP.format(r.triggeredAt).replace(', ', ' ') : '',
      r.firstHit ?? '',
      r.firstHitPrice === null || r.firstHitPrice === undefined ? '' : Math.round(r.firstHitPrice * 10) / 10,
      r.firstHitTime ? IST_STAMP.format(r.firstHitTime).replace(', ', ' ') : '',
      r.mfe === null || r.mfe === undefined ? '' : Math.round(r.mfe * 10) / 10,
      r.mae === null || r.mae === undefined ? '' : Math.round(r.mae * 10) / 10,
      r.mfePrice === null || r.mfePrice === undefined ? '' : Math.round(r.mfePrice * 10) / 10,
      r.maePrice === null || r.maePrice === undefined ? '' : Math.round(r.maePrice * 10) / 10,
    ].map(cell).join(','));
  }
  // A trailing newline: some tools drop the last row without one.
  return `${lines.join('\n')}\n`;
}

/** The file name carries the day and the timeframe, so downloads do not collide. */
export const csvNameFor = (tf: string, at = Date.now()): string =>
  `btc-signals-${tf}-${istDay(at)}.csv`;
