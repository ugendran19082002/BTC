import { json } from '@/api/client';
import type { DaysReport, MtmReport } from '@/types/report';

/** The record as a calendar, and a day as a line. Read-only. */
export const getDays = (from: string, to: string) =>
  json<DaysReport>(`/api/report/days?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

export const getMtm = (day: string | null) =>
  json<MtmReport>(day ? `/api/report/mtm?day=${encodeURIComponent(day)}` : '/api/report/mtm');

/** Where the spreadsheet is. A link, so the browser saves it with its own name. */
export const daysCsvUrl = (from: string, to: string) =>
  `/api/report/days.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
