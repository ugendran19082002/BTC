import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Secrets, newRecoveryCodes } from '../../src/auth/secrets.js';
import { passwordProblems } from '../../src/auth/password.js';

test('[critical] a sealed secret opens with the same key, and not with another', () => {
  const a = new Secrets('first-master-secret');
  const sealed = a.seal('JBSWY3DPEHPK3PXP');
  assert.doesNotMatch(sealed, /JBSWY3DPEHPK3PXP/);
  assert.equal(a.open(sealed), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => new Secrets('another-master-secret').open(sealed));
});

test('[critical] an altered sealed value will not open', () => {
  const a = new Secrets('master');
  const parts = a.seal('JBSWY3DPEHPK3PXP').split('.');
  const body = Buffer.from(parts[3]!, 'base64url');
  body[0] = body[0]! ^ 1;
  parts[3] = body.toString('base64url');
  assert.throws(() => a.open(parts.join('.')));
});

test('the same secret sealed twice looks different', () => {
  const a = new Secrets('master');
  assert.notEqual(a.seal('x'), a.seal('x'));
});

test('no master secret, no sealing', () => {
  assert.throws(() => new Secrets(''));
});

test('recovery codes: ten, readable, unique, and compared without case or dashes', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const s = new Secrets('master');
  assert.equal(s.codeHash(codes[0]!), s.codeHash(codes[0]!.toLowerCase().replace('-', ' ')));
  assert.notEqual(s.codeHash(codes[0]!), s.codeHash(codes[1]!));
});

test('[critical] a new password: long enough, and not the guessable kind', () => {
  const o = { username: 'ugendran', current: 'the old passphrase' };
  assert.deepEqual(passwordProblems('a long private passphrase', o), []);
  assert.ok(passwordProblems('short1!', o).some((p) => /at least 12/.test(p)));
  assert.ok(passwordProblems('ugendran-trades-btc', o).some((p) => /username/.test(p)));
  assert.ok(passwordProblems('aaaaaaaaaaaaaaa', o).some((p) => /repeated/.test(p)));
  assert.ok(passwordProblems('Password123', { username: 'x' }).length > 0);
  assert.ok(passwordProblems('the old passphrase', o).some((p) => /different/.test(p)));
  assert.ok(passwordProblems('x'.repeat(129), o).some((p) => /at most 128/.test(p)));
});
