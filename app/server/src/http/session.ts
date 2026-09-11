import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password login for a desk that sits on the open internet.
 *
 * The password itself is never stored, sent back, or written to a log — only a
 * scrypt hash of it, in auth.db (seeded once from the environment). Sessions
 * and the two-step sign-in live in src/auth/; this file keeps the hashing and
 * the cookie, which both halves share.
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

/** `__Host-`: the browser refuses it unless Secure, Path=/ and no Domain -- so no subdomain can set or overwrite it. */
export const COOKIE = '__Host-desk_session';

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

/** The session cookie: HttpOnly, Secure, SameSite=Strict, and gone when the session is. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}
