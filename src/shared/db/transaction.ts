import 'server-only';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';

export type Database = NodePgDatabase;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type IsolationLevel = NonNullable<PgTransactionConfig['isolationLevel']>;

export type TransactionOptions = {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
  /** PostgreSQL interval text, e.g. '5s' or '200ms' (ADR 0008 C7). */
  lockTimeout: string;
  statementTimeout: string;
};

const TIMEOUT_PATTERN = /^\d{1,6}(ms|s)$/;

/** Runs `fn` in one transaction with per-transaction lock and statement timeouts. */
export async function inTransaction<T>(db: Database, options: TransactionOptions, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (const value of [options.lockTimeout, options.statementTimeout]) {
    if (!TIMEOUT_PATTERN.test(value)) throw new Error(`Invalid timeout: ${value}`);
  }
  const config: PgTransactionConfig = { accessMode: options.readOnly ? 'read only' : 'read write' };
  if (options.isolationLevel) config.isolationLevel = options.isolationLevel;
  return db.transaction(async (tx) => {
    // set_config(..., true) is the parameterized form of SET LOCAL.
    await tx.execute(
      sql`select set_config('lock_timeout', ${options.lockTimeout}, true), set_config('statement_timeout', ${options.statementTimeout}, true)`,
    );
    return fn(tx);
  }, config);
}
