import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/paths.js';
import { brokenDocMentions, brokenLinks, renderReference } from '../../src/docs/gen-docs.js';
import { closePool } from '../../src/db/pool.js';

/**
 * The docs cannot drift from the code without this failing.
 *
 * FILE-INVENTORY.md was written by hand on 9 Sep 2026 and was missing twenty
 * files by the 26th; seven docs the code pointed readers at did not exist at
 * all. The reference pages are now rendered from the code, and this compares
 * them with what is committed -- the fix for a failure here is
 * `npm run docs`, never an edit to the page.
 */

after(closePool);

test('[critical] every generated reference page matches the code', async () => {
  for (const page of await renderReference()) {
    const at = join(ROOT, page.path);
    assert.ok(existsSync(at), `${page.path} is missing -- run \`npm run docs\` in app/server`);
    assert.equal(readFileSync(at, 'utf8'), page.body,
      `${page.path} is out of date -- run \`npm run docs\` in app/server and commit the result`);
  }
});

test('every relative link in README.md and docs/ points at a file that exists', () => {
  assert.deepEqual(brokenLinks(), []);
});

test('no code or config names a docs page that does not exist', () => {
  assert.deepEqual(brokenDocMentions(), []);
});
