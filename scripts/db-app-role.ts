/**
 * Creates or updates the runtime role procureflow_app in any environment (CI, staging).
 *   DATABASE_ADMIN_URL  a role allowed to CREATE ROLE (e.g. the cluster superuser)
 *   APP_DB_PASSWORD     the password procureflow_app should have
 * For the local portable cluster, use `npm run db:local -- ensure-app-role` instead.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureAppRole } from './lib/app-role.ts';

const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.APP_DB_PASSWORD;
if (!adminUrl || !password) {
  console.error('Set DATABASE_ADMIN_URL and APP_DB_PASSWORD.');
  process.exit(1);
}
const outcome = await ensureAppRole(adminUrl, password);
console.log(`Role procureflow_app ${outcome}.`);
