import { query, rows, tx } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import { Secrets } from '../auth/secrets.js';
import type { Settings } from '../db/settings.js';
import { DeltaRefused, RateLimited, RequestTimedOut, signed, UnreadableReply, type Creds } from './signed.js';

/**
 * The broker accounts: whose API key the desk signs with (owner, 5 Oct 2026).
 *
 * The key lived in `.env`: one account, changed by editing a file and restarting
 * a desk that may be holding positions. Now the accounts are rows -- a name, a
 * description, the key -- kept, tested, switched and removed from the screen
 * (Logs -> Accounts), and the desk trades on the one marked default.
 *
 * Safe, in this order:
 *   - The key and the secret are sealed (AES-256-GCM) under a key derived from
 *     DESK_SESSION_SECRET, which is in the environment and never in the
 *     database: a dump of this table on its own signs nothing. Nothing here
 *     ever hands either back -- the screen gets the key's last four characters.
 *   - A row that will not open (the master secret was rotated) is shown as
 *     unreadable and never used; its key is entered again.
 *   - At most one default, held by a unique index rather than by a check.
 *   - The last account is never removed, only switched off (owner, 5 Oct 2026):
 *     a desk that has had an account always has one to switch back on, and a
 *     key is replaced by adding the new one first and removing the old second.
 *
 * Read like the settings: the table is loaded into memory once at start and the
 * process is its only writer, so every change is written first and the memory
 * updated second, and a signed request never waits on the database. It is read
 * again once a day (index.ts), for a row changed by hand in a console.
 *
 * `.env`'s DELTA_API_KEY / DELTA_API_SECRET are read once: the first start with
 * no account imports them as the default, so a desk holding live positions
 * comes up on the same account it went down on. After that they are not read,
 * and the key is not kept in `.env`: the two lines are emptied once it is here.
 */

export const MAX_ACCOUNTS = 5;
const ENV_IMPORTED = 'broker_env_imported';

export type AccountTest = { at: number; ok: boolean; detail: string };

/** An account as the screen may see it: never the key, never the secret. */
export type BrokerAccount = {
  id: number;
  name: string;
  description: string;
  broker: 'delta-india';
  /** The key's last four characters, to tell two accounts apart. */
  keyHint: string;
  active: boolean;
  isDefault: boolean;
  /** False when the key was sealed under another DESK_SESSION_SECRET: it cannot be used, only removed. */
  readable: boolean;
  createdAt: number;
  updatedAt: number;
  lastTest: AccountTest | null;
};

/** A person's mistake or a rule holding: answered plainly, not a fault. `status` is the HTTP answer. */
export class AccountRefused extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422 = 422) {
    super(message);
    this.name = 'AccountRefused';
  }
}

const MIGRATIONS: Migration[] = [{
  id: 'broker-001-accounts',
  up: `
    CREATE TABLE IF NOT EXISTS broker_accounts (
      id                BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name              TEXT    NOT NULL,
      description       TEXT    NOT NULL DEFAULT '',
      broker            TEXT    NOT NULL DEFAULT 'delta-india' CHECK (broker IN ('delta-india')),
      api_key_sealed    TEXT    NOT NULL,
      api_secret_sealed TEXT    NOT NULL,
      key_hint          TEXT    NOT NULL,
      active            BOOLEAN NOT NULL DEFAULT true,
      is_default        BOOLEAN NOT NULL DEFAULT false,
      created_at        BIGINT  NOT NULL,
      updated_at        BIGINT  NOT NULL,
      last_test_at      BIGINT,
      last_test_ok      BOOLEAN,
      last_test_detail  TEXT,
      -- The default is one the desk can use.
      CONSTRAINT broker_accounts_default_active CHECK (active OR NOT is_default)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS broker_accounts_one_default ON broker_accounts (is_default) WHERE is_default;
    CREATE UNIQUE INDEX IF NOT EXISTS broker_accounts_by_name ON broker_accounts (lower(name));
  `,
}];

