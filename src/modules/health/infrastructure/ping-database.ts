import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/shared/db/client';

/** Runs `select 1`. Never throws: failures are logged server-side and reported as `false`. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getDb().execute(sql`select 1`);
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'health.database_unreachable',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}
