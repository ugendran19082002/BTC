import { migrate, moveToPublic, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';

/**
 * Every failure this system has, in one table.
 *
 * A trading desk fails in three places and they are normally three separate
 * investigations: a route throwing on the server, a component throwing in the
 * browser, and the exchange refusing something in between. Splitting them
 * across a container log, a browser console nobody has open, and a swallowed
 * `.catch(() => null)` is how a bug survives for a week.
 *
 * So they all land here, with the same shape, in time order. The row is written
 * to be read by whoever has to fix it: what happened, where, what was being
 * attempted at the time, and the stack.
 *
 * Two rules keep it useful rather than noisy:
 *   - identical failures are folded into one row with a count, so a poll that
 *     fails every second does not bury everything else;
 *   - nothing here is allowed to throw. A logger that can fail takes the thing
 *     it was logging down with it.
 *
 * The table lives in the `errors` schema of the desk's database. Writes are
 * queued and run one after another in the background: `record()` returns at
 * once, as it always did, and the caller -- an error handler, more often than
 * not -- is never made to wait on the database or to see it fail. `flush()`
 * waits for the queue, for tests and for a process shutting down.
 */

export type ErrorSource = 'server' | 'browser' | 'exchange' | 'trading';
export type ErrorLevel = 'error' | 'warn';

export type ErrorReport = {
  source: ErrorSource;
  level?: ErrorLevel;
  /** One line, the thing that went wrong. */
  message: string;
  /** A machine-readable code when there is one: an HTTP status, a Delta code. */
  code?: string | null;
  stack?: string | null;
  /** Where it happened: a route, a component, a symbol. */
  where?: string | null;
  /** Anything that helps reproduce it. Kept small and never secret. */
  context?: Record<string, unknown> | null;
};

export type ErrorRow = ErrorReport & {
  id: number;
  firstSeen: number;
  lastSeen: number;
  /** How many identical failures folded into this row. */
  count: number;
  resolved: boolean;
};

const MIGRATIONS: Migration[] = [
  {
    id: 'errors-001-log',
    up: `
      CREATE SCHEMA IF NOT EXISTS errors;
      CREATE TABLE IF NOT EXISTS errors.log (
        id          BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        fingerprint TEXT    NOT NULL UNIQUE,
        source      TEXT    NOT NULL,
        level       TEXT    NOT NULL,
        message     TEXT    NOT NULL,
        code        TEXT,
        stack       TEXT,
        where_at    TEXT,
        context     JSONB,
        first_seen  BIGINT  NOT NULL,
        last_seen   BIGINT  NOT NULL,
        count       INTEGER NOT NULL DEFAULT 1,
        resolved    BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS errors_log_by_time   ON errors.log (last_seen DESC);
      CREATE INDEX IF NOT EXISTS errors_log_by_source ON errors.log (source, last_seen DESC);
    `,
  },  {
    /*
     * Every table in one schema, public, on the owner's request (19 Sep 2026):
     * one list in a console instead of seven. Names carry their area as a
     * prefix where a bare name would be ambiguous in one namespace.
     */
    id: 'errors-002-to-public',
    up: moveToPublic([['errors.log', 'errors']], ['errors']),
  },
];

/** Keep the table from growing without bound on a long-running desk. */
const MAX_ROWS = 2_000;
const MAX_FIELD = 4_000;

const trim = (s: string | null | undefined, n = MAX_FIELD) =>
  s == null ? null : s.length > n ? `${s.slice(0, n)}\n… truncated` : s;

/**
 * What makes two failures "the same".
 *
 * Deliberately not the stack: the same bug reached from two call sites is still
 * the same bug, and folding on the message keeps the list short enough to read.
 *
 * The parts are joined with the ASCII unit separator, which no message contains.
 * It used to be NUL, which SQLite stored and PostgreSQL's TEXT refuses.
 */
const FP_SEP = '\u001f';
export const fingerprintOf = (r: ErrorReport) =>
  [r.source, r.code ?? '', r.where ?? '', r.message].join(FP_SEP).slice(0, 512);

/**
 * Anything that looks like a credential never reaches the table.
 *
 * Error contexts are the classic place a key leaks: a failed request gets
 * logged with its own headers attached, and now the secret is in a database
 * that is easier to read than the environment it came from.
 */
const SECRET_KEY = /(api[-_]?key|secret|signature|password|token|cookie|authorization)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export class ErrorLog {
  /** Resolves once the schema is in place. Every write waits on it. */
  readonly ready: Promise<void>;
  /** Writes, one after another, so two reports of the same failure fold in the order they happened. */
  private queue: Promise<void>;
  private writes = 0;

  constructor() {
    this.ready = migrate(MIGRATIONS).then(() => {});
    this.queue = this.ready.catch(() => {});
  }

  /** Never throws, and never waits. A logger that can fail is worse than no logger. */
  record(report: ErrorReport, now = Date.now()): void {
    let fp: string;
    let context: string | null;
    try {
      fp = fingerprintOf(report);
      context = report.context ? JSON.stringify(redact(report.context)) : null;
    } catch {
      // A circular context, or a report with nothing usable in it. Nowhere left
      // to report a reporting failure; drop it.
      return;
    }
    const params = [
      fp,
      report.source,
      report.level ?? 'error',
      trim(report.message, 500) || 'unknown error',
      report.code ?? null,
      trim(report.stack),
      trim(report.where, 200),
      trim(context),
      now,
      now,
    ];
    this.queue = this.queue
      .then(async () => {
        await query(
          `INSERT INTO errors
             (fingerprint, source, level, message, code, stack, where_at, context, first_seen, last_seen, count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 1)
           ON CONFLICT (fingerprint) DO UPDATE SET
             last_seen = EXCLUDED.last_seen,
             count     = errors.count + 1,
             -- the newest stack is the most likely to still be reachable
             stack     = COALESCE(EXCLUDED.stack, errors.stack),
             context   = COALESCE(EXCLUDED.context, errors.context),
             resolved  = FALSE`,
          params,
        );
        // Every so often, not every time: the cap is a ceiling, not a target.
        if (++this.writes % 50 === 0) await this.prune();
      })
      .catch(() => {
        // Deliberately silent: there is nowhere left to report a reporting failure.
      });
  }

  /** Wait for every record() so far to be in the database. */
  flush(): Promise<void> { return this.queue; }

  async list(opts: { limit?: number; source?: ErrorSource; includeResolved?: boolean } = {}): Promise<ErrorRow[]> {
    const { limit = 100, source, includeResolved = false } = opts;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (source) { params.push(source); where.push(`source = $${params.length}`); }
    if (!includeResolved) where.push('resolved = FALSE');
    params.push(limit);
    const sql =
      `SELECT * FROM errors ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ` +
      `ORDER BY last_seen DESC LIMIT $${params.length}`;
    return (await rows<Record<string, unknown>>(sql, params)).map(toRow);
  }

  /** Counts for the badge, so the UI does not have to fetch the list to know. */
  async summary(): Promise<{ total: number; unresolved: number; bySource: Record<string, number> }> {
    const counts = await one<{ total: number; unresolved: number }>(
      'SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE NOT resolved) AS unresolved FROM errors',
    );
    const by = await rows<{ source: string; n: number }>(
      'SELECT source, COUNT(*) AS n FROM errors WHERE NOT resolved GROUP BY source',
    );
    return {
      total: counts?.total ?? 0,
      unresolved: counts?.unresolved ?? 0,
      bySource: Object.fromEntries(by.map((r) => [r.source, r.n])),
    };
  }

  /** Gone for good. "Mark read" hides; this removes. */
  async remove(id: number): Promise<void> {
    await query('DELETE FROM errors WHERE id = $1', [id]);
  }

  async resolve(id: number): Promise<void> {
    await query('UPDATE errors SET resolved = TRUE WHERE id = $1', [id]);
  }

  async resolveAll(): Promise<number> {
    const r = await query('UPDATE errors SET resolved = TRUE WHERE NOT resolved');
    return r.rowCount ?? 0;
  }

  async clear(): Promise<void> {
    await this.flush();
    await query('DELETE FROM errors');
  }

  private async prune(): Promise<void> {
    // Keep the newest MAX_ROWS, unresolved ones first; whatever falls past
    // that -- the oldest resolved rows -- goes. An unresolved failure is never
    // dropped to make room for a newer one.
    await query(
      `DELETE FROM errors WHERE id IN (
         SELECT id FROM errors
         ORDER BY resolved ASC, last_seen DESC
         OFFSET $1
       )`,
      [MAX_ROWS],
    );
  }
}

function toRow(r: Record<string, unknown>): ErrorRow {
  return {
    id: r.id as number,
    source: r.source as ErrorSource,
    level: r.level as ErrorLevel,
    message: r.message as string,
    code: (r.code as string) ?? null,
    stack: (r.stack as string) ?? null,
    where: (r.where_at as string) ?? null,
    context: (r.context as Record<string, unknown> | null) ?? null,
    firstSeen: r.first_seen as number,
    lastSeen: r.last_seen as number,
    count: r.count as number,
    resolved: r.resolved as boolean,
  };
}

let singleton: ErrorLog | null = null;
export const errorLog = (): ErrorLog => (singleton ??= new ErrorLog());

/** Shorthand for the places that just want to note a failure and move on. */
export const noteError = (report: ErrorReport): void => errorLog().record(report);