type Row = {
  id: string; name: string; description: string; broker: 'delta-india';
  api_key_sealed: string; api_secret_sealed: string; key_hint: string;
  active: boolean; is_default: boolean; created_at: string; updated_at: string;
  last_test_at: string | null; last_test_ok: boolean | null; last_test_detail: string | null;
};
/** A row in memory: the public view, and the credentials when they open. */
type Held = { view: BrokerAccount; creds: Creds | null };

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
/** A pasted key: no spaces, no line breaks, and a sane length. */
const credential = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, '') : '');

export type NewAccount = { name: unknown; description?: unknown; apiKey: unknown; apiSecret: unknown };

export class BrokerAccounts {
  private held: Held[] = [];
  private loaded = false;

  constructor(private readonly d: { secrets: Secrets | null; now?: () => number }) {}

  private now(): number { return (this.d.now ?? Date.now)(); }
  /** False without DESK_SESSION_SECRET: nothing can be sealed, so no account can be kept or used. */
  get canStore(): boolean { return this.d.secrets !== null; }

  /**
   * Migrate, import `.env`'s key the first time, and read every row into memory.
   * `seed` is `.env`'s pair; `settings` remembers that the import has happened,
   * so an account removed on the screen does not come back at the next start.
   */
  async load(o: { seed?: Creds | null; settings?: Settings } = {}): Promise<this> {
    await migrate(MIGRATIONS);
    await this.refresh();
    if (o.seed && this.d.secrets && this.held.length === 0 && o.settings?.get(ENV_IMPORTED) !== '1') {
      await this.insert({ name: 'Delta India (from .env)', description: 'Imported from DELTA_API_KEY in .env at the first start.', ...o.seed, isDefault: true });
      await o.settings?.set(ENV_IMPORTED, '1');
      await this.refresh();
    }
    return this;
  }

  /** Read the table again. Returns whether the default's credentials are no longer the ones held before. */
  async refresh(): Promise<{ defaultChanged: boolean }> {
    const before = this.loaded ? this.defaultCreds() : null;
    const xs = await rows<Row>('SELECT * FROM broker_accounts ORDER BY id');
    this.held = xs.map((x) => this.hold(x));
    const wasLoaded = this.loaded;
    this.loaded = true;
    const after = this.defaultCreds();
    return { defaultChanged: wasLoaded && (before?.key !== after?.key || before?.secret !== after?.secret) };
  }

  private hold(x: Row): Held {
    let creds: Creds | null = null;
    try {
      if (this.d.secrets) creds = { key: this.d.secrets.open(x.api_key_sealed), secret: this.d.secrets.open(x.api_secret_sealed) };
    } catch { creds = null; }
    return {
      creds,
      view: {
        id: Number(x.id), name: x.name, description: x.description, broker: x.broker, keyHint: x.key_hint,
        active: x.active, isDefault: x.is_default, readable: creds !== null,
        createdAt: Number(x.created_at), updatedAt: Number(x.updated_at),
        lastTest: x.last_test_at === null ? null
          : { at: Number(x.last_test_at), ok: x.last_test_ok === true, detail: x.last_test_detail ?? '' },
      },
    };
  }

  /** Every account, oldest first, from memory. */
  list(): BrokerAccount[] { return this.held.map((h) => h.view); }
  get(id: number): BrokerAccount | null { return this.held.find((h) => h.view.id === id)?.view ?? null; }
  /** The account the desk trades on, or null. */
  default(): BrokerAccount | null { return this.held.find((h) => h.view.isDefault)?.view ?? null; }
  /** What live orders are signed with: the default account's key, when it is active and opens. */
  defaultCreds(): Creds | null {
    const h = this.held.find((x) => x.view.isDefault && x.view.active);
    return h?.creds ?? null;
  }
  /** One account's key, for testing its connection. Never leaves the server. */
  credsOf(id: number): Creds | null { return this.held.find((h) => h.view.id === id)?.creds ?? null; }

  private need(id: number): BrokerAccount {
    const a = this.get(id);
    if (!a) throw new AccountRefused('No such account.', 404);
    return a;
  }

