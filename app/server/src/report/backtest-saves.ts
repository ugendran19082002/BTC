import { randomBytes } from 'node:crypto';
import { migrate, type Migration } from '../db/migrate.js';
import { one, query, rows, tx } from '../db/pool.js';
import type { BacktestParams } from './signal-backtest.js';

/**
 * Backtests kept by name, and sets of them run together (owner, 13 Oct 2026: "save a backtest's settings and run
 * a saved one; several saved ones as a portfolio, with the total of them all").
 *
 * A saved backtest is its settings -- the strike rule, the exits, the hours, the limits, the filters, or the
 * strategy it is worked by -- and not a range of days or a result: it is run over whatever days the screen is on,
 * so the same one answers "since 1 Oct" today and "the last 7 days" next week, and every one of a portfolio is run
 * over the same days. A portfolio is a name and the saved backtests in it, in order; it holds their ids, so a
 * saved one changed is changed in every portfolio it is in.
 */

/** What a saved backtest asks: the screen's own settings and filters. `strategy` is a saved strategy's id, or null. */
export type SavedQuery = { params: BacktestParams; tfs: string[]; methods: string[]; strategy: string | null };
export type BacktestSave = { id: string; name: string; query: SavedQuery; createdAt: number; updatedAt: number };
export type BacktestPortfolio = { id: string; name: string; saveIds: string[]; createdAt: number; updatedAt: number };

export const SAVE_NAME_MAX = 60;
/** Enough for anyone's ideas, few enough that the list stays a list. */
export const SAVES_MAX = 100;
export const PORTFOLIOS_MAX = 30;
/** A portfolio is at least two run together, and at most this many: each is a whole backtest. */
export const PORTFOLIO_MEMBERS_MAX = 12;

const MIGRATIONS: Migration[] = [
  {
    id: 'report-002-backtest-saves',
    up: `
      CREATE TABLE IF NOT EXISTS backtest_saves (
        id          TEXT    PRIMARY KEY,
        name        TEXT    NOT NULL,
        query       JSONB   NOT NULL,
        created_at  BIGINT  NOT NULL,
        updated_at  BIGINT  NOT NULL
      );
      -- One of a name, whatever its capitals: "5m delta" and "5M Delta" are the same thing to look for.
      CREATE UNIQUE INDEX IF NOT EXISTS backtest_saves_name ON backtest_saves (lower(name));
      CREATE TABLE IF NOT EXISTS backtest_portfolios (
        id          TEXT    PRIMARY KEY,
        name        TEXT    NOT NULL,
        save_ids    JSONB   NOT NULL,
        created_at  BIGINT  NOT NULL,
        updated_at  BIGINT  NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS backtest_portfolios_name ON backtest_portfolios (lower(name));
    `,
  },
];

let ready: Promise<void> | null = null;
export function backtestSavesSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

