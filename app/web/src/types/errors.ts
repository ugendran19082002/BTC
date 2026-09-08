/** Mirrors app/server/src/observability/errors.ts */

export type ErrorSource = 'server' | 'browser' | 'exchange' | 'trading';
export type ErrorLevel = 'error' | 'warn';

export type ErrorRow = {
  id: number;
  source: ErrorSource;
  level: ErrorLevel;
  message: string;
  code: string | null;
  stack: string | null;
  where: string | null;
  context: Record<string, unknown> | null;
  firstSeen: number;
  lastSeen: number;
  /** How many identical failures folded into this row. */
  count: number;
  resolved: boolean;
};

export type ErrorSummary = {
  total: number;
  unresolved: number;
  bySource: Partial<Record<ErrorSource, number>>;
};

export type ErrorList = { errors: ErrorRow[]; summary: ErrorSummary };
