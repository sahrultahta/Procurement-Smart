import 'server-only';
import { z } from 'zod';
import { findEntityHistory, type HistoryEntryDto } from '@/modules/audit';
import { findUserDisplayNames } from '@/modules/identity';
import { defineQuery } from '@/shared/application/runner';
import { fail } from '@/shared/result';
import { SUPPLIER_STATUSES, isMaker, normalizeSupplierName, normalizeTaxId, type SupplierStatus } from '../domain/supplier';
import { findSupplier, listActiveSuppliers, searchSuppliers, type SupplierRow } from '../infrastructure/supplier-repository';

/*
 * Supplier read models. Every supplier.read holder sees every supplier (supplier master
 * data is organization-wide); DTOs are field allowlists (threat I-02).
 */

export type SupplierSummaryDto = {
  id: string;
  code: string;
  legalName: string;
  taxId: string | null;
  city: string | null;
  countryCode: string;
  status: SupplierStatus;
};
export const SUPPLIER_SUMMARY_KEYS = ['id', 'code', 'legalName', 'taxId', 'city', 'countryCode', 'status'] as const;

export type SupplierDetailDto = SupplierSummaryDto & {
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  region: string | null;
  postalCode: string | null;
  createdBy: string;
  createdAt: string;
  identityChangedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  statusReason: string | null;
  updatedAt: string;
  version: number;
  /** The caller created it or last changed its identity, so may not review it (SOD-03). */
  callerIsMaker: boolean;
  /** The document's own audit trail, oldest first (Phase 9). */
  history: HistoryEntryDto[];
};
export const SUPPLIER_DETAIL_KEYS = [
  ...SUPPLIER_SUMMARY_KEYS,
  'email',
  'phone',
  'addressLine1',
  'addressLine2',
  'region',
  'postalCode',
  'createdBy',
  'createdAt',
  'identityChangedBy',
  'reviewedBy',
  'reviewedAt',
  'reviewNote',
  'statusReason',
  'updatedAt',
  'version',
  'callerIsMaker',
  'history',
] as const;

export type SelectableSupplierDto = { id: string; code: string; legalName: string };
export const SELECTABLE_SUPPLIER_KEYS = ['id', 'code', 'legalName'] as const;

function summary(row: SupplierRow): SupplierSummaryDto {
  return {
    id: row.id,
    code: row.code,
    legalName: row.legalName,
    taxId: row.taxId,
    city: row.city,
    countryCode: row.countryCode,
    status: row.status as SupplierStatus,
  };
}

export const listSuppliers = defineQuery({
  name: 'supplier.list',
  permission: 'supplier.read',
  input: z.strictObject({
    q: z.string().trim().max(100).optional(),
    status: z.enum(SUPPLIER_STATUSES).optional(),
    cursor: z
      .string()
      .regex(/^SUP-[0-9]{6}$/, 'Invalid cursor')
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  handler: async ({ tx }, input): Promise<{ items: SupplierSummaryDto[]; nextCursor: string | null }> => {
    const q = input.q ?? '';
    const rows = await searchSuppliers(tx, {
      status: input.status,
      nameKey: normalizeSupplierName(q),
      codeTerm: q.toUpperCase(),
      taxIdKey: normalizeTaxId(q),
      afterCode: input.cursor,
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return { items: page.map(summary), nextCursor: rows.length > input.limit && last ? last.code : null };
  },
});

export const getSupplier = defineQuery({
  name: 'supplier.get',
  permission: 'supplier.read',
  input: z.strictObject({ supplierId: z.uuid() }),
  handler: async ({ tx, actor }, input): Promise<SupplierDetailDto> => {
    const row = await findSupplier(tx, input.supplierId);
    if (!row) fail('NOT_FOUND', 'Supplier not found.');
    const ids = [row.createdByUserId, row.identityChangedByUserId, row.reviewedByUserId].filter((id): id is string => id !== null);
    const names = await findUserDisplayNames(tx, ids);
    const name = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? 'Unknown user'));
    return {
      ...summary(row),
      email: row.email,
      phone: row.phone,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      region: row.region,
      postalCode: row.postalCode,
      createdBy: name(row.createdByUserId) ?? 'Unknown user',
      createdAt: row.createdAt.toISOString(),
      identityChangedBy: name(row.identityChangedByUserId),
      reviewedBy: name(row.reviewedByUserId),
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewNote: row.reviewNote,
      statusReason: row.statusReason,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
      callerIsMaker: isMaker(row, actor.userId),
      history: await findEntityHistory(tx, [{ entityType: 'supplier', entityId: row.id }], (ids) => findUserDisplayNames(tx, ids)),
    };
  },
});

/** SUP-R1: the suppliers new RFQs and POs may use. Active only. */
export const selectableForPurchasing = defineQuery({
  name: 'supplier.selectableForPurchasing',
  permission: 'supplier.read',
  input: z.strictObject({}),
  handler: async ({ tx }): Promise<SelectableSupplierDto[]> =>
    (await listActiveSuppliers(tx)).map((s) => ({ id: s.id, code: s.code, legalName: s.legalName })),
});
