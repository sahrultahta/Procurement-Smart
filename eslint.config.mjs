import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * Allowed module dependencies (docs/architecture.md). A module may import another
 * module only through its index.ts, and only along these edges. Every module may
 * also use the implicit modules (identity, audit) and src/shared.
 */
export const MODULE_DEPENDENCIES = {
  health: [],
  identity: [],
  audit: [],
  organization: [],
  approvals: ['organization'],
  suppliers: [],
  requisitions: ['approvals', 'organization'],
  sourcing: ['requisitions', 'suppliers', 'organization'],
  purchasing: ['requisitions', 'sourcing', 'suppliers', 'approvals', 'organization'],
  receiving: ['purchasing', 'organization'],
  reporting: [],
};
const IMPLICIT_MODULES = ['identity', 'audit'];
// Import only src/shared. (identity is not here: it writes audit events, so it may use audit.)
const FOUNDATION_MODULES = ['health', 'audit'];

function boundaryZones() {
  const modules = Object.keys(MODULE_DEPENDENCIES);
  const zones = [
    { target: './src/shared', from: './src/modules', message: 'src/shared must not depend on modules.' },
    { target: './src/app', from: './src/shared/db', message: 'Routes must go through a module, never the database client.' },
  ];
  for (const m of modules) {
    zones.push({
      target: './src/app',
      from: `./src/modules/${m}`,
      except: ['./index.ts'],
      message: `Routes may import only the public API of module "${m}" (@/modules/${m}).`,
    });
  }
  for (const target of modules) {
    for (const m of modules) {
      if (m === target) continue;
      const allowed =
        !FOUNDATION_MODULES.includes(target) &&
        (MODULE_DEPENDENCIES[target].includes(m) || IMPLICIT_MODULES.includes(m));
      zones.push(
        allowed
          ? {
              target: `./src/modules/${target}`,
              from: `./src/modules/${m}`,
              // tables.ts: table declarations, for foreign keys in schema files only.
              except: ['./index.ts', './tables.ts'],
              message: `Module "${target}" may import only the public API of "${m}" (index.ts, or tables.ts for foreign keys).`,
            }
          : {
              target: `./src/modules/${target}`,
              from: `./src/modules/${m}`,
              message: `Module "${target}" must not depend on "${m}" (see docs/architecture.md).`,
            },
      );
    }
  }
  return zones;
}

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'node_modules/**',
    '.local/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'db/migrations/**',
  ]),
  {
    // Import resolvers (node + typescript with tsconfig paths) come from eslint-config-next.
    rules: {
      'import/no-restricted-paths': ['error', { zones: boundaryZones() }],
      'react/no-danger': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    // instrumentation.ts reads NEXT_RUNTIME and proxy.ts reads NODE_ENV: both run before
    // (or outside) the server-only env module and need only these framework-set values.
    ignores: ['src/shared/env.ts', 'src/instrumentation.ts', 'src/proxy.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration through getEnv() in src/shared/env.ts.' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='sql'][property.name='raw']",
          message: 'sql.raw() bypasses parameter binding. Use the sql`` template (ADR 0004).',
        },
        {
          selector: "CallExpression[callee.name=/^(numeric|decimal)$/] Property[key.name='mode'][value.value='number']",
          message: "numeric mode 'number' uses floating point. Read numeric as string (ADR 0007).",
        },
        {
          // A useActionState form: React would reset its fields after a refused submission.
          selector: "JSXOpeningElement[name.name='form'] > JSXAttribute[name.name='action'] > JSXExpressionContainer > Identifier[name='formAction']",
          message: 'Use <ActionForm> from @/components/action-form: a plain <form action={formAction}> loses what was typed when the server refuses it.',
        },
      ],
    },
  },
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'pg', message: 'Routes must not talk to the database directly.' }],
          patterns: [{ group: ['drizzle-orm', 'drizzle-orm/*'], message: 'Routes must not talk to the database directly.' }],
        },
      ],
    },
  },
  {
    files: ['src/modules/*/domain/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['pg', 'next', 'react', 'server-only'],
          patterns: [
            { group: ['node:*', 'next/*', 'drizzle-orm', 'drizzle-orm/*'], message: 'Domain code is pure: no I/O or framework imports (ADR 0002).' },
            { group: ['@/shared/db', '@/shared/db/*', '../application/*', '../infrastructure/*'], message: 'Domain code must not depend on application or infrastructure code.' },
          ],
        },
      ],
    },
  },
]);
