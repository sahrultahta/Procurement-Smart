/**
 * Finishes the standalone build (docs/deployment.md): copies the static assets next to the
 * server, and removes every `.env*` file Next.js copied into it. Configuration and secrets are
 * given to the server at run time, never shipped inside the build output.
 * Runs after `next build` as part of `npm run build`.
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const standalone = join(root, '.next', 'standalone');
const server = join(standalone, 'server.js');
if (!existsSync(server)) {
  console.error(`${server} is missing: run "next build" with output: 'standalone' first.`);
  process.exit(1);
}

cpSync(join(root, '.next', 'static'), join(standalone, '.next', 'static'), { recursive: true });
if (existsSync(join(root, 'public'))) cpSync(join(root, 'public'), join(standalone, 'public'), { recursive: true });

const removed: string[] = [];
for (const name of readdirSync(standalone)) {
  if (name === '.env' || name.startsWith('.env.')) {
    rmSync(join(standalone, name), { force: true });
    removed.push(name);
  }
}
if (removed.length > 0) console.log(`Removed from the build output (configuration is given at run time): ${removed.join(', ')}`);
console.log(`Standalone server ready: node ${join('.next', 'standalone', 'server.js')}`);
