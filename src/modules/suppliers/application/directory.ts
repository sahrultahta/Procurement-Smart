import 'server-only';
import type { Database, Tx } from '@/shared/db/transaction';
import type { SupplierStatus } from '../domain/supplier';
import { findSupplier, findSupplierRecords, listActiveSuppliers } from '../infrastructure/supplier-repository';

/*
 * Read-only lookups other modules need (RFQ invitations, purchase orders). Plain records;
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

export type SupplierContact = SupplierRecord & {
  taxId: string | null;
  email: string | null;
  phone: string | null;
  addressLines: string[];
  countryCode: string;
};

/** What a purchase order prints about its supplier: identity and where to reach it. */
export async function findSupplierContact(db: Database | Tx, id: string): Promise<SupplierContact | null> {
  const row = await findSupplier(db, id);
  if (!row) return null;
  const cityLine = [row.postalCode, row.city, row.region].filter((part) => part !== null && part !== '').join(' ');
  return {
    id: row.id,
    code: row.code,
    legalName: row.legalName,
    status: row.status as SupplierStatus,
    taxId: row.taxId,
    email: row.email,
    phone: row.phone,
    addressLines: [row.addressLine1, row.addressLine2, cityLine].filter((line): line is string => line !== null && line !== ''),
    countryCode: row.countryCode,
  };
}
