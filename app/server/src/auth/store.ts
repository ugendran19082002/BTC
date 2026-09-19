import { createHash } from 'node:crypto';
import { migrate, moveToPublic, type Migration } from '../db/migrate.js';
import { one, query, rows, tx } from '../db/pool.js';

/**
 * Everything the login keeps, in the `auth` schema.
 *
 * One desk, one user: `auth_user` holds a single row. Sessions are rows too --
 * only the SHA-256 of each token is stored, so the table cannot be replayed if
 * it leaks -- which is what makes logging out, changing the password, and
 * "log out other devices" actually end a session instead of waiting for a
 * signed cookie to expire.
 */

const MIGRATIONS: Migration[] = [
  {
    id: 'auth-001-user-sessions',
    up: `
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.user (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        username             TEXT    NOT NULL,
        password_hash        TEXT    NOT NULL,
        password_changed_at  BIGINT  NOT NULL,
        totp_secret          TEXT,
        totp_enabled_at      BIGINT,
        totp_last_step       BIGINT  NOT NULL DEFAULT -1,
        totp_pending         TEXT,
        totp_pending_at      BIGINT,
        created_at           BIGINT  NOT NULL,
        updated_at           BIGINT  NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth.sessions (
        token_hash     TEXT    PRIMARY KEY,
        stage          TEXT    NOT NULL CHECK (stage IN ('totp', 'setup', 'full')),
        created_at     BIGINT  NOT NULL,
        expires_at     BIGINT  NOT NULL,
        last_seen_at   BIGINT  NOT NULL,
        ip             TEXT,
        user_agent     TEXT,
        attempts       INTEGER NOT NULL DEFAULT 0,
        revoked_at     BIGINT
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_live ON auth.sessions (expires_at) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS auth.recovery_codes (
        code_hash  TEXT   PRIMARY KEY,
        created_at BIGINT NOT NULL,
        used_at    BIGINT
      );
      CREATE TABLE IF NOT EXISTS auth.limits (
        key          TEXT    PRIMARY KEY,
        count        INTEGER NOT NULL,
        window_until BIGINT  NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth.events (
        id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        at     BIGINT NOT NULL,
        kind   TEXT   NOT NULL,
        ip     TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS auth_events_by_time ON auth.events (at DESC);
    `,
  },  {
    /*
     * Every table in one schema, public, on the owner's request (19 Sep 2026):
     * one list in a console instead of seven. Names carry their area as a
     * prefix where a bare name would be ambiguous in one namespace.
     */
    id: 'auth-002-to-public',
    up: moveToPublic([
      ['auth.user', 'auth_user'],
      ['auth.sessions', 'auth_sessions'],
      ['auth.recovery_codes', 'auth_recovery_codes'],
      ['auth.limits', 'auth_limits'],
      ['auth.events', 'auth_events'],
    ], ['auth']),
  },
];

export type Stage = 'totp' | 'setup' | 'full';

export type User = {
  username: string;
  passwordHash: string;
  passwordChangedAt: number;
  totpSecret: string | null;
  totpEnabledAt: number | null;
  totpLastStep: number;
  totpPending: string | null;
  totpPendingAt: number | null;
};

export type SessionRow = {
  tokenHash: string;
  stage: Stage;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  attempts: number;
};

export type AuthEvent = { id: number; at: number; kind: string; ip: string | null; detail: string | null };

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

const sessionOf = (r: Record<string, unknown>): SessionRow => ({
  tokenHash: String(r.token_hash), stage: r.stage as Stage, createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at), lastSeenAt: Number(r.last_seen_at),
  ip: (r.ip as string | null) ?? null, userAgent: (r.user_agent as string | null) ?? null, attempts: Number(r.attempts),
});

export class AuthStore {
  /** Ids applied when the store was opened. For the health endpoint. */
  applied: string[] = [];

  /** The store, migrated. Everything else assumes this has been awaited once. */
  static async open(): Promise<AuthStore> {
    const store = new AuthStore();
    store.applied = await migrate(MIGRATIONS);
    return store;
  }

  // ------------------------------------------------------------------ user