  private async insert(a: { name: string; description: string; key: string; secret: string; isDefault: boolean }): Promise<number> {
    if (!this.d.secrets) throw new AccountRefused('DESK_SESSION_SECRET is not set on the server, so a key cannot be encrypted and is not kept.', 409);
    const at = this.now();
    const r = await query<{ id: string }>(
      `INSERT INTO broker_accounts (name, description, api_key_sealed, api_secret_sealed, key_hint, is_default, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [a.name, a.description, this.d.secrets.seal(a.key), this.d.secrets.seal(a.secret), a.key.slice(-4), a.isDefault, at],
    );
    return Number(r.rows[0]!.id);
  }

  /** Keep a new account. The first one is the default; a later one is not until it is chosen. */
  async create(input: NewAccount): Promise<BrokerAccount> {
    const name = clean(input.name, 40);
    const description = clean(input.description, 200);
    const key = credential(input.apiKey), secret = credential(input.apiSecret);
    if (!name) throw new AccountRefused('Give the account a name.');
    if (key.length < 8 || key.length > 200) throw new AccountRefused('That does not look like an API key.');
    if (secret.length < 16 || secret.length > 400) throw new AccountRefused('That does not look like an API secret.');
    if (this.held.length >= MAX_ACCOUNTS) throw new AccountRefused(`At most ${MAX_ACCOUNTS} accounts. Remove one first.`, 409);
    if (this.held.some((h) => h.view.name.toLowerCase() === name.toLowerCase())) throw new AccountRefused(`There is already an account named "${name}".`, 409);
    if (this.held.some((h) => h.creds?.key === key)) throw new AccountRefused('This API key is already saved as an account.', 409);
    const id = await this.insert({ name, description, key, secret, isDefault: this.default() === null });
    await this.refresh();
    return this.need(id);
  }

  /** The name and the description. A key is not edited: remove the account and add it again. */
  async rename(id: number, input: { name?: unknown; description?: unknown }): Promise<BrokerAccount> {
    const a = this.need(id);
    const name = input.name === undefined ? a.name : clean(input.name, 40);
    const description = input.description === undefined ? a.description : clean(input.description, 200);
    if (!name) throw new AccountRefused('Give the account a name.');
    if (this.held.some((h) => h.view.id !== id && h.view.name.toLowerCase() === name.toLowerCase())) throw new AccountRefused(`There is already an account named "${name}".`, 409);
    await query('UPDATE broker_accounts SET name = $2, description = $3, updated_at = $4 WHERE id = $1', [id, name, description, this.now()]);
    await this.refresh();
    return this.need(id);
  }

  /**
   * Switch an account on or off. Off, it is kept and cannot be the default. Switched on while there is no
   * default at all, it is the default -- as the first account is -- so the only account comes back in one tap.
   */
  async setActive(id: number, active: boolean): Promise<BrokerAccount> {
    const a = this.need(id);
    const takesDefault = active && a.readable && this.default() === null;
    await query('UPDATE broker_accounts SET active = $2, is_default = (is_default AND $2) OR $3, updated_at = $4 WHERE id = $1',
      [id, active, takesDefault, this.now()]);
    await this.refresh();
    return this.need(id);
  }

  /** Make one account the default, in one transaction, so there is never two and never a moment with the wrong one. */
  async setDefault(id: number): Promise<BrokerAccount> {
    const a = this.need(id);
    if (!a.readable) throw new AccountRefused('This account\'s key cannot be read any more (DESK_SESSION_SECRET changed). Add it again as a new account, then remove this one.', 409);
    if (!a.active) throw new AccountRefused('Activate the account first.', 409);
    const at = this.now();
    await tx(async (c) => {
      await c.query('UPDATE broker_accounts SET is_default = false, updated_at = $2 WHERE is_default AND id <> $1', [id, at]);
      await c.query('UPDATE broker_accounts SET is_default = true, updated_at = $2 WHERE id = $1', [id, at]);
    });
    await this.refresh();
    return this.need(id);
  }

  /** Why this account cannot be removed, or null. The last one is kept: it is switched off instead. */
  removalBlocked(id: number): string | null {
    this.need(id);
    return this.held.length === 1 ? 'This is the only account, and the last one is kept. Deactivate it instead.' : null;
  }

  /** Remove an account and its key for good -- never the last one. */
  async remove(id: number): Promise<void> {
    const blocked = this.removalBlocked(id);
    if (blocked) throw new AccountRefused(blocked, 409);
    await query('DELETE FROM broker_accounts WHERE id = $1', [id]);
    await this.refresh();
  }

  /** What the last connection test said, kept beside the account. */
  async noteTest(id: number, t: { ok: boolean; detail: string }): Promise<BrokerAccount> {
    this.need(id);
    await query('UPDATE broker_accounts SET last_test_at = $2, last_test_ok = $3, last_test_detail = $4 WHERE id = $1',
      [id, this.now(), t.ok, t.detail.slice(0, 300)]);
    await this.refresh();
    return this.need(id);
  }
}

/** What Delta's refusal of a signed read means, in words a person can act on. The code is kept beside it. */
function refusalInWords(code: string): string {
  const c = code.toLowerCase();
  if (c.includes('ip')) return 'Delta refused this server\'s IP address. Add it to the key\'s whitelist on Delta.';
  if (c.includes('signature')) return 'The API secret does not match the key.';
  if (c.includes('invalid_api_key') || c.includes('api_key')) return 'Delta does not know this API key.';
  if (c.includes('unauthorized') || c.includes('forbidden') || c.includes('permission')) return 'The key is not allowed to read the account. Check its permissions on Delta.';
  return 'Delta refused the key.';
}

export type ConnectionTest = { ok: boolean; detail: string };
export type Tester = (creds: Creds) => Promise<ConnectionTest>;

/** One signed read of the wallet: the key is known, the secret matches, this server may use it. Sends no order. */
export const testConnection: Tester = async (creds) => {
  try {
    const wallet = await signed<{ asset_symbol?: string; balance?: string }[]>(creds, { method: 'GET', path: '/v2/wallet/balances', timeoutMs: 10_000 });
    const usd = wallet.find((b) => b.asset_symbol === 'USD' || b.asset_symbol === 'USDT');
    const balance = Number(usd?.balance);
    return { ok: true, detail: Number.isFinite(balance) ? `Connected. Wallet balance $${balance.toFixed(2)}.` : 'Connected.' };
  } catch (e) {
    if (e instanceof DeltaRefused) return { ok: false, detail: `${refusalInWords(e.code)} (${e.code})` };
    if (e instanceof RateLimited) return { ok: false, detail: 'Delta is rate-limiting this server. Try again in a moment.' };
    if (e instanceof RequestTimedOut) return { ok: false, detail: 'No answer from Delta. Try again.' };
    if (e instanceof UnreadableReply) return { ok: false, detail: 'Delta\'s answer could not be read. Try again.' };
    return { ok: false, detail: 'The test could not be run.' };
  }
};

/** `.env`'s pair, read for the one-time import only. */
function envSeed(): Creds | null {
  const key = process.env.DELTA_API_KEY?.trim();
  const secret = process.env.DELTA_API_SECRET?.trim();
  return key && secret ? { key, secret } : null;
}

let singleton: BrokerAccounts | null = null;

/** Build the process's accounts: migrated, `.env` imported once, read into memory. Called at boot, before the desk. */
export async function initBrokerAccounts(settings: Settings): Promise<BrokerAccounts> {
  if (singleton) return singleton;
  const master = process.env.DESK_SESSION_SECRET?.trim() ?? '';
  const secrets = master ? new Secrets(master, 'btc-desk/broker-account/v1') : null;
  singleton = await new BrokerAccounts({ secrets }).load({ seed: envSeed(), settings });
  return singleton;
}

/** The accounts, once `initBrokerAccounts()` has run (it runs inside `initTradingService()`). */
export const brokerAccounts = (): BrokerAccounts => {
  if (!singleton) throw new Error('brokerAccounts() before initBrokerAccounts(): the accounts are loaded at boot');
  return singleton;
};
