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

/**
 * Where databases go when nothing says otherwise.
 *
 * In a container the repository root is read-only and the writable volume is
 * wherever CHAIN_DB points, so that directory is the better default than the
 * root the module happens to sit under. Getting this wrong does not degrade
 * gracefully -- sqlite refuses to open the file and the process does not start.
 */
const DATA_DIR = process.env.CHAIN_DB ? dirname(process.env.CHAIN_DB) : ROOT;

/** Where the trade journal is written. Separate file: market data is disposable,
 * an order history is not. */
export const TRADE_DB = process.env.TRADE_DB ?? join(DATA_DIR, 'trades.db');
/** Failures from the server, the browser and the exchange, in time order. */
export const ERROR_DB = process.env.ERROR_DB ?? join(DATA_DIR, 'errors.db');
/**
 * The login: the password hash, the sealed authenticator secret, sessions and
 * the security log. Its own file, so the trade journal can be copied to look at
 * without carrying the credentials with it.
 */
export const AUTH_DB = process.env.AUTH_DB ?? join(DATA_DIR, 'auth.db');
