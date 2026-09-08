import type { FastifyInstance } from 'fastify';
import {
  COOKIE, LoginLimiter, issueToken, readCookie, tokenValid, verifyPassword, type AuthConfig,
} from '../session.js';

const cookieFor = (value: string, maxAge: number) =>
  `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${maxAge}`;

export function registerSessionRoutes(app: FastifyInstance, auth: AuthConfig) {
  const limiter = new LoginLimiter();

  app.get('/api/me', async (req) => {
    if (!auth.enabled) return { required: false, signedIn: true };
    const signedIn = tokenValid(auth, readCookie(req.headers.cookie, COOKIE));
    return { required: true, signedIn, username: signedIn ? auth.username : null };
  });

  app.post('/api/login', async (req, reply) => {
    if (!auth.enabled) return { ok: true, required: false };
    const who = req.ip || 'unknown';
    if (limiter.blocked(who)) {
      reply.code(429);
      return { error: 'Too many attempts. Wait ten minutes and try again.' };
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const ok =
      typeof username === 'string' &&
      typeof password === 'string' &&
      username.trim() === auth.username &&
      verifyPassword(password, auth.passwordHash);

    if (!ok) {
      limiter.fail(who);
      // one message for both cases: saying which half was wrong tells an
      // attacker whether the username exists
      reply.code(401);
      return { error: 'Wrong username or password.' };
    }
    limiter.succeed(who);
    reply.header('Set-Cookie', cookieFor(issueToken(auth), auth.ttl));
    return { ok: true, username: auth.username };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('Set-Cookie', cookieFor('', 0));
    return { ok: true };
  });
}
