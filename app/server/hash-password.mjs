// Turn a password into the hash to put in .env. The password is read from a
// prompt, not an argument, so it does not land in your shell history.
import { createInterface } from 'node:readline/promises';
import { hashPassword } from './src/http/session.ts';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pw = await rl.question('password: ');
rl.close();
if (!pw) { console.error('nothing entered'); process.exit(1); }
console.log('\nDESK_PASSWORD_HASH=' + hashPassword(pw));
