import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AuthStore } from './store.js';
import { hashPassword } from '../http/session.js';
import { passwordProblems } from './password.js';

/**
 * Sign-in repairs, from the server's own command line. The only way in when the
 * screen cannot be reached: a lost phone, a forgotten password.
 *
 *   npm run auth -- status
 *   npm run auth -- create <username>     first user, on a fresh auth.db
 *   npm run auth -- set-password          asks twice, never echoes
 *   npm run auth -- reset-2fa             phone lost: set up again at next sign-in
 *   npm run auth -- sign-out-all          end every session now
 *
 * In the container: docker compose exec api node app/server/dist/auth/cli.js <command>
 *
 * Deliberately not on the web: whoever can run these already controls the
 * server, and a web route that did the same would be a way around 2FA.
 */

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    const line = await rl.question('');
    rl.close();
    return line;
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  let text = '';
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(text);
          return;
        }
        if (ch === CTRL_C) process.exit(130);
        if (ch === BACKSPACE) text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword(username: string): Promise<string> {
  const first = await askHidden('new password: ');
  const again = await askHidden('again: ');
  if (first !== again) throw new Error('the two did not match');
  const problems = passwordProblems(first, { username });
  if (problems.length) throw new Error(problems.join(' '));
  return first;
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  const store = new AuthStore();
  const now = Date.now();
  const user = store.user();
  try {
    switch (command) {
      case 'status': {
        if (!user) { console.log('no user yet'); break; }
        console.log(`user: ${user.username}`);
        console.log(`password changed: ${new Date(user.passwordChangedAt).toISOString()}`);
        console.log(`two-step sign-in: ${user.totpEnabledAt ? `on since ${new Date(user.totpEnabledAt).toISOString()}` : 'not set up'}`);
        console.log(`recovery codes left: ${store.recoveryCodesLeft()}`);
        console.log(`signed-in sessions: ${store.liveSessions(now).length}`);
        break;
      }
      case 'create': {
        if (user) throw new Error(`a user already exists (${user.username}); use set-password`);
        if (!arg) throw new Error('usage: create <username>');
        store.seedUser(arg, hashPassword(await newPassword(arg)), now);
        store.event('user_created', now, 'cli');
        console.log(`created ${arg}. Two-step sign-in is set up at the first sign-in.`);
        break;
      }
      case 'set-password': {
        if (!user) throw new Error('no user yet; use create');
        store.setPassword(hashPassword(await newPassword(user.username)), now);
        const ended = store.revokeAll(now);
        store.event('password_changed', now, 'cli', `${ended} sessions ended`);
        console.log(`password changed; ${ended} session(s) signed out.`);
        break;
      }
      case 'reset-2fa': {
        if (!user) throw new Error('no user yet');
        store.resetTotp(now);
        const ended = store.revokeAll(now);
        store.event('2fa_reset', now, 'cli', `${ended} sessions ended`);
        console.log(`two-step sign-in cleared; ${ended} session(s) signed out. It is set up again at the next sign-in.`);
        break;
      }
      case 'sign-out-all': {
        const ended = store.revokeAll(now);
        store.event('signed_out_all', now, 'cli', `${ended} ended`);
        console.log(`${ended} session(s) signed out.`);
        break;
      }
      default:
        console.log('commands: status | create <username> | set-password | reset-2fa | sign-out-all');
        process.exitCode = command ? 1 : 0;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

await main();
