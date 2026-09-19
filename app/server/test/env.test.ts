import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The suite must not write into the desk's own database.
 *
 * It did, for two days, when the stores were SQLite files: four test files set
 * `ERROR_DB` themselves and every other file that made the exchange refuse an
 * order filed that refusal into the real `errors.db`. The live log carried two
 * rows with 72 folded occurrences between them, both fixtures — `client_order_id`
 * "abc123E0", stack ending in `node:assert`.
 *
 * The cost is not tidiness. The error log is where a real failure is supposed
 * to be findable, and three more fake refusals per run is how a real one gets
 * scrolled past. `test/env.ts` now creates a throwaway database per process;
 * this checks it did.
 */

test('[critical] DATABASE_URL names a throwaway test database while testing', () => {
  const url = process.env.DATABASE_URL ?? '';
  const name = new URL(url).pathname.slice(1);
  assert.match(
    name,
    /^btc_test_[0-9a-f]+$/,
    `DATABASE_URL points at "${name}" — the suite would write to a real database. ` +
    'Is test/env.ts still preloaded? See the "test" script in package.json.',
  );
});
