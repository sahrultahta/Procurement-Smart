import 'server-only';
import type { Database, Tx } from '@/shared/db/transaction';
import type { SupplierStatus } from '../domain/supplier';
import { findSupplierRecords, listActiveSuppliers } from '../infrastructure/supplier-repository';

/*
 * Read-only lookups other modules need (RFQ invitations, later purchase orders). Plain records;
 * callers decide what reaches a client. Rule SUP-R1: only active suppliers are used for new
 * purchasing documents, and callers check `status` themselves.
 */

export type SupplierRecord = { id: string; code: string; legalName: string; status: SupplierStatus };

export async function findSuppliersByIds(db: Database | Tx, ids: readonly string[]): Promise<Map<string, SupplierRecord>> {
  const rows = await findSupplierRecords(db, ids);
  return new Map(rows.map((r) => [r.id, { id: r.id, code: r.code, legalName: r.legalName, status: r.status as SupplierStatus }]));
}

export async function findActiveSuppliers(db: Database | Tx): Promise<{ id: string; code: string; legalName: string }[]> {
  return listActiveSuppliers(db);
}
