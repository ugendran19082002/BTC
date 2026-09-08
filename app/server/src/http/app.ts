import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from '../config.js';
import { authFromEnv, COOKIE, readCookie, tokenValid } from './session.js';
import { registerSessionRoutes } from './routes/session.routes.js';
import { registerDeskRoutes } from './routes/desk.routes.js';
import { registerAccountRoutes } from './routes/account.routes.js';
import { registerBacktestRoutes } from './routes/backtest.routes.js';
import { registerTradeRoutes } from './routes/trade.routes.js';

/** Open without a session: the health probe, and login itself. */
const PUBLIC_ROUTES = new Set(['/api/health', '/api/login', '/api/me']);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // the proxy in front terminates TLS; trust it for the client address so the
    // login limiter counts real callers rather than the proxy
    trustProxy: true,
  });

  // Credentials must be allowed through for the session cookie, which means the
  // origin cannot be a wildcard.
  await app.register(cors, {
    origin: (_origin, cb) => cb(null, true),
    credentials: true,
  });

  const auth = authFromEnv();

  app.addHook('onRequest', async (req, reply) => {
    if (!auth.enabled) return;
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || PUBLIC_ROUTES.has(path)) return;
    if (tokenValid(auth, readCookie(req.headers.cookie, COOKIE))) return;
    reply.code(401);
    return reply.send({ error: 'not signed in' });
  });

  registerSessionRoutes(app, auth);
  registerDeskRoutes(app);
  registerAccountRoutes(app);
  registerBacktestRoutes(app);
  registerTradeRoutes(app);

  return app;
}
