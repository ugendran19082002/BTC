import type { FastifyInstance } from 'fastify';
import { errorLog, type ErrorReport, type ErrorSource } from '../../observability/errors.js';

/**
 * The error log, readable and writable from the browser.
 *
 * The browser half matters as much as the server half: a component that throws
 * during a fill is invisible from the container's logs, and by the time anyone
 * asks, the tab has been reloaded.
 */

const SOURCES = new Set<ErrorSource>(['server', 'browser', 'exchange', 'trading']);

export function registerErrorRoutes(app: FastifyInstance) {
  const log = errorLog();

  /** The browser reports here. Kept cheap: it is called from an error handler. */
  app.post('/api/errors', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<ErrorReport> & { source?: string };
    if (typeof b.message !== 'string' || !b.message.trim()) {
      reply.code(400);
      return { error: 'message is required' };
    }
    log.record({
      // Anything arriving over HTTP is a browser report whatever it claims,
      // so a bug in the page cannot forge a server-side failure.
      source: b.source === 'browser' ? 'browser' : 'browser',
      level: b.level === 'warn' ? 'warn' : 'error',
      message: b.message,
      code: typeof b.code === 'string' ? b.code : null,
      stack: typeof b.stack === 'string' ? b.stack : null,
      where: typeof b.where === 'string' ? b.where : null,
      context: {
        ...(b.context && typeof b.context === 'object' ? b.context : {}),
        userAgent: req.headers['user-agent'] ?? null,
      },
    });
    reply.code(204);
    return null;
  });

  app.get('/api/errors', async (req) => {
    const q = req.query as { limit?: string; source?: string; resolved?: string };
    const source = q.source && SOURCES.has(q.source as ErrorSource) ? (q.source as ErrorSource) : undefined;
    return {
      errors: log.list({
        limit: Math.min(500, Number(q.limit ?? 100)),
        source,
        includeResolved: q.resolved === '1' || q.resolved === 'true',
      }),
      summary: log.summary(),
    };
  });

  app.post('/api/errors/resolve', async (req, reply) => {
    const { id, all } = (req.body ?? {}) as { id?: number; all?: boolean };
    if (all) return { ok: true, resolved: log.resolveAll() };
    if (typeof id !== 'number') { reply.code(400); return { error: 'id or all is required' }; }
    log.resolve(id);
    return { ok: true, resolved: 1 };
  });
}
