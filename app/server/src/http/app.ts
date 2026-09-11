import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { authFromEnv, COOKIE, readCookie, tokenValid } from './session.js';
import { registerSessionRoutes } from './routes/session.routes.js';
import { registerDeskRoutes } from './routes/desk.routes.js';
import { registerBacktestRoutes } from './routes/backtest.routes.js';
import { registerTradeRoutes } from './routes/trade.routes.js';
import { registerErrorRoutes } from './routes/errors.routes.js';
import { registerStrategyRoutes } from './routes/strategy.routes.js';
import { noteError } from '../observability/errors.js';
import { wasRefusal, worthLogging } from './refuse.js';

/**
 * Open without a session: the health probe, and login itself.
 *
 * Route PATTERNS as registered, not request paths. See the gate below.
 */
const PUBLIC_ROUTES = new Set(['/api/health', '/api/login', '/api/me']);

/**
 * Where a request that changes something may come from.
 *
 * The session cookie is SameSite=Strict, which keeps other sites out -- but not
 * other sites on the same registrable domain: anything under thannigo.in is
 * "same-site" and gets the cookie. So a state-changing request must also carry
 * an Origin (or, failing that, a Referer) naming this host. A request with
 * neither is not from a browser page, and still needs the cookie.
 */
export function originAllowed(req: FastifyRequest, extra: string[] = []): boolean {
  const from = req.headers.origin ?? refererOrigin(req.headers.referer);
  if (!from) return true;
  let host: string;
  try { host = new URL(from).host; } catch { return false; }
  const own = [req.headers['x-forwarded-host'], req.headers.host]
    .flatMap((h) => (Array.isArray(h) ? h : [h]))
    .filter((h): h is string => typeof h === 'string' && h.length > 0)
    .map((h) => h.split(',')[0]!.trim());
  if (own.includes(host)) return true;
  return extra.some((o) => { try { return new URL(o).host === host; } catch { return false; } });
}

const refererOrigin = (ref: string | undefined): string | undefined => {
  if (!ref) return undefined;
  try { return new URL(ref).origin; } catch { return 'invalid:'; }
};

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // the proxy in front terminates TLS; trust it for the client address so the
    // login limiter counts real callers rather than the proxy
    trustProxy: true,
  });

  /*
   * No CORS. The page and the API share one origin through the proxy, so a
   * cross-origin browser call has no legitimate caller. It used to answer every
   * origin with credentials allowed -- any page could ask with the desk's cookie
   * and read the reply wherever SameSite let the cookie through.
   */

  const auth = authFromEnv();
  const allowedOrigins = (process.env.DESK_ALLOWED_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean);

  /*
   * The gate.
   *
   * Decided on the route Fastify actually matched, never on the text of the
   * URL. It used to test `req.url.startsWith('/api/')`, and the router decodes
   * percent-escapes before matching: `/%61pi/trade/status` failed the text test,
   * skipped the gate, and was routed to /api/trade/status anyway. Every route,
   * placing orders included, answered without a session.
   *
   * Fail closed: every matched route needs a session unless it is on the public
   * list. A request that matches nothing gets Fastify's 404, which carries no data.
   */
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url;
    if (route === undefined) return;
    if (UNSAFE.has(req.method) && !originAllowed(req, allowedOrigins)) {
      reply.code(403);
      return reply.send({ error: 'cross-origin request refused' });
    }
    if (!auth.enabled || PUBLIC_ROUTES.has(route)) return;
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
  // Except when the "no" was the point: a gate turning an order down, or the
  // mode switch holding the line, is the desk working. Those are marked by
  // `refuse` and stay out, or every blocked order becomes an error to triage.
  app.addHook('onResponse', async (req, reply) => {
    if (!worthLogging(reply.statusCode, wasRefusal(reply))) return;
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
  registerBacktestRoutes(app);
  registerTradeRoutes(app);
  registerErrorRoutes(app);
  registerStrategyRoutes(app);

  return app;
}
