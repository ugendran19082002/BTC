import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { hashPassword, verifyPassword } from '../http/session.js';
import { passwordProblems } from './password.js';
import { Secrets, newRecoveryCodes } from './secrets.js';
import { AuthStore, tokenHash, type SessionRow, type Stage, type User } from './store.js';
import { newSecret, otpauthUrl, verifyTotp } from './totp.js';

/**
 * Signing in: a password, then a code from the authenticator app. Both, every time.
 *
 *   password ✓ ──► 2FA on?  yes ──► "Enter the 6-digit code" ──► code ✓ ──► desk
 *                           no  ──► Security setup: QR ──► code ✓ ──► recovery codes ──► desk
 *
 * Each step is its own short-lived session with a stage, and only a `full`
 * session opens the desk. A password on its own opens nothing but the code
 * step (5 minutes) or the setup step (15 minutes). Passing a step issues a new
 * token rather than upgrading the old one, so a token seen before the code was
 * entered is worthless after it.
 *
 * A signed-in session lasts a week from sign-in, then asks again. A week, not a
 * day: the desk is one person's, on their own phone, behind a password AND an
 * authenticator code, and a sign-in every morning taught nobody anything except
 * to keep the code app open. What a session length is really for -- a lost
 * phone -- is covered better by the account page, where every device is listed
 * and can be signed out. Logging out ends it on the server, changing the
 * password ends every other one.
 *
 * Rate limits are on sign-in only -- the trading API is untouched. They count
 * per address AND per account, because the address can be faked through
 * X-Forwarded-For when the proxy chain lets it through, and the account cannot.
 */

export const SESSION_DAYS = 7;
export const SESSION_MS = SESSION_DAYS * 24 * 60 * 60_000;
export const CODE_STAGE_MS = 5 * 60_000;
export const SETUP_STAGE_MS = 15 * 60_000;

export const LIMITS = {
  /** Wrong passwords from one address. */
  passwordPerAddress: { max: 8, windowMs: 10 * 60_000 },
  /** Wrong passwords for the account, from anywhere. */
  passwordPerAccount: { max: 20, windowMs: 15 * 60_000 },
  /** Wrong codes for the account, from anywhere. A 6-digit code must not be guessable in bulk. */
  codePerAccount: { max: 10, windowMs: 15 * 60_000 },
  /** Wrong codes on one sign-in before the password has to be entered again. */
  codePerSignIn: 5,
} as const;

const KEY = {
  passwordAddress: (ip: string) => `password:address:${ip}`,
  passwordAccount: 'password:account',
  codeAccount: 'code:account',
};

/** A real hash to check against when there is no user, so a missing user answers as slowly as a wrong password. */
const DUMMY_HASH = hashPassword('not-a-real-password-just-for-timing');

export type Ctx = { ip: string | null; userAgent: string | null };
export type Failure = { ok: false; status: 400 | 401 | 403 | 409 | 429 | 503; error: string; problems?: string[]; restart?: boolean };
export type Issued = { token: string; stage: Stage; expiresAt: number };

export type AuthDeps = {
  store: AuthStore;
  /** Null when DESK_SESSION_SECRET is missing: nothing can be sealed, so nobody can sign in. */
  secrets: Secrets | null;
  now: () => number;
  issuer?: string;
  /** A security event somebody should hear about. Must not throw. */
  onAlert?: (text: string) => void;
};

export class AuthService {
  private readonly issuer: string;

  constructor(private readonly d: AuthDeps) {
    this.issuer = d.issuer ?? 'BTC Desk';
  }

  /** True once there is a user to sign in as, and a key to seal their secret with. */
  async configured(): Promise<boolean> {
    return this.d.secrets !== null && (await this.d.store.user()) !== null;
  }

  async username(): Promise<string | null> {
    return (await this.d.store.user())?.username ?? null;
  }

  // ----------------------------------------------------------- step 1: password

