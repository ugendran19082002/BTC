/**
 * Every database a test touches goes to a fresh temp directory.
 *
 * Preloaded with `--import` so it runs before any test module is evaluated,
 * which is the whole point: four test files used to set `ERROR_DB` themselves,
 * and every other file that made the exchange refuse an order wrote the
 * refusal into the desk's real `errors.db`. Two rows in the live log with 72
 * folded occurrences between them turned out to be `client_order_id:
 * "abc123E0"` — a fixture — and a stack ending in `node:assert`.
 *
 * That is worse than untidy. The error log is the one place a real failure is
 * supposed to be findable, and a suite that files 3 more refusals into it on
 * every run is how a real one gets scrolled past.
 *
 * `??=` rather than `=`, so a test file that wants its own path still gets it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'btc-desk-test-'));

process.env.ERROR_DB ??= join(dir, 'errors.db');
process.env.TRADE_DB ??= join(dir, 'trades.db');
process.env.AUTH_DB ??= join(dir, 'auth.db');
