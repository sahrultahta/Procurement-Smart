/**
 * The Better Auth options that shape the database schema, shared by the runtime
 * configuration (src/server/auth.ts) and the schema generator (scripts/auth-cli.config.ts),
 * so the two cannot drift. No I/O and no `server-only`: the CLI loads this file directly.
 */
export const AUTH_TABLES = {
  user: 'users',
  session: 'sessions',
  account: 'accounts',
  verification: 'verifications',
  rateLimit: 'rateLimits',
} as const;

export const authSchemaOptions = {
  user: { modelName: AUTH_TABLES.user },
  session: { modelName: AUTH_TABLES.session },
  account: { modelName: AUTH_TABLES.account },
  verification: { modelName: AUTH_TABLES.verification },
  rateLimit: { storage: 'database', modelName: AUTH_TABLES.rateLimit },
  emailAndPassword: { enabled: true },
  advanced: { database: { generateId: 'uuid' } },
} as const;