  async login(username: unknown, password: unknown, ctx: Ctx): Promise<{ ok: true; issued: Issued } | Failure> {
    const now = this.d.now();
    if (!(await this.configured())) return { ok: false, status: 503, error: 'Sign-in is not set up on this server.' };
    const ip = ctx.ip ?? 'unknown';

    const locked = await this.lockedFor([
      [KEY.passwordAddress(ip), LIMITS.passwordPerAddress.max],
      [KEY.passwordAccount, LIMITS.passwordPerAccount.max],
    ], now);
    if (locked) return { ok: false, status: 429, error: `Too many attempts. Try again in ${locked} minute${locked === 1 ? '' : 's'}.` };

    const user = (await this.d.store.user())!;
    const pw = typeof password === 'string' ? password : '';
    const nameOk = typeof username === 'string' && username.trim() === user.username;
    // the hash is always checked, so a wrong username takes as long as a wrong password
    const pwOk = verifyPassword(pw.slice(0, 256), nameOk ? user.passwordHash : DUMMY_HASH);

    if (!nameOk || !pwOk) {
      await this.d.store.fail(KEY.passwordAddress(ip), now, LIMITS.passwordPerAddress.windowMs);
      const n = await this.d.store.fail(KEY.passwordAccount, now, LIMITS.passwordPerAccount.windowMs);
      await this.d.store.event('password_wrong', now, ctx.ip);
      if (n === LIMITS.passwordPerAccount.max) {
        await this.d.store.event('signin_locked', now, ctx.ip, 'too many wrong passwords');
        this.alert(`🔐 BTC Desk: sign-in locked for 15 minutes after ${n} wrong passwords. Last from ${ctx.ip ?? 'unknown'}.`);
      }
      // one message for both halves: which one was wrong is not a stranger's business
      return { ok: false, status: 401, error: 'Wrong username or password.' };
    }

    await this.d.store.clear(KEY.passwordAddress(ip));
    const stage: Stage = user.totpSecret ? 'totp' : 'setup';
    await this.d.store.event('password_ok', now, ctx.ip, stage === 'totp' ? 'code needed' : '2FA setup needed');
    return { ok: true, issued: await this.issue(stage, now, ctx) };
  }

  // ------------------------------------------------------------ step 2: code

  async verifyCode(token: string | undefined, code: unknown, ctx: Ctx): Promise<{ ok: true; issued: Issued; usedRecoveryCode: boolean } | Failure> {
    const now = this.d.now();
    const s = token ? await this.d.store.session(token, now) : null;
    if (!s || s.stage !== 'totp') return { ok: false, status: 401, error: 'Sign in again.', restart: true };

    const locked = await this.lockedFor([[KEY.codeAccount, LIMITS.codePerAccount.max]], now);
    if (locked) return { ok: false, status: 429, error: `Too many wrong codes. Try again in ${locked} minute${locked === 1 ? '' : 's'}.` };

    const user = (await this.d.store.user())!;
    const text = typeof code === 'string' ? code.trim() : '';
    let usedRecoveryCode = false;
    let good = false;

    if (/[a-z]/i.test(text)) {
      good = await this.d.store.useRecoveryCode(this.d.secrets!.codeHash(text), now);
      usedRecoveryCode = good;
    } else {
      const secret = this.openSecret(user.totpSecret);
      const step = secret ? verifyTotp(secret, text, now, user.totpLastStep) : null;
      // the step is claimed in one conditional write: the same code sent twice passes once
      good = step !== null && await this.d.store.useTotpStep(step, now);
    }

    if (!good) return await this.wrongCode(s, now, ctx);

    await this.d.store.revoke(s.tokenHash, now);
    await this.d.store.clear(KEY.passwordAccount);
    await this.d.store.clear(KEY.codeAccount);
    await this.d.store.event(usedRecoveryCode ? 'signin_recovery_code' : 'signin', now, ctx.ip, ctx.userAgent);
    if (usedRecoveryCode) {
      const left = await this.d.store.recoveryCodesLeft();
      this.alert(`🔐 BTC Desk: signed in with a recovery code from ${ctx.ip ?? 'unknown'}. ${left} left.`);
    }
    return { ok: true, issued: await this.issue('full', now, ctx), usedRecoveryCode };
  }

  // ------------------------------------------------------- first-time setup