  async user(): Promise<User | null> {
    const r = await one<Record<string, unknown>>('SELECT * FROM auth_user WHERE id = 1');
    if (!r) return null;
    return {
      username: String(r.username),
      passwordHash: String(r.password_hash),
      passwordChangedAt: Number(r.password_changed_at),
      totpSecret: (r.totp_secret as string | null) ?? null,
      totpEnabledAt: (r.totp_enabled_at as number | null) ?? null,
      totpLastStep: Number(r.totp_last_step),
      totpPending: (r.totp_pending as string | null) ?? null,
      totpPendingAt: (r.totp_pending_at as number | null) ?? null,
    };
  }

  /** The first user, from the environment. Does nothing once one exists. */
  async seedUser(username: string, passwordHash: string, now: number): Promise<boolean> {
    const res = await query(
      `INSERT INTO auth_user (id, username, password_hash, password_changed_at, created_at, updated_at)
       VALUES (1, $1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [username, passwordHash, now, now, now],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setPassword(passwordHash: string, now: number): Promise<void> {
    await query('UPDATE auth_user SET password_hash = $1, password_changed_at = $2, updated_at = $3 WHERE id = 1', [passwordHash, now, now]);
  }

  async setPendingTotp(sealed: string | null, now: number): Promise<void> {
    await query('UPDATE auth_user SET totp_pending = $1, totp_pending_at = $2, updated_at = $3 WHERE id = 1', [sealed, sealed ? now : null, now]);
  }

  async enableTotp(sealed: string, step: number, now: number): Promise<void> {
    await query(
      `UPDATE auth_user SET totp_secret = $1, totp_enabled_at = $2, totp_last_step = $3,
         totp_pending = NULL, totp_pending_at = NULL, updated_at = $4 WHERE id = 1`,
      [sealed, now, step, now],
    );
  }

  /** Clears 2FA, for a lost phone. Only reachable from the server's command line. */
  async resetTotp(now: number): Promise<void> {
    await tx(async (c) => {
      await c.query(
        `UPDATE auth_user SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = -1,
           totp_pending = NULL, totp_pending_at = NULL, updated_at = $1 WHERE id = 1`,
        [now],
      );
      await c.query('DELETE FROM auth_recovery_codes');
    });
  }

  /**
   * Record a code's step as used -- only if it is later than the last one. The
   * condition is in the UPDATE, so two requests with the same code cannot both
   * succeed.
   */
  async useTotpStep(step: number, now: number): Promise<boolean> {
    const res = await query('UPDATE auth_user SET totp_last_step = $1, updated_at = $2 WHERE id = 1 AND totp_last_step < $1', [step, now]);
    return (res.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------- sessions

  async createSession(s: { token: string; stage: Stage; now: number; ttlMs: number; ip: string | null; userAgent: string | null }): Promise<void> {
    await query(
      `INSERT INTO auth_sessions (token_hash, stage, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tokenHash(s.token), s.stage, s.now, s.now + s.ttlMs, s.now, s.ip, s.userAgent?.slice(0, 200) ?? null],
    );
  }

  /** A live session for this token, or null: unknown, expired, or revoked all read the same. */
  async session(token: string, now: number): Promise<SessionRow | null> {
    const r = await one<Record<string, unknown>>(
      'SELECT * FROM auth_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2',
      [tokenHash(token), now],
    );
    return r ? sessionOf(r) : null;
  }

  /** Last seen, written at most once a minute: the desk polls every second. */
  async touch(hash: string, now: number): Promise<void> {
    await query('UPDATE auth_sessions SET last_seen_at = $1 WHERE token_hash = $2 AND last_seen_at < $3', [now, hash, now - 60_000]);
  }

  async bumpAttempts(hash: string): Promise<number> {
    const r = await one<{ attempts: number }>(
      'UPDATE auth_sessions SET attempts = attempts + 1 WHERE token_hash = $1 RETURNING attempts',
      [hash],
    );
    return r?.attempts ?? 0;
  }

  async revoke(hash: string, now: number): Promise<void> {
    await query('UPDATE auth_sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL', [now, hash]);
  }

