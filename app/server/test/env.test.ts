import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_DB, TRADE_DB, AUTH_DB } from '../src/paths.js';

/**
 * The suite must not write into the desk's own databases.
 *
 * It did, for two days. `test/env.ts` sets the three paths to a temp directory
 * before any test module loads; before it existed, four files set `ERROR_DB`
 * themselves and every other file that made the exchange refuse an order filed
 * that refusal into the real `errors.db`. The live log carried two rows with 72
 * folded occurrences between them, both fixtures — `client_order_id`
 * "abc123E0", stack ending in `node:assert`.
 *
 * The cost is not tidiness. The error log is where a real failure is supposed
 * to be findable, and three more fake refusals per run is how a real one gets
 * scrolled past.
 */

const repo = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');

for (const [name, path] of [['ERROR_DB', ERROR_DB], ['TRADE_DB', TRADE_DB], ['AUTH_DB', AUTH_DB]] as const) {
  test(`[critical] ${name} points outside the repository while testing`, () => {
    assert.ok(
      !path.startsWith(repo),
      `${name} is ${path}, inside ${repo} — the suite would write to the desk's own database. ` +
      'Is test/env.ts still preloaded? See the "test" script in package.json.',
    );
  });
}
