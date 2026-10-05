import type { FastifyInstance, FastifyReply } from 'fastify';
import { AccountRefused, brokerAccounts, envKeyLeft, MAX_ACCOUNTS, testConnection, type BrokerAccount, type Tester } from '../../delta/accounts.js';
import { tradingService } from '../../trading/service.js';
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
  svc.setLiveCreds(creds, accounts.default()?.id ?? null);
}

export type AccountSummaryReader = (creds: { key: string; secret: string }) => Promise<[{ balance: number; available: number }, ExchangePosition[]]>;

export function registerAccountRoutes(app: FastifyInstance, o: { test?: Tester; summary?: AccountSummaryReader; auth?: AuthService } = {}): void {
  const test = o.test ?? testConnection;

  const view = async () => {
    const accounts = brokerAccounts();
    const svc = tradingService();
    return {
      // Each with why it cannot be removed, when it cannot: said on the screen before a code is asked for.
      accounts: await Promise.all(accounts.list().map(async (a) => ({ ...a, keptBecause: await keptBecause(a) }))),
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
  const counted = new Map<number, { at: number; trades: number; strategies: number }>();
  const historyOf = async (id: number, fresh = false): Promise<string | null> => {
    // For the list, held ten seconds: it is polled, and the answer changes when a trade or a strategy is made.
    // For a removal, always read now.
    let c = counted.get(id);
    if (fresh || !c || Date.now() - c.at > 10_000) {
      const [t, s] = await Promise.all([tradingService().store.countFor(id), strategyStore().countFor(id)]);
      c = { at: Date.now(), trades: t, strategies: s };
      counted.set(id, c);
    }
    const { trades, strategies } = c;
    if (trades === 0 && strategies === 0) return null;
    const has = [trades ? `${trades} ${trades === 1 ? 'trade' : 'trades'}` : '', strategies ? `${strategies} ${strategies === 1 ? 'strategy' : 'strategies'}` : ''].filter(Boolean).join(' and ');
    return `This account has ${has} on record, so it is kept. Deactivate it instead.`;
  };
  /** Why an account cannot be removed right now, or null: the last one, one with history, the one the desk is live on. */
  const keptBecause = async (a: BrokerAccount, fresh = false): Promise<string | null> =>
    brokerAccounts().removalBlocked(a.id) ?? await historyOf(a.id, fresh) ?? (a.isDefault ? await tradingService().accountSwitchBlocked(true) : null);
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
    svc.setLiveCreds(brokerAccounts().defaultCreds(), brokerAccounts().default()?.id ?? null);
    return await view();
  };

  // Every saved account -- name, description, the key's last four, whether it is on, the default, its last test.
  app.get('/api/accounts', async () => await view());

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
      if (first && a.isDefault) tradingService().setLiveCreds(accounts.defaultCreds(), accounts.default()?.id ?? null);
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
      return await view();
    } catch (e) { return said(reply, e); }
  });

  // Make this the account the desk trades on. Its key is tested first; refused while a live position is open.
  app.post('/api/accounts/:id/default', async (req, reply) => {
    const id = idOf(req.params);
    const a = found(reply, id);
    if (!a) return { error: 'no such account' };
    if (a.isDefault) return await view();
    try {
      const accounts = brokerAccounts();
      const creds = accounts.credsOf(id);
      if (!creds) throw new AccountRefused('This account\'s key cannot be read any more. Add it again as a new account, then remove this one.', 409);
      if (!a.active) throw new AccountRefused('Activate the account first.', 409);
      // A default that cannot sign is a desk that cannot trade: the key has to work now, not last week.
      const result = await test(creds);
      await accounts.noteTest(id, result);
      if (!result.ok) return refuse(reply, 422, { ...(await view()), error: `Not made the default: its connection test failed. ${result.detail}` });
      return await follow(reply, false, () => accounts.setDefault(id));
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
      const kept = await keptBecause(a, true);
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
      if (a.isDefault) return await follow(reply, true, () => brokerAccounts().remove(id));
      await brokerAccounts().remove(id);
      return await view();
    } catch (e) { return said(reply, e); }
  });
}
