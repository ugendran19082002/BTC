import type { FastifyInstance, FastifyReply } from 'fastify';
import { AccountRefused, brokerAccounts, envKeyLeft, MAX_ACCOUNTS, testConnection, type BrokerAccount, type Tester } from '../../delta/accounts.js';
import { closeDesk, deskOpen, openDesk, setPrimaryDesk, tradingService, tradingServiceFor, tradingServices } from '../../trading/service.js';
import { strategyStore } from './strategy.routes.js';
import { DeltaExchange } from '../../trading/exchange/delta.js';
import { noteError } from '../../observability/errors.js';
import { refuse } from '../refuse.js';
import type { AuthService } from '../../auth/service.js';
import { ctxOf, tokenOf } from './session.routes.js';
import type { ExchangePosition } from '../../trading/types.js';

/**
 * The broker accounts (Logs -> Accounts): add, name, test, switch on and off,
 * choose the default, remove -- the last only with a fresh authenticator code.
 *
 * No route here ever answers with a key or a secret -- only the key's last four
 * characters. A rule holding (the desk is live on this account; the key fails
 * its test) is answered with its sentence through `refuse`, so it stays out of
 * the error log.
 *
 * Every active account trades (owner, 5 Oct 2026): switching one on gives it a
 * desk of its own -- its engine, its exchange key, its own open trades -- and
 * switching it off stops that desk, which is refused while it holds a position.
 * The default is only which account's tab opens first and which desk answers a
 * request that names none; choosing it moves no order anywhere.
 */

/**
 * Once a day the table is read again, and the desks brought into line with it: an account switched on by hand
 * in a console gets its desk; one switched off loses it -- unless it holds a position, which is said instead.
 */
export async function refreshBrokerAccounts(): Promise<void> {
  const accounts = brokerAccounts();
  await accounts.refresh();
  for (const a of accounts.list()) {
    if (a.active && accounts.credsOf(a.id) && !deskOpen(a.id)) await openDesk(a.id);
  }
  for (const desk of tradingServices()) {
    const id = desk.accountId;
    if (id === null || !deskOpen(id)) continue;
    const a = accounts.get(id);
    if (a && a.active && accounts.credsOf(id)) continue;
    const open = await desk.openTrades();
    if (open.length > 0) {
      noteError({ source: 'server', level: 'warn', where: 'broker-accounts', message: `broker account ${id} was switched off in the database while it holds ${open.length} open trade${open.length === 1 ? '' : 's'}: its desk keeps running until they are closed` });
    } else closeDesk(id);
  }
  const first = accounts.default();
  if (first) setPrimaryDesk(first.id);
}

export type AccountSummaryReader = (creds: { key: string; secret: string }) => Promise<[{ balance: number; available: number }, ExchangePosition[]]>;

