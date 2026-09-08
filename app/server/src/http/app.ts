import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from '../config.js';
import { authFromEnv, COOKIE, readCookie, tokenValid } from './session.js';
import { registerSessionRoutes } from './routes/session.routes.js';
import { registerDeskRoutes } from './routes/desk.routes.js';
import { registerAccountRoutes } from './routes/account.routes.js';
import { registerBacktestRoutes } from './routes/backtest.routes.js';
import { registerTradeRoutes } from './routes/trade.routes.js';
import { registerErrorRoutes } from './routes/errors.routes.js';
import { noteError } from '../observability/errors.js';

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

  // Anything a route throws lands in the log before Fastify turns it into a 500.
  // Without this the only record is a container log line nobody reads until the
  // desk is already behaving strangely.
  app.setErrorHandler((raw, req, reply) => {
    const err = raw as Error & { code?: string; statusCode?: number };
    noteError({
      source: 'server',
      message: err.message,
      code: err.code ?? String(err.statusCode ?? 500),
      stack: err.stack ?? null,
      where: `${req.method} ${req.url.split('?')[0]}`,
      context: { query: req.query, statusCode: err.statusCode ?? 500 },
    });
    req.log.error({ err }, 'request failed');
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  // A route that answers 4xx or 5xx without throwing is still a failure worth
  // seeing -- most of this API reports its problems in the body, not by throwing.
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode < 400 || reply.statusCode === 401 || reply.statusCode === 404) return;
    noteError({
      source: 'server',
      level: reply.statusCode >= 500 ? 'error' : 'warn',
      message: `${reply.statusCode} from ${req.url.split('?')[0]}`,
      code: String(reply.statusCode),
      where: `${req.method} ${req.url.split('?')[0]}`,
      context: { query: req.query },
    });
  });

  registerSessionRoutes(app, auth);
  registerDeskRoutes(app);
  registerAccountRoutes(app);
  registerBacktestRoutes(app);
  registerTradeRoutes(app);
  registerErrorRoutes(app);

  return app;
}
