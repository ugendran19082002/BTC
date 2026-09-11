/**
 * What a new password has to be.
 *
 * Length over complexity rules, as NIST 800-63B puts it: a long phrase is
 * stronger than a short string of symbols and easier to remember. Beyond length,
 * only what is plainly guessable is refused -- the username in it, one character
 * repeated, the old password again, or a password everyone tries first.
 */

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;

const COMMON = new Set([
  'password', 'password1', 'password123', '123456789012', '1234567890', 'qwertyuiop', 'qwerty123456',
  'iloveyou', 'letmein', 'welcome', 'admin', 'administrator', 'trading', 'bitcoin', 'deltaexchange',
  'btcdesk', 'changeme', 'passw0rd', '111111111111', '000000000000', 'abcdefghijkl',
]);

export function passwordProblems(next: string, o: { username: string; current?: string }): string[] {
  const out: string[] = [];
  if (next.length < MIN_LENGTH) out.push(`Use at least ${MIN_LENGTH} characters.`);
  if (next.length > MAX_LENGTH) out.push(`Use at most ${MAX_LENGTH} characters.`);
  const lower = next.toLowerCase();
  if (o.username && lower.includes(o.username.toLowerCase())) out.push('Do not put the username in the password.');
  if (next.length > 0 && new Set(next).size === 1) out.push('Not one character repeated.');
  if (COMMON.has(lower.replace(/[^a-z0-9]/g, ''))) out.push('That password is one of the first ones people try.');
  if (o.current !== undefined && next === o.current) out.push('Choose a password different from the current one.');
  return out;
}