  /** The QR code and key to scan. The same ones for fifteen minutes, so a reload does not change them. */
  async setup(token: string | undefined): Promise<{ ok: true; secret: string; otpauthUrl: string; qrSvg: string } | Failure> {
    const now = this.d.now();
    const s = token ? await this.d.store.session(token, now) : null;
    if (!s || s.stage !== 'setup') return { ok: false, status: 401, error: 'Sign in again.', restart: true };
    const user = (await this.d.store.user())!;
    if (user.totpSecret) return { ok: false, status: 409, error: 'Two-step sign-in is already on.' };

    let secret = user.totpPending && user.totpPendingAt && now - user.totpPendingAt < SETUP_STAGE_MS
      ? this.openSecret(user.totpPending)
      : null;
    if (!secret) {
      secret = newSecret();
      await this.d.store.setPendingTotp(this.d.secrets!.seal(secret), now);
    }
    const url = otpauthUrl({ issuer: this.issuer, account: user.username, secret });
    const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    return { ok: true, secret, otpauthUrl: url, qrSvg };
  }

  async enable(token: string | undefined, code: unknown, ctx: Ctx): Promise<{ ok: true; issued: Issued; recoveryCodes: string[] } | Failure> {
    const now = this.d.now();
    const s = token ? await this.d.store.session(token, now) : null;
    if (!s || s.stage !== 'setup') return { ok: false, status: 401, error: 'Sign in again.', restart: true };
    const locked = await this.lockedFor([[KEY.codeAccount, LIMITS.codePerAccount.max]], now);
    if (locked) return { ok: false, status: 429, error: `Too many wrong codes. Try again in ${locked} minute${locked === 1 ? '' : 's'}.` };

    const user = (await this.d.store.user())!;
    const pending = this.openSecret(user.totpPending);
    if (!pending) return { ok: false, status: 409, error: 'Scan the QR code first.' };
    const step = verifyTotp(pending, typeof code === 'string' ? code : '', now);
    if (step === null) return await this.wrongCode(s, now, ctx);

    await this.d.store.enableTotp(user.totpPending!, step, now);
    const codes = newRecoveryCodes();
    await this.d.store.replaceRecoveryCodes(codes.map((c) => this.d.secrets!.codeHash(c)), now);
    await this.d.store.revoke(s.tokenHash, now);
    await this.d.store.clear(KEY.codeAccount);
    await this.d.store.event('2fa_enabled', now, ctx.ip);
    this.alert(`🔐 BTC Desk: two-step sign-in was turned on, from ${ctx.ip ?? 'unknown'}.`);
    return { ok: true, issued: await this.issue('full', now, ctx), recoveryCodes: codes };
  }

  // --------------------------------------------------------- signed in

  /** The live session behind a token, at any stage. Refreshes last-seen now and then. */
  async session(token: string | undefined): Promise<SessionRow | null> {
    if (!token) return null;
    const now = this.d.now();
    const s = await this.d.store.session(token, now);
    if (s?.stage === 'full') await this.d.store.touch(s.tokenHash, now);
    return s;
  }

  async logout(token: string | undefined, ctx: Ctx): Promise<void> {
    if (!token) return;
    const now = this.d.now();
    const s = await this.d.store.session(token, now);
    if (!s) return;
    await this.d.store.revoke(s.tokenHash, now);
    if (s.stage === 'full') await this.d.store.event('signout', now, ctx.ip);
  }

