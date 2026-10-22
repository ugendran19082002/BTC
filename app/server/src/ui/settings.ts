import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows } from '../db/pool.js';

/**
 * The screen's own choices, kept by the desk (22 Oct 2026, owner: "what I choose in the backtest and the portfolio --
 * keep it on the database side; I cannot set it all again every time"; "collapse and expand the same").
 *
 * They were the browser's alone (localStorage): set on the desk, gone on the phone; gone with the site's data; set
 * again in every browser. Now each is one row -- a key the screen names, its value as JSON, when it was last set --
 * and every browser opens on the same. The screen still keeps a copy of its own, so it opens at once and works when
 * the server does not answer; the newer of the two wins.
 *
 * Choices, never secrets or orders: nothing here changes what the desk trades. A key is the screen's own name for the
 * choice (`KEY`), a value at most `MAX_VALUE_BYTES` of JSON.
 */
const MIGRATIONS: Migration[] = [
  {
    id: 'ui-001-settings',
    up: `
      CREATE TABLE IF NOT EXISTS ui_settings (
        key        TEXT   PRIMARY KEY,
        value      JSONB  NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `,
  },
];

/** A key: the screen's dotted name for a choice -- `signalBacktest.params`, `report:from` -- and nothing else. */
export const KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,99}$/;
export const MAX_VALUE_BYTES = 64 * 1024;
/** The most keys there may be: a screen's choices are dozens, and a runaway loop is not a reason to fill the table. */
export const MAX_KEYS = 500;

export type UiSetting = { value: unknown; updatedAt: number };

export class UiSettings {
  readonly ready: Promise<void>;
  constructor() { this.ready = migrate(MIGRATIONS).then(() => {}); }

  async all(): Promise<Record<string, UiSetting>> {
    await this.ready;
    const r = await rows<{ key: string; value: unknown; updated_at: number }>('SELECT key, value, updated_at FROM ui_settings');
    return Object.fromEntries(r.map((x) => [x.key, { value: x.value, updatedAt: Number(x.updated_at) }]));
  }

  /**
   * One choice set. `at`: when the screen made it -- the later of two sets wins, so a tab left open with an old choice
   * does not undo one made since on another device. Returns what is kept.
   */
  async set(key: string, value: unknown, at = Date.now()): Promise<UiSetting> {
    await this.ready;
    const r = await one<{ value: unknown; updated_at: number }>(
      `INSERT INTO ui_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
         WHERE ui_settings.updated_at <= EXCLUDED.updated_at
       RETURNING value, updated_at`,
      [key, JSON.stringify(value), at],
    );
    if (r) return { value: r.value, updatedAt: Number(r.updated_at) };
    // An older set than the one kept: the one kept stands, and is said.
    const kept = await one<{ value: unknown; updated_at: number }>('SELECT value, updated_at FROM ui_settings WHERE key = $1', [key]);
    return { value: kept!.value, updatedAt: Number(kept!.updated_at) };
  }

  async count(): Promise<number> {
    await this.ready;
    return Number((await one<{ n: number }>('SELECT count(*)::int AS n FROM ui_settings'))?.n ?? 0);
  }

  /** A choice gone back to its default: the row removed, so every screen opens on the default too. */
  async remove(key: string): Promise<void> {
    await this.ready;
    await query('DELETE FROM ui_settings WHERE key = $1', [key]);
  }
}

let singleton: UiSettings | null = null;
export const uiSettings = (): UiSettings => (singleton ??= new UiSettings());
