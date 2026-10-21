/**
 * Adds the non-database settings the app needs to the local .env, if missing:
 *   BETTER_AUTH_SECRET  random, 48 bytes (base64url)
 *   BETTER_AUTH_URL     http://localhost:3000
 * Existing values are never replaced. Usage: npm run env:local
 */
import { randomBytes } from 'node:crypto';
import { readEnvFile, writeEnvKeys } from './lib/env-file.ts';

const current = readEnvFile();
const additions: Record<string, string> = {};
if (!current.get('BETTER_AUTH_SECRET')) additions.BETTER_AUTH_SECRET = randomBytes(48).toString('base64url');
if (!current.get('BETTER_AUTH_URL')) additions.BETTER_AUTH_URL = 'http://localhost:3000';

if (Object.keys(additions).length === 0) {
  console.log('.env already has BETTER_AUTH_SECRET and BETTER_AUTH_URL; nothing changed.');
} else {
  writeEnvKeys(additions);
  console.log(`Added to .env: ${Object.keys(additions).join(', ')}.`);
}
