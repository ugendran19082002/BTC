import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time codes (RFC 6238), the kind Google Authenticator shows.
 *
 * Written here rather than pulled in: it is forty lines of HMAC, and a login
 * dependency is one more thing whose updates have to be trusted. The RFC's own
 * test vectors pin it in test/auth/totp.test.ts.
 *
 * SHA-1, 30-second steps, 6 digits: the only combination every authenticator
 * app reads from a QR code without asking. One step either side is accepted, for
 * a phone clock a little off -- and each accepted step is remembered by the
 * caller, so a code that worked once never works again.
 */

export const STEP_SECONDS = 30;
export const DIGITS = 6;
/** Steps either side of now that still count. */
export const WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret: 20 random bytes, the size RFC 4226 recommends for SHA-1. */
export const newSecret = (): string => base32Encode(randomBytes(20));

/** The code for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SECONDS);

export const totp = (secretB32: string, nowMs: number, digits = DIGITS): string =>
  hotp(base32Decode(secretB32), stepAt(nowMs), digits);

/**
 * The step a code belongs to, or null.
 *
 * `after` is the last step already used: a code for that step or an earlier one
 * is refused even when it is right, which is what stops a code seen over a
 * shoulder, or sent twice, from being used again.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, after = -1): number | null {
  const want = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(want)) return null;
  const secret = base32Decode(secretB32);
  const now = stepAt(nowMs);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d;
    if (step <= after) continue;
    const got = Buffer.from(hotp(secret, step));
    if (got.length === want.length && timingSafeEqual(got, Buffer.from(want))) return step;
  }
  return null;
}

/** What the QR code holds: the standard otpauth URI every authenticator app reads. */
export function otpauthUrl(o: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${o.issuer}:${o.account}`);
  const q = new URLSearchParams({ secret: o.secret, issuer: o.issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
