import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, hotp, newSecret, otpauthUrl, totp, verifyTotp } from '../../src/auth/totp.js';

/**
 * The authenticator codes, pinned to RFC 6238's own test vectors: if these pass,
 * the codes match what Google Authenticator shows.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('[critical] RFC 6238 SHA-1 vectors, 8 digits', () => {
  for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']] as const) {
    assert.equal(totp(RFC_SECRET, t * 1000, 8), code, `T=${t}`);
  }
});

test('[critical] and the 6-digit codes an authenticator app shows are their last six digits', () => {
  assert.equal(totp(RFC_SECRET, 59_000), '287082');
  assert.equal(totp(RFC_SECRET, 1234567890_000), '005924');
});

test('RFC 4226 HOTP vectors', () => {
  const secret = Buffer.from('12345678901234567890');
  const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  want.forEach((code, i) => assert.equal(hotp(secret, i), code, `counter ${i}`));
});

test('base32 round-trips, and ignores spaces, case and padding', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  const s = base32Encode(Buffer.from('12345678901234567890'));
  assert.deepEqual(base32Decode(s.toLowerCase().replace(/(.{4})/g, '$1 ') + '===='), Buffer.from('12345678901234567890'));
  assert.throws(() => base32Decode('not!base32'));
});

test('a new secret is 20 random bytes, and never the same twice', () => {
  const a = newSecret();
  assert.equal(base32Decode(a).length, 20);
  assert.notEqual(a, newSecret());
});

test('[critical] a code one step either side still counts, two steps does not', () => {
  const now = 1_700_000_000_000;
  const s = newSecret();
  assert.notEqual(verifyTotp(s, totp(s, now), now), null);
  assert.notEqual(verifyTotp(s, totp(s, now - 30_000), now), null, 'a phone a little behind');
  assert.notEqual(verifyTotp(s, totp(s, now + 30_000), now), null, 'a phone a little ahead');
  assert.equal(verifyTotp(s, totp(s, now - 90_000), now), null, 'a minute and a half old');
});

test('[critical] a code for a step already used is refused, even when right', () => {
  const now = 1_700_000_000_000;
  const s = newSecret();
  const code = totp(s, now);
  const step = verifyTotp(s, code, now)!;
  assert.equal(verifyTotp(s, code, now, step), null);
});

test('only six digits are a code', () => {
  const s = newSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x']) assert.equal(verifyTotp(s, bad, Date.now()), null, bad);
  assert.notEqual(verifyTotp(s, totp(s, 1e12).replace(/(\d{3})/, '$1 '), 1e12), null, 'a space in the middle is fine');
});

test('the QR code holds the standard otpauth URI', () => {
  const url = otpauthUrl({ issuer: 'BTC Desk', account: 'ugendran', secret: 'JBSWY3DPEHPK3PXP' });
  assert.equal(url, 'otpauth://totp/BTC%20Desk%3Augendran?secret=JBSWY3DPEHPK3PXP&issuer=BTC+Desk&algorithm=SHA1&digits=6&period=30');
});
