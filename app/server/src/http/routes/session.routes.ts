import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService, Failure, Issued } from '../../auth/service.js';
import { COOKIE, readCookie, sessionCookie } from '../session.js';

/**
 * Sign-in, two-step setup, and the account page.
 *
 * Each route says which session stage it needs (`config.auth`), and the gate in
 * app.ts enforces it before the handler runs; the service checks again, because
 * a check in one place is a check that a refactor can lose.
 */

export type AuthLevel = 'public' | 'totp' | 'setup' | 'full';

const ctxOf = (req: FastifyRequest) => ({
  ip: req.ip || null,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
});

const tokenOf = (req: FastifyRequest) => readCookie(req.headers.cookie, COOKIE);

function setSession(reply: FastifyReply, issued: Issued, now: number) {
  reply.header('Set-Cookie', sessionCookie(issued.token, (issued.expiresAt - now) / 1000));
}

function failed(reply: FastifyReply, f: Failure) {
  reply.code(f.status);
  if (f.restart) reply.header('Set-Cookie', sessionCookie('', 0));
  return { error: f.error, ...(f.problems ? { problems: f.problems } : {}), ...(f.restart ? { restart: true } : {}) };
}

export function registerSessionRoutes(app: FastifyInstance, auth: AuthService, now: () => number = Date.now) {
  const open = { config: { auth: 'public' as AuthLevel } };

  /** Where this browser is in signing in. Public, and says nothing about the account to a stranger. */
  app.get('/api/me', open, async (req) => {
    const s = auth.session(tokenOf(req));
    return {
      required: true,
      configured: auth.configured,
      stage: s?.stage ?? 'none',
      signedIn: s?.stage === 'full',
      username: s?.stage === 'full' ? auth.username : null,
      expiresAt: s?.stage === 'full' ? s.expiresAt : null,
    };
  });

  app.post('/api/login', open, async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const r = auth.login(b.username, b.password, ctxOf(req));
    if (!r.ok) return failed(reply, r);
    setSession(reply, r.issued, now());
    return { ok: true, next: r.issued.stage === 'totp' ? 'code' : 'setup' };
  });

  app.post('/api/login/code', { config: { auth: 'totp' as AuthLevel } }, async (req, reply) => {
    const r = auth.verifyCode(tokenOf(req), (req.body as { code?: unknown } | undefined)?.code, ctxOf(req));
    if (!r.ok) return failed(reply, r);
    setSession(reply, r.issued, now());
    return { ok: true, usedRecoveryCode: r.usedRecoveryCode };
  });

  app.post('/api/logout', open, async (req, reply) => {
    auth.logout(tokenOf(req), ctxOf(req));
    reply.header('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  });

  app.get('/api/security/setup', { config: { auth: 'setup' as AuthLevel } }, async (req, reply) => {
    const r = await auth.setup(tokenOf(req));
    if (!r.ok) return failed(reply, r);
    reply.header('Cache-Control', 'no-store');
    return { secret: r.secret, otpauthUrl: r.otpauthUrl, qrSvg: r.qrSvg };
  });

  app.post('/api/security/enable', { config: { auth: 'setup' as AuthLevel } }, async (req, reply) => {
    const r = auth.enable(tokenOf(req), (req.body as { code?: unknown } | undefined)?.code, ctxOf(req));
    if (!r.ok) return failed(reply, r);
    setSession(reply, r.issued, now());
    reply.header('Cache-Control', 'no-store');
    return { ok: true, recoveryCodes: r.recoveryCodes };
  });

  app.get('/api/security', async (req, reply) => {
    const a = auth.account(tokenOf(req));
    if (!a) { reply.code(401); return { error: 'Sign in again.' }; }
    reply.header('Cache-Control', 'no-store');
    return a;
  });

  app.post('/api/security/password', async (req, reply) => {
    const r = auth.changePassword(tokenOf(req), (req.body ?? {}) as object, ctxOf(req));
    if (!r.ok) return failed(reply, r);
    setSession(reply, r.issued, now());
    return { ok: true, endedSessions: r.endedSessions };
  });

  app.post('/api/security/recovery-codes', async (req, reply) => {
    const r = auth.newRecoveryCodes(tokenOf(req), (req.body as { code?: unknown } | undefined)?.code, ctxOf(req));
    if (!r.ok) return failed(reply, r);
    reply.header('Cache-Control', 'no-store');
    return { ok: true, recoveryCodes: r.recoveryCodes };
  });

  app.post('/api/security/sign-out-others', async (req, reply) => {
    const r = auth.signOutOthers(tokenOf(req), ctxOf(req));
    if (!r.ok) return failed(reply, r);
    return { ok: true, ended: r.ended };
  });
}
