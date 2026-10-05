import { json } from '@/api/client';
import type { DaysReport, MtmReport } from '@/types/report';
import { withAccount } from '@/lib/account-scope';

/**
 * The P&L screen's calls: the record as a calendar, one day's mark-to-market
 * line, and the spreadsheet download. Each asks for the broker account being
 * shown (lib/account-scope.ts); with none chosen, every account's.
 */

/** The record as a calendar, and a day as a line. Read-only. */
export const getDays = (from: string, to: string) =>
  json<DaysReport>(withAccount(`/api/report/days?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));

export const getMtm = (day: string | null) =>
  json<MtmReport>(withAccount(day ? `/api/report/mtm?day=${encodeURIComponent(day)}` : '/api/report/mtm'));

/** Where the spreadsheet is. A link, so the browser saves it with its own name. */
export const daysCsvUrl = (from: string, to: string) =>
  withAccount(`/api/report/days.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
