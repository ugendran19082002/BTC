import type { FastifyInstance } from 'fastify';
import { credsFromEnv, getBalances, getPositions, NotConfigured } from '../../account/account.js';
import { maxLots, USDINR } from '../../domain/score.js';

// Read once at startup so a later log line cannot pick the secret out of env.
const creds = credsFromEnv();

export const hasCredentials = () => creds !== null;

export function registerAccountRoutes(app: FastifyInstance) {
  app.get('/api/account', async (_req, reply) => {
    try {
      const [balances, positions] = await Promise.all([getBalances(creds), getPositions(creds)]);
      const usd = balances.find((b) => b.asset_symbol === 'USD' || b.asset_symbol === 'USDT');
      const available = Number(usd?.available_balance ?? 0);
      return {
        configured: true,
        availableUsd: available,
        availableInr: available * USDINR,
        maxLots: maxLots(available),
        balances,
        positions: positions.filter((p) => (p.size ?? 0) !== 0),
      };
    } catch (e) {
      if (e instanceof NotConfigured) {
        reply.code(501);
        return { configured: false, message: e.message };
      }
      reply.code(502);
      return { configured: true, error: (e as Error).message };
    }
  });
}
