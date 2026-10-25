import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// P1-AC3: the architecture and banned-API lint rules actually fire.
const root = resolve(import.meta.dirname, '../..');
let eslint: ESLint;

// The first lint loads every plugin and resolver, which can take tens of seconds on a
// cold or antivirus-scanned disk. Pay that cost here, not inside a 5 s test timeout.
beforeAll(async () => {
  eslint = new ESLint({ cwd: root });
  await eslint.lintText('export {};\n', { filePath: resolve(root, 'src/app/warmup.ts') });
}, 120_000);

async function ruleIds(filePath: string, code: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return (result?.messages ?? []).map((m) => m.ruleId);
}

describe('module boundaries', () => {
  it('lets routes import a module public API', async () => {
    const ids = await ruleIds('src/app/probe.ts', "export { checkHealth } from '@/modules/health';\n");
    expect(ids).not.toContain('import/no-restricted-paths');
  });

  it('stops routes from importing module internals', async () => {
    const ids = await ruleIds(
      'src/app/probe.ts',
      "export { pingDatabase } from '@/modules/health/infrastructure/ping-database';\n",
    );
    expect(ids).toContain('import/no-restricted-paths');
  });

  it('stops routes from importing internals through a relative path', async () => {
    const ids = await ruleIds(
      'src/app/api/probe.ts',
      "export { pingDatabase } from '../../modules/health/infrastructure/ping-database';\n",
    );
    expect(ids).toContain('import/no-restricted-paths');
  });

  it('stops routes from importing the database client', async () => {
    const ids = await ruleIds('src/app/probe.ts', "export { getDb } from '@/shared/db/client';\n");
    expect(ids).toContain('import/no-restricted-paths');
  });

  it('stops routes from importing database drivers', async () => {
    const ids = await ruleIds('src/app/probe.ts', "import pg from 'pg';\nexport const p = pg;\n");
    expect(ids).toContain('no-restricted-imports');
  });

  it('keeps domain code free of I/O imports', async () => {
    const ids = await ruleIds('src/modules/health/domain/probe.ts', "import { sql } from 'drizzle-orm';\nexport const s = sql;\n");
    expect(ids).toContain('no-restricted-imports');
  });
});

// P2-AC8: module → module rules, exercised against the real audit module.
describe('module-to-module boundaries', () => {
  it('lets a module that may use audit import its public API', async () => {
    const ids = await ruleIds('src/modules/requisitions/application/probe.ts', "export { recordAuditEvent } from '@/modules/audit';\n");
    expect(ids).not.toContain('import/no-restricted-paths');
  });

  it("stops a module from importing another module's internals (alias path)", async () => {
    const ids = await ruleIds(
      'src/modules/requisitions/application/probe.ts',
      "export { auditEvents } from '@/modules/audit/infrastructure/schema';\n",
    );
    expect(ids).toContain('import/no-restricted-paths');
  });

  it("stops a module from importing another module's internals (relative path)", async () => {
    const ids = await ruleIds(
      'src/modules/requisitions/application/probe.ts',
      "export { insertAuditEvent } from '../../audit/infrastructure/audit-repository';\n",
    );
    expect(ids).toContain('import/no-restricted-paths');
  });

  it('stops a foundation module from depending on another module at all, even its public API', async () => {
    const ids = await ruleIds('src/modules/health/application/probe.ts', "export { recordAuditEvent } from '@/modules/audit';\n");
    expect(ids).toContain('import/no-restricted-paths');
  });

  it('stops the audit module from depending on a peer module', async () => {
    const ids = await ruleIds('src/modules/audit/application/probe.ts', "export { checkHealth } from '@/modules/health';\n");
    expect(ids).toContain('import/no-restricted-paths');
  });

  it('stops src/shared from importing any module', async () => {
    const ids = await ruleIds('src/shared/application/probe.ts', "export { recordAuditEvent } from '@/modules/audit';\n");
    expect(ids).toContain('import/no-restricted-paths');
  });

  it('lets a module use its own internals through relative imports', async () => {
    const ids = await ruleIds(
      'src/modules/audit/application/probe.ts',
      "export { insertAuditEvent } from '../infrastructure/audit-repository';\n",
    );
    expect(ids).not.toContain('import/no-restricted-paths');
  });
});

describe('banned APIs', () => {
  it('rejects process.env outside src/shared/env.ts', async () => {
    const ids = await ruleIds('src/modules/health/application/probe.ts', 'export const x = process.env.SECRET;\n');
    expect(ids).toContain('no-restricted-properties');
  });

  it('allows process.env inside src/shared/env.ts', async () => {
    const ids = await ruleIds('src/shared/env.ts', 'export const x = process.env.SECRET;\n');
    expect(ids).not.toContain('no-restricted-properties');
  });

  it('rejects sql.raw()', async () => {
    const ids = await ruleIds(
      'src/modules/health/infrastructure/probe.ts',
      "import { sql } from 'drizzle-orm';\nexport const q = sql.raw('select 1');\n",
    );
    expect(ids).toContain('no-restricted-syntax');
  });

  it("rejects numeric columns in mode 'number'", async () => {
    const ids = await ruleIds(
      'src/modules/health/infrastructure/probe.ts',
      "import { numeric } from 'drizzle-orm/pg-core';\nexport const c = numeric({ mode: 'number' });\n",
    );
    expect(ids).toContain('no-restricted-syntax');
  });

  it('rejects a plain <form action={formAction}> (use ActionForm, which keeps fields after a refusal)', async () => {
    const form = (tag: string) =>
      `'use client';\nimport { useActionState } from 'react';\nexport function F({ act }: { act: (s: null, f: FormData) => Promise<null> }) {\n  const [, formAction] = useActionState(act, null);\n  return <${tag} action={formAction} />;\n}\n`;
    expect(await ruleIds('src/app/probe.tsx', form('form'))).toContain('no-restricted-syntax');
    const allowed = form('ActionForm').replace("import { useActionState } from 'react';", "import { useActionState } from 'react';\nimport { ActionForm } from '@/components/action-form';");
    expect(await ruleIds('src/app/probe.tsx', allowed)).not.toContain('no-restricted-syntax');
  });

  it('rejects dangerouslySetInnerHTML', async () => {
    const ids = await ruleIds(
      'src/app/probe.tsx',
      'export function P({ h }: { h: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: h }} />;\n}\n',
    );
    expect(ids).toContain('react/no-danger');
  });
});
