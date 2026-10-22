import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import type { RequestContext } from '@/shared/application/context';
import { defineCommand } from '@/shared/application/runner';
import { allocateDocumentNumber, formatDocumentNumber } from '@/shared/db/document-numbers';
import type { Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
import { isMaker, isSupplierStatus, nextSupplierStatus, type SupplierCommand, type SupplierStatus } from '../domain/supplier';
import {
  findLiveNameOwner,
  findTaxIdOwner,
  insertSupplier,
  lockSupplier,
  updateSupplier,
  type SupplierFields,
  type SupplierRow,
} from '../infrastructure/supplier-repository';
import { reasonField, supplierAudit, supplierFields, toColumns, versionField } from './supplier-input';

/*
 * Supplier commands (US-SUP-01 to 03, docs/state-machines.md §3). Each one locks the
 * supplier row, checks the version the user saw (ADR 0008 C1), then asks the pure
 * transition table whether the change is allowed from the status as it now stands.
 */

const STATUS_LABEL: Record<SupplierStatus, string> = {
  pending_review: 'pending review',
  active: 'active',
  blocked: 'blocked',
  inactive: 'inactive',
};

const supplierId = z.uuid();

async function load(tx: Tx, id: string, expectedVersion: number): Promise<SupplierRow & { status: SupplierStatus }> {
  const row = await lockSupplier(tx, id);
  if (!row) fail('NOT_FOUND', 'Supplier not found.');
  if (row.version !== expectedVersion) fail('CONFLICT', 'This supplier was changed by someone else. Reload the page and try again.');
  if (!isSupplierStatus(row.status)) throw new Error(`Unknown supplier status ${row.status}`);
  return { ...row, status: row.status };
}

function transition(status: SupplierStatus, command: SupplierCommand, action: string): SupplierStatus {
  const next = nextSupplierStatus(status, command);
  if (!next) fail('INVALID_TRANSITION', `A supplier that is ${STATUS_LABEL[status]} cannot be ${action}.`);
  return next;
}

/** SUPPLIER_DUPLICATE: same name key among non-inactive suppliers, or same tax ID key anywhere. */
async function assertUnique(tx: Tx, fields: Pick<SupplierFields, 'normalizedName' | 'taxIdNormalized'>, exceptId: string | null) {
  const byName = await findLiveNameOwner(tx, fields.normalizedName, exceptId);
  if (byName) {
    failBusinessRule('SUPPLIER_DUPLICATE', `Supplier ${byName.code} already has this name.`, { field: 'legalName', code: byName.code });
  }
  if (fields.taxIdNormalized) {
    const byTaxId = await findTaxIdOwner(tx, fields.taxIdNormalized, exceptId);
    if (byTaxId) {
      failBusinessRule('SUPPLIER_DUPLICATE', `Supplier ${byTaxId.code} already has this tax ID.`, { field: 'taxId', code: byTaxId.code });
    }
  }
}

function snapshot(row: Pick<SupplierRow, keyof SupplierFields | 'code' | 'status'>) {
  return {
    code: row.code,
    legalName: row.legalName,
    taxId: row.taxId,
    email: row.email,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    status: row.status,
  };
}

async function audit(
  tx: Tx,
  request: RequestContext,
  action: string,
  id: string,
  before: SupplierRow | null,
  after: Parameters<typeof snapshot>[0],
  reason?: string | null,
): Promise<void> {
  await recordAuditEvent(tx, request, {
    action,
    entityType: 'supplier',
    entityId: id,
    changes: auditChanges(supplierAudit, before ? snapshot(before) : null, snapshot(after)),
    ...(reason ? { reason } : {}),
  });
}

/** SUP-T01 */
export const createSupplier = defineCommand({
  name: 'supplier.create',
  permission: 'supplier.manage',
  input: z.strictObject(supplierFields),
  handler: async ({ tx, actor, request }, input): Promise<{ supplierId: string; code: string }> => {
    // The number row lock also serializes concurrent creates, so the duplicate check below sees
    // every committed supplier; the insert's ON CONFLICT is the backstop for other races.
    const code = formatDocumentNumber('SUP', 0, await allocateDocumentNumber(tx, 'SUP', 0));
    const fields = toColumns(input);
    await assertUnique(tx, fields, null);
    const id = await insertSupplier(tx, { ...fields, code, createdByUserId: actor.userId });
    if (!id) failBusinessRule('SUPPLIER_DUPLICATE', 'A supplier with this name or tax ID already exists.');
    await audit(tx, request, 'supplier.created', id, null, { ...fields, code, status: 'pending_review' });
    return { supplierId: id, code };
  },
});

/** SUP-T02 (contact fields) and SUP-T03 (legal name or tax ID: back to review). */
export const updateSupplierDetails = defineCommand({
  name: 'supplier.update',
  permission: 'supplier.manage',
  input: z.strictObject({ supplierId, expectedVersion: versionField, ...supplierFields }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: SupplierStatus }> => {
    const row = await load(tx, input.supplierId, input.expectedVersion);
    const fields = toColumns(input);
    const changed = Object.keys(auditChanges(supplierAudit, snapshot(row), snapshot({ ...row, ...fields }))).length > 0;
    if (!changed) return { version: row.version, status: row.status };

    // Conservative on purpose: any edit of the legal name or tax ID as typed is an identity change.
    const identityChanged = fields.legalName !== row.legalName || fields.taxId !== row.taxId;
    const status = transition(row.status, identityChanged ? 'update.identity' : 'update.contact', 'edited');
    if (identityChanged) await assertUnique(tx, fields, row.id);

    const version = await updateSupplier(tx, row.id, row.version, {
      ...fields,
      status,
      // A new identity needs a new review, by someone other than this user (SOD-03, AB-04).
      ...(identityChanged ? { identityChangedByUserId: actor.userId, reviewedByUserId: null, reviewedAt: null, reviewNote: null } : {}),
    });
    await audit(tx, request, 'supplier.updated', row.id, row, { ...row, ...fields, status });
    return { version, status };
  },
});

/** SUP-T04 / SUP-T05 */
export const reviewSupplier = defineCommand({
  name: 'supplier.review',
  permission: 'supplier.review',
  input: z
    .strictObject({
      supplierId,
      expectedVersion: versionField,
      decision: z.enum(['approve', 'reject']),
      note: z.preprocess((v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v), z.string().trim().max(2000).nullable()),
    })
    .refine((input) => input.decision === 'approve' || input.note !== null, { message: 'Give a reason for rejecting', path: ['note'] }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number; status: SupplierStatus }> => {
    const row = await load(tx, input.supplierId, input.expectedVersion);
    const status = transition(row.status, input.decision === 'approve' ? 'review.approve' : 'review.reject', 'reviewed');
    if (isMaker(row, actor.userId)) {
      failBusinessRule('MAKER_CHECKER', 'You created this supplier or last changed its identity, so someone else must review it.');
    }
    const version = await updateSupplier(tx, row.id, row.version, {
      status,
      reviewedByUserId: actor.userId,
      reviewedAt: sql`now()`,
      reviewNote: input.note,
      statusReason: input.decision === 'reject' ? input.note : null,
    });
    await audit(tx, request, 'supplier.reviewed', row.id, row, { ...row, status }, input.note);
    return { version, status };
  },
});

const statusChange = z.strictObject({ supplierId, expectedVersion: versionField, reason: reasonField });

/** SUP-T06: procurement or finance (`supplier.block`, ADR 0006 amendment). */
export const blockSupplier = defineCommand({
  name: 'supplier.block',
  permission: 'supplier.block',
  input: statusChange,
  handler: async ({ tx, request }, input): Promise<{ version: number; status: SupplierStatus }> => {
    const row = await load(tx, input.supplierId, input.expectedVersion);
    const status = transition(row.status, 'block', 'blocked');
    const version = await updateSupplier(tx, row.id, row.version, { status, statusReason: input.reason });
    await audit(tx, request, 'supplier.blocked', row.id, row, { ...row, status }, input.reason);
    return { version, status };
  },
});

/** SUP-T07: back to review, never straight to active. */
export const unblockSupplier = defineCommand({
  name: 'supplier.unblock',
  permission: 'supplier.review',
  input: statusChange,
  handler: async ({ tx, request }, input): Promise<{ version: number; status: SupplierStatus }> => {
    const row = await load(tx, input.supplierId, input.expectedVersion);
    const status = transition(row.status, 'unblock', 'unblocked');
    const version = await updateSupplier(tx, row.id, row.version, {
      status,
      statusReason: null,
      reviewedByUserId: null,
      reviewedAt: null,
      reviewNote: null,
    });
    await audit(tx, request, 'supplier.unblocked', row.id, row, { ...row, status }, input.reason);
    return { version, status };
  },
});

/** SUP-T08 */
export const deactivateSupplier = defineCommand({
  name: 'supplier.deactivate',
  permission: 'supplier.manage',
  input: statusChange,
  handler: async ({ tx, request }, input): Promise<{ version: number; status: SupplierStatus }> => {
    const row = await load(tx, input.supplierId, input.expectedVersion);
    const status = transition(row.status, 'deactivate', 'deactivated');
    const version = await updateSupplier(tx, row.id, row.version, { status, statusReason: input.reason });
    await audit(tx, request, 'supplier.deactivated', row.id, row, { ...row, status }, input.reason);
    return { version, status };
  },
});

/** SUP-T09: the name must still be free among live suppliers; then a fresh review. */
export const reactivateSupplier = defineCommand({
  name: 'supplier.reactivate',
  permission: 'supplier.manage',
  input: z.strictObject({ supplierId, expectedVersion: versionField }),
  handler: async ({ tx, request }, input): Promise<{ version: number; status: SupplierStatus }> => {
    const row = await load(tx, input.supplierId, input.expectedVersion);
    const status = transition(row.status, 'reactivate', 'reactivated');
    await assertUnique(tx, row, row.id);
    const version = await updateSupplier(tx, row.id, row.version, {
      status,
      statusReason: null,
      reviewedByUserId: null,
      reviewedAt: null,
      reviewNote: null,
    });
    await audit(tx, request, 'supplier.reactivated', row.id, row, { ...row, status });
    return { version, status };
  },
});
