// Generates a scrypt password hash for the tBoard web server.
// Usage: npm run server:hash-password -- "your password"
//    or: npm run server:hash-password   (prompts on stdin, no echo in terminals)
import { hashPassword } from '../src/server/auth.ts';
import { createInterface } from 'node:readline';

async function readPassword() {
  const fromArg = process.argv.slice(2).join(' ').trim();
  if (fromArg) return fromArg;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question('Password: ', (answer) => { rl.close(); resolve(answer.trim()); }));
}

const password = await readPassword();
if (!password) {
  console.error('No password provided.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Refusing: use a password of at least 12 characters (this is your only internet-facing secret).');
  process.exit(1);
}
console.log('\nSet this in your server environment (never commit it):\n');
console.log(`TBOARD_AUTH_PASSWORD_HASH='${hashPassword(password)}'`);
