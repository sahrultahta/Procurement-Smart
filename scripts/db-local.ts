/**
 * Local PostgreSQL 18 for development (ADR 0003). Never downloads anything.
 *
 *   npm run db:local -- init             cluster, procureflow_owner + procureflow_app roles, dev database, .env
 *   npm run db:local -- ensure-app-role  add/refresh procureflow_app on an existing cluster and update .env
 *   npm run db:local -- start            start the server (127.0.0.1 only)
 *   npm run db:local -- stop
 *   npm run db:local -- status
 *
 * Binaries are expected in .local/pgsql/bin (see docs/development.md), or set PG_BIN.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_ROLE, ensureAppRole } from './lib/app-role.ts';
import { ENV_FILE as envFile, readEnvFile, writeEnvKeys } from './lib/env-file.ts';

const root = resolve(import.meta.dirname, '..');
const localDir = join(root, '.local');
const binDir = process.env.PG_BIN ?? join(localDir, 'pgsql', 'bin');
const dataDir = join(localDir, 'pgdata');
const logFile = join(localDir, 'postgres.log');
const superuserPasswordFile = join(localDir, 'superuser-password.txt');
const host = '127.0.0.1';
const port = Number(process.env.PG_LOCAL_PORT ?? '54318');
const OWNER_ROLE = 'procureflow_owner';
const DEV_DATABASE = 'procureflow_dev';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function bin(name: string): string {
  const path = join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
  if (!existsSync(path)) {
    fail(`PostgreSQL binary not found: ${path}\nInstall PostgreSQL 18 binaries into .local/pgsql (docs/development.md) or set PG_BIN.`);
  }
  return path;
}

function run(command: string, args: string[], options: SpawnSyncOptions = {}): number {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(result.error.message);
  return result.status ?? 1;
}

function isInitialized(): boolean {
  return existsSync(join(dataDir, 'PG_VERSION'));
}

const newPassword = (): string => randomBytes(24).toString('hex');
const url = (user: string, password: string, database: string): string =>
  `postgres://${user}:${password}@${host}:${port}/${database}`;
const superuserUrl = (): string => url('postgres', readFileSync(superuserPasswordFile, 'utf8').trim(), 'postgres');

function start(): void {
  if (!isInitialized()) fail('No local cluster yet. Run: npm run db:local -- init');
  if (run(bin('pg_ctl'), ['status', '-D', dataDir], { stdio: 'ignore' }) === 0) {
    console.log(`PostgreSQL already running on ${host}:${port}.`);
    return;
  }
  // stdio is ignored so the detached server does not hold this process's pipes open.
  const code = run(
    bin('pg_ctl'),
    ['start', '-w', '-t', '60', '-D', dataDir, '-l', logFile, '-o', `-p ${port} -c listen_addresses=${host}`],
    { stdio: 'ignore' },
  );
  if (code !== 0) {
    const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n') : '(no log)';
    fail(`pg_ctl start failed (exit ${code}). Last log lines:\n${tail}`);
  }
  console.log(`PostgreSQL started on ${host}:${port} (log: ${logFile}).`);
}

function stop(): void {
  if (!isInitialized()) fail('No local cluster.');
  const code = run(bin('pg_ctl'), ['stop', '-w', '-m', 'fast', '-D', dataDir], { stdio: 'ignore' });
  console.log(code === 0 ? 'PostgreSQL stopped.' : `pg_ctl stop exited with ${code} (was it running?).`);
}

function status(): void {
  if (!isInitialized()) fail('No local cluster.');
  process.exitCode = run(bin('pg_ctl'), ['status', '-D', dataDir]);
}

function appPasswordFromEnv(entries: Map<string, string>): string | undefined {
  for (const key of ['TEST_APP_DATABASE_URL', 'DATABASE_URL']) {
    const value = entries.get(key);
    if (!value) continue;
    const parsed = new URL(value);
    if (parsed.username === APP_ROLE && parsed.password) return decodeURIComponent(parsed.password);
  }
  return undefined;
}

function ownerUrlFromEnv(entries: Map<string, string>): string | undefined {
  for (const key of ['DATABASE_MIGRATION_URL', 'DATABASE_URL', 'TEST_DATABASE_URL']) {
    const value = entries.get(key);
    if (value && new URL(value).username === OWNER_ROLE) {
      const parsed = new URL(value);
      parsed.pathname = `/${DEV_DATABASE}`;
      return parsed.toString();
    }
  }
  return undefined;
}

async function ensureAppRoleCommand(): Promise<void> {
  if (!isInitialized()) fail('No local cluster yet. Run: npm run db:local -- init');
  const entries = readEnvFile();
  const ownerUrl = ownerUrlFromEnv(entries);
  if (!ownerUrl) fail(`.env has no ${OWNER_ROLE} connection URL; cannot configure the app role.`);
  const appPassword = appPasswordFromEnv(entries) ?? newPassword();
  const outcome = await ensureAppRole(superuserUrl(), appPassword);
  const ownerServerUrl = new URL(ownerUrl);
  ownerServerUrl.pathname = '/postgres';
  writeEnvKeys({
    DATABASE_URL: url(APP_ROLE, appPassword, DEV_DATABASE),
    DATABASE_MIGRATION_URL: ownerUrl,
    TEST_DATABASE_URL: ownerServerUrl.toString(),
    TEST_APP_DATABASE_URL: url(APP_ROLE, appPassword, 'postgres'),
  });
  console.log(`Role ${APP_ROLE} ${outcome}. .env now uses it for DATABASE_URL; migrations use DATABASE_MIGRATION_URL (${OWNER_ROLE}).`);
}

async function init(): Promise<void> {
  if (isInitialized()) fail(`Already initialized: ${dataDir}`);
  if (existsSync(envFile)) fail('.env already exists. Move it aside before "init", or use "ensure-app-role" on an existing cluster.');
  mkdirSync(localDir, { recursive: true });
  const superuserPassword = newPassword();
  const ownerPassword = newPassword();
  const appPassword = newPassword();
  writeFileSync(superuserPasswordFile, `${superuserPassword}\n`, { mode: 0o600 });

  const initCode = run(bin('initdb'), [
    '-D', dataDir,
    '-U', 'postgres',
    `--pwfile=${superuserPasswordFile}`,
    '--auth=scram-sha-256',
    '--encoding=UTF8',
    '--locale=C',
  ]);
  if (initCode !== 0) fail(`initdb failed (exit ${initCode}).`);
  start();

  const psql = (statement: string): void => {
    const code = run(
      bin('psql'),
      ['-h', host, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement],
      { env: { ...process.env, PGPASSWORD: superuserPassword } },
    );
    if (code !== 0) fail(`psql failed (exit ${code}).`);
  };
  // Passwords are random hex, so they are safe inside a SQL string literal.
  psql(`CREATE ROLE ${OWNER_ROLE} LOGIN CREATEDB PASSWORD '${ownerPassword}'`);
  psql(`CREATE DATABASE ${DEV_DATABASE} OWNER ${OWNER_ROLE}`);
  await ensureAppRole(superuserUrl(), appPassword);

  writeEnvKeys({
    DATABASE_URL: url(APP_ROLE, appPassword, DEV_DATABASE),
    DATABASE_MIGRATION_URL: url(OWNER_ROLE, ownerPassword, DEV_DATABASE),
    TEST_DATABASE_URL: url(OWNER_ROLE, ownerPassword, 'postgres'),
    TEST_APP_DATABASE_URL: url(APP_ROLE, appPassword, 'postgres'),
  });
  console.log('Wrote .env. Local PostgreSQL is ready. Next: npm run db:migrate');
}

const commands: Record<string, () => void | Promise<void>> = {
  init,
  'ensure-app-role': ensureAppRoleCommand,
  start,
  stop,
  status,
};
const command = process.argv[2] ?? '';
const handler = commands[command];
if (!handler) fail(`Usage: npm run db:local -- <${Object.keys(commands).join('|')}>`);
await handler();
