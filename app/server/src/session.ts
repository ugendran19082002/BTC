import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password login for a desk that sits on the open internet.
 *
 * The password itself is never stored, sent back, or written to a log — only a
 * scrypt hash of it, in the environment. Sessions are a signed token in an
 * httpOnly cookie rather than anything held in memory, so a restart does not
 * log you out and there is no session table to leak.
 *
 * Deliberately small. A desk with one user does not need accounts, roles or a
 * password reset flow, and every one of those is another thing to get wrong.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/**
 * `scrypt:<salt hex>:<hash hex>` — self-describing, so the format can change.
 *
 * Colons rather than the conventional dollar signs, because this value lives in
 * an env file that Docker Compose runs variable interpolation over: a `$` there
 * makes the rest of the segment look like `${salt}` and it is silently replaced
 * with nothing. The hash arrived in the container 33 characters shorter than it
 * left, and every login failed with a correct password.
 */
export function hashPassword(password: string, salt = randomBytes(16)): string {
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  // accept the old dollar form too, so an existing deployment keeps working
  const [scheme, saltHex, keyHex] = stored.split(stored.includes(':') ? ':' : '$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  // constant time: a length mismatch must not answer faster than a value one
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type AuthConfig = {
  enabled: boolean;
  username: string;
  passwordHash: string;
  secret: string;
  /** how long a login lasts, in seconds */
  ttl: number;
};

export function authFromEnv(): AuthConfig {
  const username = process.env.DESK_USER?.trim() ?? '';
  const passwordHash = process.env.DESK_PASSWORD_HASH?.trim() ?? '';
  const secret = process.env.DESK_SESSION_SECRET?.trim() ?? '';
  return {
    // all three or none: a half-configured login is worse than no login,
    // because it looks protected
    enabled: Boolean(username && passwordHash && secret),
    username,
    passwordHash,
    secret,
    ttl: Number(process.env.DESK_SESSION_HOURS ?? 24) * 3600,
  };
}

export const COOKIE = 'desk_session';

/** `<expiry>.<signature>` — no secrets inside, nothing to decode. */
export function issueToken(cfg: AuthConfig, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + cfg.ttl;
  const sig = createHmac('sha256', cfg.secret).update(String(expires)).digest('hex');
  return `${expires}.${sig}`;
}

export function tokenValid(cfg: AuthConfig, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [expiresRaw, sig] = token.split('.');
  if (!expiresRaw || !sig) return false;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires * 1000 < now) return false;
  const want = createHmac('sha256', cfg.secret).update(expiresRaw).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Slow down guessing without keeping a table of everyone who ever tried.
 *
 * One counter per address, cleared on success and forgotten after the window.
 * Enough to make an online guessing run useless; not a replacement for a
 * password worth having.
 */
export class LoginLimiter {
  private hits = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly max = 8,
    private readonly windowMs = 10 * 60_000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    const e = this.hits.get(key);
    if (!e) return false;
    if (e.until < now) {
      this.hits.delete(key);
      return false;
    }
    return e.count >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    const e = this.hits.get(key);
    if (!e || e.until < now) this.hits.set(key, { count: 1, until: now + this.windowMs });
    else e.count += 1;
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }
}