export function registerAccountRoutes(app: FastifyInstance, o: { test?: Tester; summary?: AccountSummaryReader; auth?: AuthService } = {}): void {
  const test = o.test ?? testConnection;

  const view = async () => {
    const accounts = brokerAccounts();
    const svc = tradingService();
    return {
      // Each with why it cannot be removed, when it cannot: said on the screen before a code is asked for.
      // ...and whether it is trading: switched on, its key readable, a desk of its own running.
      accounts: await Promise.all(accounts.list().map(async (a) => ({ ...a, trading: deskOpen(a.id), keptBecause: await keptBecause(a) }))),
      max: MAX_ACCOUNTS,
      /** False without DESK_SESSION_SECRET: a key cannot be encrypted, so none can be added. */
      canStore: accounts.canStore,
      mode: svc.mode,
      /** `.env` still has the key that was imported from it: not read any more, and to be emptied there. */
      envKeyLeft: envKeyLeft(),
    };
  };
  /** A rule's "no" as its own status and sentence; anything else is a fault and is thrown on. */
  const said = (reply: FastifyReply, e: unknown) => {
    if (e instanceof AccountRefused) return refuse(reply, e.status, { error: e.message });
    throw e;
  };
  const idOf = (params: unknown): number => Number((params as { id?: string }).id);
  /**
   * An account the journal knows is kept: its orders, P&L and strategies are read by its id, and removing it
   * would leave them belonging to nothing. It is switched off instead. (The check a foreign key would make.)
   */
  const historyOf = async (id: number): Promise<string | null> => {
    // Read now, every time: two counts on indexed columns. Held for ten seconds at first, and the real-time run
    // showed the list saying "can be removed" for those ten seconds after a strategy was made for the account.
    const [trades, strategies] = await Promise.all([tradingService().store.countFor(id), strategyStore().countFor(id)]);
    if (trades === 0 && strategies === 0) return null;
    const has = [trades ? `${trades} ${trades === 1 ? 'trade' : 'trades'}` : '', strategies ? `${strategies} ${strategies === 1 ? 'strategy' : 'strategies'}` : ''].filter(Boolean).join(' and ');
    return `This account has ${has} on record, so it is kept. Deactivate it instead.`;
  };
  /** Why an account cannot be removed right now, or null: the last one, one with history, the one the desk is live on. */
  const keptBecause = async (a: BrokerAccount): Promise<string | null> =>
    brokerAccounts().removalBlocked(a.id) ?? await historyOf(a.id);
  /** Why an account's desk cannot be stopped right now, or null: it holds a position that only it is managing. */
  const holding = async (a: BrokerAccount): Promise<string | null> => {
    if (!deskOpen(a.id)) return null;
    const open = await tradingServiceFor(a.id)!.openTrades();
    return open.length > 0
      ? `Close ${open.length} open ${open.length === 1 ? 'position' : 'positions'} on "${a.name}" first — while it holds one, its desk has to keep running to manage it.`
      : null;
  };
  const found = (reply: FastifyReply, id: number): BrokerAccount | null => {
    const a = Number.isInteger(id) ? brokerAccounts().get(id) : null;
    if (!a) { reply.code(404); return null; }
    return a;
  };
  // Every saved account -- name, description, the key's last four, whether it is on, the default, its last test.
  app.get('/api/accounts', async () => await view());

  // Save an account: the key and the secret are encrypted here and never sent back. The first one becomes the default.
  app.post('/api/accounts', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: unknown; description?: unknown; api_key?: unknown; api_secret?: unknown };
    try {
      const accounts = brokerAccounts();
      const a = await accounts.create({ name: b.name, description: b.description, apiKey: b.api_key, apiSecret: b.api_secret });
      // Tested as it is saved, so the row says at once whether the key works; saved either way (an IP not yet whitelisted is fixed on Delta).
      const creds = accounts.credsOf(a.id);
      if (creds) await accounts.noteTest(a.id, await test(creds));
      // Saved switched on, so it has a desk at once: its own strategies trade on it from here.
      await openDesk(a.id);
      if (a.isDefault) setPrimaryDesk(a.id);
      return await view();
    } catch (e) { return said(reply, e); }
  });

  // Rename an account or change its description. The key is not edited: remove the account and add it again.
  app.post('/api/accounts/:id', async (req, reply) => {
    const id = idOf(req.params);
    if (!found(reply, id)) return { error: 'no such account' };
    const b = (req.body ?? {}) as { name?: unknown; description?: unknown };
    try {
      await brokerAccounts().rename(id, { name: b.name, description: b.description });
      return await view();
    } catch (e) { return said(reply, e); }
  });

  // Ask Delta, signed with this account's key, for the wallet: the key is known, the secret matches, this server may use it.
  app.post('/api/accounts/:id/test', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    const creds = brokerAccounts().credsOf(id);
    if (!creds) return refuse(reply, 409, { error: 'This account\'s key cannot be read any more. Add it again as a new account, then remove this one.' });
    const result = await test(creds);
    await brokerAccounts().noteTest(id, result);
    return { ...(await view()), test: { id, ...result } };
  });

  // Switch an account on or off. On, it trades: a desk of its own is started. Off, it is kept and its desk stops -- refused while it holds a position.
  app.post('/api/accounts/:id/active', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    const { active } = (req.body ?? {}) as { active?: unknown };
    if (typeof active !== 'boolean') { reply.code(400); return { error: 'active must be true or false' }; }
    try {
      if (!active) {
        const held = await holding(a);
        if (held) return refuse(reply, 409, { error: held });
        await brokerAccounts().setActive(id, false);
        closeDesk(id);
      } else {
        const now = await brokerAccounts().setActive(id, true);
        await openDesk(id);
        if (now.isDefault) setPrimaryDesk(id);
      }
      const first = brokerAccounts().default();
      if (first) setPrimaryDesk(first.id);
      return await view();
    } catch (e) { return said(reply, e); }
  });

  // Make this the default: the account whose tab opens first, and whose desk answers a request that names none. No order moves.
  app.post('/api/accounts/:id/default', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    if (a.isDefault) return await view();
    try {
      await brokerAccounts().setDefault(id);
      setPrimaryDesk(id);
      return await view();
    } catch (e) { return said(reply, e); }
  });

  /*
   * One account as Delta has it right now, read with its own key: the wallet and the positions held there.
   * For the account the desk is not trading on -- the desk's own status covers the one it is. Reads only;
   * held a few seconds so a screen left open on it is one call, not one a second.
   */
  const summaries = new Map<number, { at: number; value: Record<string, unknown> }>();
  app.get('/api/accounts/:id/summary', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    const held = summaries.get(id);
    if (held && Date.now() - held.at < 5_000) return held.value;
    const creds = brokerAccounts().credsOf(id);
    const counts = { trades: await tradingService().store.countFor(id), strategies: await strategyStore().countFor(id) };
    let value: Record<string, unknown>;
    if (!creds || !a.active) {
      value = { id, wallet: null, positions: [], ...counts, note: !creds ? 'Its key cannot be read any more.' : 'The account is switched off, so Delta is not asked.' };
    } else {
      try {
        const ex = o.summary ? null : new DeltaExchange(creds);
        const [wallet, positions] = o.summary ? await o.summary(creds) : await Promise.all([ex!.getWalletUsd(), ex!.getPositions()]);
        value = { id, wallet, positions: positions.filter((p) => p.size !== 0), ...counts, note: null };
      } catch (e) {
        value = { id, wallet: null, positions: [], ...counts, note: `Delta could not be read: ${(e as Error).message}` };
      }
    }
    summaries.set(id, { at: Date.now(), value });
    return value;
  });

  /*
   * Remove an account and its key for good -- only with a fresh authenticator code (owner, 5 Oct 2026). A
   * signed-in browser is enough to look and to switch; destroying a key is not undone by signing in again,
   * so it takes the second factor, the way a new set of recovery codes does. Never the last account, nor
   * one with history, nor the default while the desk is live on it -- each said before the code is spent.
   */
  app.post('/api/accounts/:id/remove', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    try {
      const kept = await keptBecause(a);
      if (kept) throw new AccountRefused(kept, 409);
      if (!o.auth) return refuse(reply, 409, { error: 'Sign-in is not set up on this server, so a removal cannot be confirmed.' });
      const code = (req.body as { code?: unknown } | undefined)?.code;
      if (typeof code !== 'string' || !/^\d{6}$/.test(code.replace(/\s+/g, ''))) return refuse(reply, 422, { error: 'Enter the 6-digit code from your authenticator app.' });
      const confirmed = await o.auth.confirmWithCode(tokenOf(req), code, ctxOf(req), {
        event: 'broker_account_removed',
        detail: `"${a.name}" (key ending ${a.keyHint})`,
        alert: `🔐 BTC Desk: the broker account "${a.name}" (key ending ${a.keyHint}) was removed, from ${req.ip || 'unknown'}.`,
      });
      if (!confirmed.ok) return refuse(reply, confirmed.status, { error: confirmed.error, ...(confirmed.restart ? { restart: true } : {}) });
      const held = await holding(a);
      if (held) return refuse(reply, 409, { error: held });
      closeDesk(id);
      await brokerAccounts().remove(id);
      const first = brokerAccounts().default();
      if (first) setPrimaryDesk(first.id);
      return await view();
    } catch (e) { return said(reply, e); }
  });
}
