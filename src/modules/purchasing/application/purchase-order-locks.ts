import 'server-only';
import { lockRequisitionForPurchasing, type RequisitionForPurchasing } from '@/modules/requisitions';
import type { Actor } from '@/shared/application/context';
import type { Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
import { isPurchaseOrderStatus, nextPurchaseOrderStatus, type PurchaseOrderCommand, type PurchaseOrderStatus } from '../domain/purchase-order';
import { findPurchaseOrder, lockPurchaseOrder, type PurchaseOrderRow } from '../infrastructure/purchase-order-repository';

/*
 * Loading and locking purchase orders. Lock order (ADR 0008 C8): the requisition, then the
 * purchase order, then (approvals) its approval round, then requisition lines in id order.
 */

export type LoadedOrder = PurchaseOrderRow & { status: PurchaseOrderStatus };

export const PO_STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: 'a draft',
  pending_approval: 'waiting for approval',
  approved: 'approved',
  issued: 'issued',
  partially_received: 'partially received',
  received: 'received',
  closed: 'closed',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

function loaded(row: PurchaseOrderRow | null): LoadedOrder {
  if (!row) fail('NOT_FOUND', 'Purchase order not found.');
  if (!isPurchaseOrderStatus(row.status)) throw new Error(`Unknown purchase order status ${row.status}`);
  return { ...row, status: row.status };
}

/** Only the purchase order, for commands that change nothing else (issuing). */
export async function lockOrderRow(tx: Tx, id: string): Promise<LoadedOrder> {
  return loaded(await lockPurchaseOrder(tx, id));
}

/** The requisition first, then the purchase order (C8). The order is read once without a lock to find its requisition. */
export async function lockOrderWithRequisition(tx: Tx, id: string): Promise<{ row: LoadedOrder; requisition: RequisitionForPurchasing }> {
  const found = await findPurchaseOrder(tx, id);
  if (!found) fail('NOT_FOUND', 'Purchase order not found.');
  const requisition = await lockRequisitionForPurchasing(tx, found.requisitionId);
  if (!requisition) throw new Error(`requisition ${found.requisitionId} of purchase order ${id} is missing`);
  return { row: loaded(await lockPurchaseOrder(tx, id)), requisition };
}

export function assertOrderTransition(row: LoadedOrder, command: PurchaseOrderCommand, verb: string): PurchaseOrderStatus {
  const status = nextPurchaseOrderStatus(row.status, command);
  if (!status) fail('INVALID_TRANSITION', `A purchase order that is ${PO_STATUS_LABEL[row.status]} cannot be ${verb}.`);
  return status;
}

export function assertOrderVersion(row: PurchaseOrderRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) fail('CONFLICT', 'This purchase order was changed since you loaded it. Reload the page and try again.');
}

/** Decision 4: only the creator edits and submits, so SOD-01 (the submitter never decides) covers the creator. */
export function assertCreator(row: PurchaseOrderRow, actor: Actor, verb: string): void {
  if (row.createdByUserId !== actor.userId) fail('FORBIDDEN', `Only the buyer who created this purchase order can ${verb} it.`);
}

export function assertRequisitionApproved(requisition: RequisitionForPurchasing): void {
  if (requisition.status !== 'approved') {
    failBusinessRule('REQUISITION_NOT_APPROVED', `Requisition ${requisition.number} is not approved, so nothing more can be ordered from it.`);
  }
}
