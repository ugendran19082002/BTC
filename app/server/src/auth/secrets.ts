import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Keeping the authenticator secret, and the recovery codes, out of plain sight.
 *
 * The TOTP secret has to be readable again -- it is needed for every check -- so
 * it cannot be hashed like a password. It is encrypted with AES-256-GCM under a
 * key derived from DESK_SESSION_SECRET, which lives in the environment and never
 * in the database. A copy of auth.db on its own opens nothing.
 *
 * Recovery codes only ever need comparing, so they are HMACed under a second
 * derived key, not stored.
 *
 * Rotating DESK_SESSION_SECRET therefore makes the stored secret unreadable:
 * 2FA has to be set up again (see `npm run auth -- reset-2fa`). That is the
 * right way round -- a leaked secret should cut everything off.
 */

const derive = (master: string, label: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(master), Buffer.alloc(0), Buffer.from(label), 32));

export class Secrets {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(master: string) {
    if (!master || master.length < 16) throw new Error('DESK_SESSION_SECRET must be at least 16 characters');
    this.encKey = derive(master, 'btc-desk/totp-secret/v1');
    this.macKey = derive(master, 'btc-desk/recovery-code/v1');
  }

  /** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.encKey, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  }

  /** Throws when the value was altered or sealed under another key. */
  open(sealed: string): string {
    const [v, iv, tag, body] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('unreadable secret');
    const d = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  }

  /** A recovery code, as stored: case and dashes do not matter. */
  codeHash(code: string): string {
    return createHmac('sha256', this.macKey).update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
  }
}

/** Ten codes like `K7PQ-M2XD`: 40 bits each, typed once, then gone. */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const chars = [...b].map((x) => alphabet[x % alphabet.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}
