import type { FastifyInstance, FastifyReply } from 'fastify';
import { AccountRefused, brokerAccounts, MAX_ACCOUNTS, testConnection, type BrokerAccount, type Tester } from '../../delta/accounts.js';
import { tradingService } from '../../trading/service.js';
import { noteError } from '../../observability/errors.js';
import { refuse } from '../refuse.js';

/**
 * The broker accounts (Logs -> Accounts): add, name, test, switch on and off,
 * choose the default, remove.
 *
 * No route here ever answers with a key or a secret -- only the key's last four
 * characters. A rule holding (the desk is live on this account; the key fails
 * its test) is answered with its sentence through `refuse`, so it stays out of
 * the error log.
 *
 * Whatever changes which key live orders are signed with goes through
 * `follow`: the desk is asked first whether it may change (never under a live
 * position), then the table is written, then the desk is told.
 */

/** Once a day the table is read again; a default changed underneath is followed only when the desk may. */
export async function refreshBrokerAccounts(): Promise<void> {
  const accounts = brokerAccounts();
  const { defaultChanged } = await accounts.refresh();
  if (!defaultChanged) return;
  const svc = tradingService();
  const creds = accounts.defaultCreds();
  const blocked = await svc.accountSwitchBlocked(creds === null);
  if (blocked) {
    noteError({ source: 'server', level: 'warn', where: 'broker-accounts', message: `the default broker account changed in the database and is not followed: ${blocked}` });
    return;
  }
  svc.setLiveCreds(creds);
}

export function registerAccountRoutes(app: FastifyInstance, o: { test?: Tester } = {}): void {
  const test = o.test ?? testConnection;

  const view = () => {
    const accounts = brokerAccounts();
    const svc = tradingService();
    return {
      accounts: accounts.list(),
      max: MAX_ACCOUNTS,
      /** False without DESK_SESSION_SECRET: a key cannot be encrypted, so none can be added. */
      canStore: accounts.canStore,
      mode: svc.mode,
    };
  };
  /** A rule's "no" as its own status and sentence; anything else is a fault and is thrown on. */
  const said = (reply: FastifyReply, e: unknown) => {
    if (e instanceof AccountRefused) return refuse(reply, e.status, { error: e.message });
    throw e;
  };
  const idOf = (params: unknown): number => Number((params as { id?: string }).id);
  const found = (reply: FastifyReply, id: number): BrokerAccount | null => {
    const a = Number.isInteger(id) ? brokerAccounts().get(id) : null;
    if (!a) { reply.code(404); return null; }
    return a;
  };
  /** The desk signs as whatever the default now is. Asked before the write, told after it. */
  const follow = async (reply: FastifyReply, toNone: boolean, write: () => Promise<unknown>) => {
    const svc = tradingService();
    const blocked = await svc.accountSwitchBlocked(toNone);
    if (blocked) return refuse(reply, 409, { error: blocked });
    await write();
    svc.setLiveCreds(brokerAccounts().defaultCreds());
    return view();
  };

  // Every saved account -- name, description, the key's last four, whether it is on, the default, its last test.
  app.get('/api/accounts', async () => view());

  // Save an account: the key and the secret are encrypted here and never sent back. The first one becomes the default.
  app.post('/api/accounts', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: unknown; description?: unknown; api_key?: unknown; api_secret?: unknown };
    try {
      const accounts = brokerAccounts();
      const first = accounts.default() === null;
      const a = await accounts.create({ name: b.name, description: b.description, apiKey: b.api_key, apiSecret: b.api_secret });
      // Tested as it is saved, so the row says at once whether the key works; saved either way (an IP not yet whitelisted is fixed on Delta).
      const creds = accounts.credsOf(a.id);
      if (creds) await accounts.noteTest(a.id, await test(creds));
      // The first account is the default: on paper nothing moves, and live was not reachable without one.
      if (first && a.isDefault) tradingService().setLiveCreds(accounts.defaultCreds());
      return view();
    } catch (e) { return said(reply, e); }
  });

  // Rename an account or change its description. The key is not edited: remove the account and add it again.
  app.post('/api/accounts/:id', async (req, reply) => {
    const id = idOf(req.params);
    if (!found(reply, id)) return { error: 'no such account' };
    const b = (req.body ?? {}) as { name?: unknown; description?: unknown };
    try {
      await brokerAccounts().rename(id, { name: b.name, description: b.description });
      return view();
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
    return { ...view(), test: { id, ...result } };
  });

  // Switch an account on or off. Off, it is kept but cannot be used; the default cannot be switched off while the desk is live on it. Switched on with no default, it is the default.
  app.post('/api/accounts/:id/active', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    const { active } = (req.body ?? {}) as { active?: unknown };
    if (typeof active !== 'boolean') { reply.code(400); return { error: 'active must be true or false' }; }
    try {
      if (a.isDefault && !active) return await follow(reply, true, () => brokerAccounts().setActive(id, false));
      // On again with no default anywhere: it becomes the one the desk signs as.
      if (active && !a.active && brokerAccounts().default() === null) return await follow(reply, false, () => brokerAccounts().setActive(id, true));
      await brokerAccounts().setActive(id, active);
      return view();
    } catch (e) { return said(reply, e); }
  });

  // Make this the account the desk trades on. Its key is tested first; refused while a live position is open.
  app.post('/api/accounts/:id/default', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    if (a.isDefault) return view();
    try {
      const accounts = brokerAccounts();
      const creds = accounts.credsOf(id);
      if (!creds) throw new AccountRefused('This account\'s key cannot be read any more. Add it again as a new account, then remove this one.', 409);
      if (!a.active) throw new AccountRefused('Activate the account first.', 409);
      // A default that cannot sign is a desk that cannot trade: the key has to work now, not last week.
      const result = await test(creds);
      await accounts.noteTest(id, result);
      if (!result.ok) return refuse(reply, 422, { ...view(), error: `Not made the default: its connection test failed. ${result.detail}` });
      return await follow(reply, false, () => accounts.setDefault(id));
    } catch (e) { return said(reply, e); }
  });

  // Remove an account and its key for good. Never the last one -- that is switched off instead -- nor the default while the desk is live on it.
  app.delete('/api/accounts/:id', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    try {
      // Said first: "switch to paper" would only lead to this answer.
      const kept = brokerAccounts().removalBlocked(id);
      if (kept) throw new AccountRefused(kept, 409);
      if (a.isDefault) return await follow(reply, true, () => brokerAccounts().remove(id));
      await brokerAccounts().remove(id);
      return view();
    } catch (e) { return said(reply, e); }
  });
}
