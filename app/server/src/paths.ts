import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where the data lives, resolved once.
 *
 * Walking up to find the marker rather than counting `..` segments means moving
 * a module into a subfolder cannot silently point the whole backtest at an empty
 * database -- which is exactly what a hard-coded depth does when the tests still
 * pass because they read an empty file without complaining.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'chain.db')) || existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

export const ROOT = repoRoot();
export const CHAIN_DB = process.env.CHAIN_DB ?? join(ROOT, 'chain.db');

/*
 * The desk's own data -- trades, strategies, settings, sign-in, the error log,
 * open-interest history -- is in PostgreSQL (`DATABASE_URL`, see db/pool.ts),
 * not in files beside this one. `chain.db` is the one SQLite file left: the
 * harvester's read-only dataset, shipped whole by deploy/refresh.sh.
 */
