import { migrate, moveToPublic, type Migration } from './migrate.js';
import { query, rows } from './pool.js';

/**
 * Desk settings that must outlive a restart: the mode, the default expiry, the
 * short cap, the auto-trade block, whether alerts are on.
 *
 * They are read *synchronously*, everywhere, and often — `service.ts` reads the
 * mode and the cap inside getters that the gates call on every order, and a
 * gate that had to await its own configuration would push `async` through
 * every sync path in the engine for the sake of a dozen strings.
 *
 * So the table is loaded once at boot and kept in memory, and every write goes
 * to the database *first* and the cache second. The process is the only
 * writer, so the cache cannot go stale; and because the write is awaited, a
 * setting the screen was told is saved is saved. Two stores used to open the
 * same `settings` table on two connections; this is the one copy.
 */
export interface Settings {
  get(key: string): string | null;
  set(key: string, value: string): Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    id: 'trading-001-settings',
    up: `
      CREATE SCHEMA IF NOT EXISTS trading;
      CREATE TABLE IF NOT EXISTS trading.settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // The desk defaults to the first listed expiry (nearest active contract)
    // rather than the next-entry contract. Persisted so the choice survives
    // a restart and can be changed through /api/settings.
    id: 'trading-002-default-settings',
    up: `INSERT INTO trading.settings (key, value) VALUES ('expiry_default', 'first') ON CONFLICT (key) DO NOTHING;`,
  },  {
    /*
     * Every table in one schema, public, on the owner's request (19 Sep 2026):
     * one list in a console instead of seven. Names carry their area as a
     * prefix where a bare name would be ambiguous in one namespace.
     */
    id: 'trading-005-settings-to-public',
    up: moveToPublic([['trading.settings', 'settings']]),
  },
];

export class SettingsCache implements Settings {
  private values = new Map<string, string>();
  private loaded = false;
  /** Ids applied by `load()`. For the health endpoint. */
  applied: string[] = [];

  /** Migrate the table and read every row. Call once, before anything reads. */
  async load(): Promise<this> {
    this.applied = await migrate(MIGRATIONS);
    const all = await rows<{ key: string; value: string }>('SELECT key, value FROM settings');
    this.values = new Map(all.map((r) => [r.key, r.value]));
    this.loaded = true;
    return this;
  }

  get(key: string): string | null {
    if (!this.loaded) {
      // A read before the load would return null for everything, which for
      // `mode` means "paper" and for the cap means "the default" -- both
      // plausible, both wrong. Better to fail where it can be seen.
      throw new Error(`settings read ("${key}") before load()`);
    }
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
    this.values.set(key, value);
  }

  /** Every key, for diagnostics. */
  keys(): string[] { return [...this.values.keys()].sort(); }
}

/** For tests: the same contract, nothing behind it. */
export class MemorySettings implements Settings {
  private values = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.values.set(k, v);
  }
  get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
}

let singleton: SettingsCache | null = null;

/** The process's settings. `load()` it once at boot; every store shares it. */
export const settings = (): SettingsCache => (singleton ??= new SettingsCache());

/** For tests that want a fresh cache against a fresh database. */
export function resetSettings(): void { singleton = null; }
