import 'server-only';
import type { Database, Tx } from '@/shared/db/transaction';
import { findUserNames } from '../infrastructure/admin-repository';

/** Display names for user ids, for "created by" and similar labels in other modules. */
export async function findUserDisplayNames(db: Database | Tx, userIds: readonly string[]): Promise<Map<string, string>> {
  return findUserNames(db, [...new Set(userIds)]);
}