  async changePassword(
    token: string | undefined,
    body: { current?: unknown; next?: unknown; code?: unknown },
    ctx: Ctx,
  ): Promise<{ ok: true; issued: Issued; endedSessions: number } | Failure> {
    const now = this.d.now();
    const s = await this.fullSession(token, now);
    if (!s) return { ok: false, status: 401, error: 'Sign in again.', restart: true };
    const locked = await this.lockedFor([
      [KEY.passwordAccount, LIMITS.passwordPerAccount.max],
      [KEY.codeAccount, LIMITS.codePerAccount.max],
    ], now);
    if (locked) return { ok: false, status: 429, error: `Too many attempts. Try again in ${locked} minute${locked === 1 ? '' : 's'}.` };

    const user = (await this.d.store.user())!;
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';

    if (!verifyPassword(current.slice(0, 256), user.passwordHash)) {
      await this.d.store.fail(KEY.passwordAccount, now, LIMITS.passwordPerAccount.windowMs);
      await this.d.store.event('password_change_wrong_password', now, ctx.ip);
      return { ok: false, status: 401, error: 'The current password is not right.' };
    }
    const problems = passwordProblems(next, { username: user.username, current });
    if (problems.length) return { ok: false, status: 400, error: problems.join(' '), problems };

    const codeOk = await this.checkCodeNow(user, body.code, now);
    if (!codeOk) {
      await this.d.store.fail(KEY.codeAccount, now, LIMITS.codePerAccount.windowMs);
      await this.d.store.event('password_change_wrong_code', now, ctx.ip);
      return { ok: false, status: 401, error: 'The authenticator code is not right.' };
    }

    await this.d.store.setPassword(hashPassword(next), now);
    // every other device is signed out; this one gets a fresh token
    const ended = await this.d.store.revokeAll(now, s.tokenHash);
    await this.d.store.revoke(s.tokenHash, now);
    await this.d.store.event('password_changed', now, ctx.ip, `${ended} other session${ended === 1 ? '' : 's'} ended`);
    this.alert(`🔐 BTC Desk: the password was changed, from ${ctx.ip ?? 'unknown'}. ${ended} other session${ended === 1 ? '' : 's'} signed out.`);
    return { ok: true, issued: await this.issue('full', now, ctx), endedSessions: ended };
  }

  async newRecoveryCodes(token: string | undefined, code: unknown, ctx: Ctx): Promise<{ ok: true; recoveryCodes: string[] } | Failure> {
    const now = this.d.now();
    const s = await this.fullSession(token, now);
    if (!s) return { ok: false, status: 401, error: 'Sign in again.', restart: true };
    const locked = await this.lockedFor([[KEY.codeAccount, LIMITS.codePerAccount.max]], now);
    if (locked) return { ok: false, status: 429, error: `Too many wrong codes. Try again in ${locked} minute${locked === 1 ? '' : 's'}.` };
    const user = (await this.d.store.user())!;
    if (!await this.checkCodeNow(user, code, now)) {
      await this.d.store.fail(KEY.codeAccount, now, LIMITS.codePerAccount.windowMs);
      return { ok: false, status: 401, error: 'The authenticator code is not right.' };
    }
    const codes = newRecoveryCodes();
    await this.d.store.replaceRecoveryCodes(codes.map((c) => this.d.secrets!.codeHash(c)), now);
    await this.d.store.event('recovery_codes_replaced', now, ctx.ip);
    return { ok: true, recoveryCodes: codes };
  }

  async signOutOthers(token: string | undefined, ctx: Ctx): Promise<{ ok: true; ended: number } | Failure> {
    const now = this.d.now();
    const s = await this.fullSession(token, now);
    if (!s) return { ok: false, status: 401, error: 'Sign in again.', restart: true };
    const ended = await this.d.store.revokeAll(now, s.tokenHash);
    await this.d.store.event('signed_out_others', now, ctx.ip, `${ended} ended`);
    return { ok: true, ended };
  }

  async account(token: string | undefined) {
    const now = this.d.now();
    const s = await this.fullSession(token, now);
    if (!s) return null;
    const user = (await this.d.store.user())!;
    await this.d.store.prune(now);
    return {
      username: user.username,
      passwordChangedAt: user.passwordChangedAt,
      twoFactorSince: user.totpEnabledAt,
      recoveryCodesLeft: await this.d.store.recoveryCodesLeft(),
      sessionExpiresAt: s.expiresAt,
      sessions: (await this.d.store.liveSessions(now)).map((x) => ({
        id: x.tokenHash.slice(0, 10),
        current: x.tokenHash === s.tokenHash,
        createdAt: x.createdAt,
        lastSeenAt: x.lastSeenAt,
        expiresAt: x.expiresAt,
        ip: x.ip,
        device: describeDevice(x.userAgent),
      })),
      events: await this.d.store.events(20),
    };
  }

