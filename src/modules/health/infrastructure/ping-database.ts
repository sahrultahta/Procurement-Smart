import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/shared/db/client';
import { describeError, logger } from '@/shared/logger';

/** Runs `select 1`. Never throws: failures are logged server-side and reported as `false`. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getDb().execute(sql`select 1`);
    return true;
  } catch (error) {
    logger.error('health.database_unreachable', { error: describeError(error) });
    return false;
  }
}