type SaveRow = { id: string; name: string; query: SavedQuery; created_at: number; updated_at: number };
type PortfolioRow = { id: string; name: string; save_ids: string[]; created_at: number; updated_at: number };
const saveOf = (r: SaveRow): BacktestSave => ({ id: r.id, name: r.name, query: r.query, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const portfolioOf = (r: PortfolioRow): BacktestPortfolio => ({ id: r.id, name: r.name, saveIds: r.save_ids, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });
const newId = () => randomBytes(6).toString('hex');

/** A name as it is kept, or why it cannot be one. */
export function nameProblem(raw: unknown): { name: string } | { problem: string } {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { problem: 'Give it a name.' };
  if (name.length > SAVE_NAME_MAX) return { problem: `A name is at most ${SAVE_NAME_MAX} characters.` };
  return { name };
}

export async function listSaves(): Promise<{ saves: BacktestSave[]; portfolios: BacktestPortfolio[] }> {
  await backtestSavesSchema();
  const [s, p] = await Promise.all([
    rows<SaveRow>('SELECT id, name, query, created_at, updated_at FROM backtest_saves ORDER BY lower(name)'),
    rows<PortfolioRow>('SELECT id, name, save_ids, created_at, updated_at FROM backtest_portfolios ORDER BY lower(name)'),
  ]);
  return { saves: s.map(saveOf), portfolios: p.map(portfolioOf) };
}

export async function savesByIds(ids: readonly string[]): Promise<BacktestSave[]> {
  await backtestSavesSchema();
  if (!ids.length) return [];
  const found = (await rows<SaveRow>('SELECT id, name, query, created_at, updated_at FROM backtest_saves WHERE id = ANY($1::text[])', [ids as string[]] as never)).map(saveOf);
  // In the order asked for.
  return ids.flatMap((id) => found.filter((s) => s.id === id));
}

/** Keep a backtest: a new one, or -- with its `id` -- the same one with other settings or another name. */
export async function keepSave(o: { id?: string | null; name: string; query: SavedQuery; now: number }): Promise<BacktestSave | { problem: string; status: 404 | 409 | 422 }> {
  await backtestSavesSchema();
  const taken = await one<{ id: string }>('SELECT id FROM backtest_saves WHERE lower(name) = lower($1)', [o.name]);
  if (taken && taken.id !== o.id) return { problem: `There is a saved backtest called "${o.name}" already: give this one another name, or update that one.`, status: 409 };
  if (o.id) {
    const r = await one<SaveRow>('UPDATE backtest_saves SET name = $2, query = $3, updated_at = $4 WHERE id = $1 RETURNING id, name, query, created_at, updated_at', [o.id, o.name, JSON.stringify(o.query), o.now]);
    return r ? saveOf(r) : { problem: 'That saved backtest is gone: it may have been deleted.', status: 404 };
  }
  const n = await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM backtest_saves');
  if ((n?.n ?? 0) >= SAVES_MAX) return { problem: `At most ${SAVES_MAX} saved backtests: delete one you no longer use.`, status: 422 };
  const r = await one<SaveRow>('INSERT INTO backtest_saves (id, name, query, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id, name, query, created_at, updated_at', [newId(), o.name, JSON.stringify(o.query), o.now]);
  return saveOf(r!);
}

/** Delete a saved backtest. It leaves every portfolio it was in; a portfolio left with fewer than two is deleted with it. */
export async function dropSave(id: string, now: number): Promise<{ ok: boolean; portfoliosDeleted: string[] }> {
  await backtestSavesSchema();
  return tx(async (c) => {
    const gone = await c.query('DELETE FROM backtest_saves WHERE id = $1', [id]);
    if (!gone.rowCount) return { ok: false, portfoliosDeleted: [] };
    const deleted: string[] = [];
    const ps = (await c.query<PortfolioRow>('SELECT id, name, save_ids, created_at, updated_at FROM backtest_portfolios WHERE save_ids ? $1', [id])).rows;
    for (const p of ps) {
      const left = p.save_ids.filter((x) => x !== id);
      if (left.length < 2) { await c.query('DELETE FROM backtest_portfolios WHERE id = $1', [p.id]); deleted.push(p.name); }
      else await c.query('UPDATE backtest_portfolios SET save_ids = $2, updated_at = $3 WHERE id = $1', [p.id, JSON.stringify(left), now]);
    }
    return { ok: true, portfoliosDeleted: deleted };
  });
}

export async function keepPortfolio(o: { id?: string | null; name: string; saveIds: readonly string[]; now: number }): Promise<BacktestPortfolio | { problem: string; status: 404 | 409 | 422 }> {
  await backtestSavesSchema();
  const ids = [...new Set(o.saveIds)];
  if (ids.length < 2) return { problem: 'A portfolio is two saved backtests or more, run together.', status: 422 };
  if (ids.length > PORTFOLIO_MEMBERS_MAX) return { problem: `A portfolio is at most ${PORTFOLIO_MEMBERS_MAX} saved backtests.`, status: 422 };
  if ((await savesByIds(ids)).length !== ids.length) return { problem: 'One of those saved backtests is gone: it may have been deleted.', status: 422 };
  const taken = await one<{ id: string }>('SELECT id FROM backtest_portfolios WHERE lower(name) = lower($1)', [o.name]);
  if (taken && taken.id !== o.id) return { problem: `There is a portfolio called "${o.name}" already.`, status: 409 };
  if (o.id) {
    const r = await one<PortfolioRow>('UPDATE backtest_portfolios SET name = $2, save_ids = $3, updated_at = $4 WHERE id = $1 RETURNING id, name, save_ids, created_at, updated_at', [o.id, o.name, JSON.stringify(ids), o.now]);
    return r ? portfolioOf(r) : { problem: 'That portfolio is gone: it may have been deleted.', status: 404 };
  }
  const n = await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM backtest_portfolios');
  if ((n?.n ?? 0) >= PORTFOLIOS_MAX) return { problem: `At most ${PORTFOLIOS_MAX} portfolios: delete one you no longer use.`, status: 422 };
  const r = await one<PortfolioRow>('INSERT INTO backtest_portfolios (id, name, save_ids, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id, name, save_ids, created_at, updated_at', [newId(), o.name, JSON.stringify(ids), o.now]);
  return portfolioOf(r!);
}

export async function dropPortfolio(id: string): Promise<boolean> {
  await backtestSavesSchema();
  return Boolean((await query('DELETE FROM backtest_portfolios WHERE id = $1', [id])).rowCount);
}