  // ------------------------------------------------------------- inside

  private async issue(stage: Stage, now: number, ctx: Ctx): Promise<Issued> {
    const token = randomBytes(32).toString('base64url');
    const ttlMs = stage === 'full' ? SESSION_MS : stage === 'totp' ? CODE_STAGE_MS : SETUP_STAGE_MS;
    await this.d.store.createSession({ token, stage, now, ttlMs, ip: ctx.ip, userAgent: ctx.userAgent });
    return { token, stage, expiresAt: now + ttlMs };
  }

  private async fullSession(token: string | undefined, now: number): Promise<SessionRow | null> {
    const s = token ? await this.d.store.session(token, now) : null;
    return s && s.stage === 'full' ? s : null;
  }

  private async wrongCode(s: SessionRow, now: number, ctx: Ctx): Promise<Failure> {
    const n = await this.d.store.fail(KEY.codeAccount, now, LIMITS.codePerAccount.windowMs);
    const tries = await this.d.store.bumpAttempts(s.tokenHash);
    await this.d.store.event('code_wrong', now, ctx.ip);
    if (n === LIMITS.codePerAccount.max) {
      await this.d.store.event('signin_locked', now, ctx.ip, 'too many wrong codes');
      this.alert(`🔐 BTC Desk: sign-in codes locked for 15 minutes after ${n} wrong codes. The password was right -- change it if that was not you.`);
    }
    if (tries >= LIMITS.codePerSignIn) {
      await this.d.store.revoke(s.tokenHash, now);
      return { ok: false, status: 401, error: 'Too many wrong codes. Sign in again.', restart: true };
    }
    return { ok: false, status: 401, error: 'That code is not right. Use the newest code in the app, and check your phone’s clock is set automatically.' };
  }

  /** A code for a signed-in action: never a recovery code, never a code already used. */
  private async checkCodeNow(user: User, code: unknown, now: number): Promise<boolean> {
    const secret = this.openSecret(user.totpSecret);
    if (!secret || typeof code !== 'string') return false;
    const step = verifyTotp(secret, code, now, user.totpLastStep);
    return step !== null && await this.d.store.useTotpStep(step, now);
  }

  private openSecret(sealed: string | null): string | null {
    if (!sealed || !this.d.secrets) return null;
    try { return this.d.secrets.open(sealed); } catch { return null; }
  }

  /** Minutes left on the first key over its limit, or 0. */
  private async lockedFor(keys: [string, number][], now: number): Promise<number> {
    for (const [key, max] of keys) {
      if (await this.d.store.failures(key, now) >= max) {
        return Math.max(1, Math.ceil((await this.d.store.windowUntil(key) - now) / 60_000));
      }
    }
    return 0;
  }

  private alert(text: string): void {
    try { this.d.onAlert?.(text); } catch { /* an alert must never break sign-in */ }
  }
}

/** "iPhone · Safari", "Android · Chrome", "Mac · Firefox" -- enough to recognise a device. */
export function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

/** Built from the environment, and the first user seeded from it when the database has none. */
export async function authFromEnv(o: { store?: AuthStore; now?: () => number; onAlert?: (text: string) => void } = {}): Promise<AuthService> {
  const store = o.store ?? await AuthStore.open();
  const now = o.now ?? Date.now;
  const username = process.env.DESK_USER?.trim() ?? '';
  const passwordHash = process.env.DESK_PASSWORD_HASH?.trim() ?? '';
  const master = process.env.DESK_SESSION_SECRET?.trim() ?? '';
  let secrets: Secrets | null = null;
  try { secrets = master ? new Secrets(master) : null; } catch { secrets = null; }
  // The environment only ever creates the first user. After that the database is
  // the authority -- a password changed on the screen must not be undone by an
  // old hash left in .env on the next restart.
  if (!(await store.user()) && username && passwordHash) await store.seedUser(username, passwordHash, now());
  return new AuthService({ store, secrets, now, onAlert: o.onAlert });
}

export { tokenHash };
