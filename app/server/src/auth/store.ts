import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AUTH_DB } from '../paths.js';
import { migrate, type Migration } from '../db/migrate.js';

/**
 * Everything the login keeps, in auth.db.
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
      CREATE TABLE IF NOT EXISTS auth_user (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        username             TEXT    NOT NULL,
        password_hash        TEXT    NOT NULL,
        password_changed_at  INTEGER NOT NULL,
        totp_secret          TEXT,
        totp_enabled_at      INTEGER,
        totp_last_step       INTEGER NOT NULL DEFAULT -1,
        totp_pending         TEXT,
        totp_pending_at      INTEGER,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash     TEXT PRIMARY KEY,
        stage          TEXT    NOT NULL CHECK (stage IN ('totp', 'setup', 'full')),
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL,
        ip             TEXT,
        user_agent     TEXT,
        attempts       INTEGER NOT NULL DEFAULT 0,
        revoked_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_live ON auth_sessions (expires_at) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS auth_recovery_codes (
        code_hash  TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        used_at    INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_limits (
        key          TEXT PRIMARY KEY,
        count        INTEGER NOT NULL,
        window_until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_events (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,
        kind   TEXT    NOT NULL,
        ip     TEXT,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS auth_events_by_time ON auth_events (at DESC);
    `,
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

export class AuthStore {
  private readonly db: DatabaseSync;
  readonly applied: string[];

  constructor(path = AUTH_DB) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.applied = migrate(this.db, MIGRATIONS);
  }

  close(): void { this.db.close(); }

  // ------------------------------------------------------------------ user

  user(): User | null {
    const r = this.db.prepare('SELECT * FROM auth_user WHERE id = 1').get() as Record<string, unknown> | undefined;
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
  seedUser(username: string, passwordHash: string, now: number): boolean {
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO auth_user (id, username, password_hash, password_changed_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(username, passwordHash, now, now, now);
    return Number(res.changes) > 0;
  }

  setPassword(passwordHash: string, now: number): void {
    this.db.prepare('UPDATE auth_user SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = 1')
      .run(passwordHash, now, now);
  }

  setPendingTotp(sealed: string | null, now: number): void {
    this.db.prepare('UPDATE auth_user SET totp_pending = ?, totp_pending_at = ?, updated_at = ? WHERE id = 1')
      .run(sealed, sealed ? now : null, now);
  }

  enableTotp(sealed: string, step: number, now: number): void {
    this.db.prepare(
      `UPDATE auth_user SET totp_secret = ?, totp_enabled_at = ?, totp_last_step = ?,
         totp_pending = NULL, totp_pending_at = NULL, updated_at = ? WHERE id = 1`,
    ).run(sealed, now, step, now);
  }

  /** Clears 2FA, for a lost phone. Only reachable from the server's command line. */
  resetTotp(now: number): void {
    this.db.prepare(
      `UPDATE auth_user SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = -1,
         totp_pending = NULL, totp_pending_at = NULL, updated_at = ? WHERE id = 1`,
    ).run(now);
    this.db.prepare('DELETE FROM auth_recovery_codes').run();
  }

  /**
   * Record a code's step as used -- only if it is later than the last one. The
   * condition is in the UPDATE, so two requests with the same code cannot both
   * succeed.
   */
  useTotpStep(step: number, now: number): boolean {
    const res = this.db.prepare('UPDATE auth_user SET totp_last_step = ?, updated_at = ? WHERE id = 1 AND totp_last_step < ?')
      .run(step, now, step);
    return Number(res.changes) > 0;
  }

  // -------------------------------------------------------------- sessions

  createSession(s: { token: string; stage: Stage; now: number; ttlMs: number; ip: string | null; userAgent: string | null }): void {
    this.db.prepare(
      `INSERT INTO auth_sessions (token_hash, stage, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(tokenHash(s.token), s.stage, s.now, s.now + s.ttlMs, s.now, s.ip, s.userAgent?.slice(0, 200) ?? null);
  }

  /** A live session for this token, or null: unknown, expired, or revoked all read the same. */
  session(token: string, now: number): SessionRow | null {
    const r = this.db.prepare(
      'SELECT * FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
    ).get(tokenHash(token), now) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      tokenHash: String(r.token_hash), stage: r.stage as Stage, createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at), lastSeenAt: Number(r.last_seen_at),
      ip: (r.ip as string | null) ?? null, userAgent: (r.user_agent as string | null) ?? null, attempts: Number(r.attempts),
    };
  }

  /** Last seen, written at most once a minute: the desk polls every second. */
  touch(hash: string, now: number): void {
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?')
      .run(now, hash, now - 60_000);
  }

  bumpAttempts(hash: string): number {
    this.db.prepare('UPDATE auth_sessions SET attempts = attempts + 1 WHERE token_hash = ?').run(hash);
    const r = this.db.prepare('SELECT attempts FROM auth_sessions WHERE token_hash = ?').get(hash) as { attempts: number } | undefined;
    return r?.attempts ?? 0;
  }

  revoke(hash: string, now: number): void {
    this.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now, hash);
  }

  /** Every live session but one (or all, with no exception). Returns how many ended. */
  revokeAll(now: number, except?: string): number {
    const res = except
      ? this.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND token_hash <> ?').run(now, except)
      : this.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(now);
    return Number(res.changes);
  }

  liveSessions(now: number): SessionRow[] {
    return (this.db.prepare(
      `SELECT * FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? AND stage = 'full' ORDER BY last_seen_at DESC`,
    ).all(now) as Record<string, unknown>[]).map((r) => ({
      tokenHash: String(r.token_hash), stage: r.stage as Stage, createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at), lastSeenAt: Number(r.last_seen_at),
      ip: (r.ip as string | null) ?? null, userAgent: (r.user_agent as string | null) ?? null, attempts: Number(r.attempts),
    }));
  }

  /** Old rows go: ended sessions after a week, security events after 180 days. */
  prune(now: number): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE (revoked_at IS NOT NULL OR expires_at < ?) AND created_at < ?')
      .run(now, now - 7 * 86_400_000);
    this.db.prepare('DELETE FROM auth_limits WHERE window_until < ?').run(now);
    this.db.prepare('DELETE FROM auth_events WHERE at < ?').run(now - 180 * 86_400_000);
  }

  // -------------------------------------------------------- recovery codes

  replaceRecoveryCodes(hashes: string[], now: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM auth_recovery_codes').run();
      const ins = this.db.prepare('INSERT INTO auth_recovery_codes (code_hash, created_at) VALUES (?, ?)');
      for (const h of hashes) ins.run(h, now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Spend a recovery code. True once per code, ever. */
  useRecoveryCode(hash: string, now: number): boolean {
    const res = this.db.prepare('UPDATE auth_recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(now, hash);
    return Number(res.changes) > 0;
  }

  recoveryCodesLeft(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE used_at IS NULL').get() as { n: number }).n);
  }

  // ---------------------------------------------------------- rate limits

  /** Failures under this key in its current window. */
  failures(key: string, now: number): number {
    const r = this.db.prepare('SELECT count, window_until FROM auth_limits WHERE key = ?').get(key) as
      { count: number; window_until: number } | undefined;
    return r && r.window_until > now ? r.count : 0;
  }

  /** One more failure; a window that has run out starts again. */
  fail(key: string, now: number, windowMs: number): number {
    this.db.prepare(
      `INSERT INTO auth_limits (key, count, window_until) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_until > ? THEN count + 1 ELSE 1 END,
         window_until = CASE WHEN window_until > ? THEN window_until ELSE ? END`,
    ).run(key, now + windowMs, now, now, now + windowMs);
    return this.failures(key, now);
  }

  /** When the window under this key runs out. */
  windowUntil(key: string): number {
    const r = this.db.prepare('SELECT window_until FROM auth_limits WHERE key = ?').get(key) as { window_until: number } | undefined;
    return r?.window_until ?? 0;
  }

  clear(key: string): void {
    this.db.prepare('DELETE FROM auth_limits WHERE key = ?').run(key);
  }

  // --------------------------------------------------------------- events

  event(kind: string, now: number, ip: string | null, detail: string | null = null): void {
    this.db.prepare('INSERT INTO auth_events (at, kind, ip, detail) VALUES (?, ?, ?, ?)').run(now, kind, ip, detail?.slice(0, 300) ?? null);
  }

  events(limit = 30): AuthEvent[] {
    return (this.db.prepare('SELECT * FROM auth_events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map((r) => ({ id: Number(r.id), at: Number(r.at), kind: String(r.kind), ip: (r.ip as string | null) ?? null, detail: (r.detail as string | null) ?? null }));
  }
}