  /** Every live session but one (or all, with no exception). Returns how many ended. */
  async revokeAll(now: number, except?: string): Promise<number> {
    const res = except
      ? await query('UPDATE auth_sessions SET revoked_at = $1 WHERE revoked_at IS NULL AND token_hash <> $2', [now, except])
      : await query('UPDATE auth_sessions SET revoked_at = $1 WHERE revoked_at IS NULL', [now]);
    return res.rowCount ?? 0;
  }

  async liveSessions(now: number): Promise<SessionRow[]> {
    return (await rows<Record<string, unknown>>(
      `SELECT * FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > $1 AND stage = 'full' ORDER BY last_seen_at DESC`,
      [now],
    )).map(sessionOf);
  }

  /**
   * Old rows go: a session a week after it ENDED (expired or revoked), security
   * events after 180 days. Counted from the ending, not from sign-in -- a
   * week-long session counted from sign-in would be deleted the moment it
   * expired, and the row is kept a while so a "which devices were signed in"
   * question can still be answered after the fact.
   */
  async prune(now: number): Promise<void> {
    const weekAgo = now - 7 * 86_400_000;
    await query('DELETE FROM auth_sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)', [weekAgo]);
    await query('DELETE FROM auth_limits WHERE window_until < $1', [now]);
    await query('DELETE FROM auth_events WHERE at < $1', [now - 180 * 86_400_000]);
  }

  // -------------------------------------------------------- recovery codes

  async replaceRecoveryCodes(hashes: string[], now: number): Promise<void> {
    await tx(async (c) => {
      await c.query('DELETE FROM auth_recovery_codes');
      for (const h of hashes) await c.query('INSERT INTO auth_recovery_codes (code_hash, created_at) VALUES ($1, $2)', [h, now]);
    });
  }

  /** Spend a recovery code. True once per code, ever. */
  async useRecoveryCode(hash: string, now: number): Promise<boolean> {
    const res = await query('UPDATE auth_recovery_codes SET used_at = $1 WHERE code_hash = $2 AND used_at IS NULL', [now, hash]);
    return (res.rowCount ?? 0) > 0;
  }

  async recoveryCodesLeft(): Promise<number> {
    return (await one<{ n: number }>('SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE used_at IS NULL'))?.n ?? 0;
  }

  // ---------------------------------------------------------- rate limits

  /** Failures under this key in its current window. */
  async failures(key: string, now: number): Promise<number> {
    const r = await one<{ count: number; window_until: number }>('SELECT count, window_until FROM auth_limits WHERE key = $1', [key]);
    return r && r.window_until > now ? r.count : 0;
  }

  /** One more failure; a window that has run out starts again. */
  async fail(key: string, now: number, windowMs: number): Promise<number> {
    await query(
      `INSERT INTO auth_limits (key, count, window_until) VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN auth_limits.window_until > $3 THEN auth_limits.count + 1 ELSE 1 END,
         window_until = CASE WHEN auth_limits.window_until > $3 THEN auth_limits.window_until ELSE $2 END`,
      [key, now + windowMs, now],
    );
    return this.failures(key, now);
  }

  /** When the window under this key runs out. */
  async windowUntil(key: string): Promise<number> {
    return (await one<{ window_until: number }>('SELECT window_until FROM auth_limits WHERE key = $1', [key]))?.window_until ?? 0;
  }

  async clear(key: string): Promise<void> {
    await query('DELETE FROM auth_limits WHERE key = $1', [key]);
  }

  // --------------------------------------------------------------- events

  async event(kind: string, now: number, ip: string | null, detail: string | null = null): Promise<void> {
    await query('INSERT INTO auth_events (at, kind, ip, detail) VALUES ($1, $2, $3, $4)', [now, kind, ip, detail?.slice(0, 300) ?? null]);
  }

  async events(limit = 30): Promise<AuthEvent[]> {
    return (await rows<Record<string, unknown>>('SELECT * FROM auth_events ORDER BY at DESC, id DESC LIMIT $1', [limit]))
      .map((r) => ({ id: Number(r.id), at: Number(r.at), kind: String(r.kind), ip: (r.ip as string | null) ?? null, detail: (r.detail as string | null) ?? null }));
  }
}
