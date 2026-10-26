import 'server-only';
import { lockRequisitionForSourcing, type RequisitionForSourcing } from '@/modules/requisitions';
import type { Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
import { isRfqStatus, nextRfqStatus, type RfqCommand, type RfqStatus } from '../domain/rfq';
import { findRfq, lockRfq, type RfqRow } from '../infrastructure/rfq-repository';

/*
 * Loading and locking RFQs for the sourcing commands. Lock order (ADR 0008 C8): the requisition,
 * then the RFQ, then its quotations. A command that does not need the requisition starts at the RFQ.
 */

export type LoadedRfq = RfqRow & { status: RfqStatus };

export const RFQ_STATUS_LABEL: Record<RfqStatus, string> = {
  draft: 'a draft',
  issued: 'issued',
  closed: 'closed',
  awarded: 'awarded',
  cancelled: 'cancelled',
};

export async function lockRfqRow(tx: Tx, id: string): Promise<LoadedRfq> {
  const row = await lockRfq(tx, id);
  if (!row) fail('NOT_FOUND', 'RFQ not found.');
  if (!isRfqStatus(row.status)) throw new Error(`Unknown RFQ status ${row.status}`);
  return { ...row, status: row.status };
}

/** The requisition first, then the RFQ (C8). The RFQ is read once without a lock to find its requisition. */
export async function lockRfqWithRequisition(tx: Tx, id: string): Promise<{ row: LoadedRfq; requisition: RequisitionForSourcing }> {
  const found = await findRfq(tx, id);
  if (!found) fail('NOT_FOUND', 'RFQ not found.');
  const requisition = await lockRequisitionForSourcing(tx, found.requisitionId);
  if (!requisition) throw new Error(`requisition ${found.requisitionId} of RFQ ${id} is missing`);
  return { row: await lockRfqRow(tx, id), requisition };
}

export function assertRfqTransition(row: LoadedRfq, command: RfqCommand, verb: string): RfqStatus {
  const status = nextRfqStatus(row.status, command);
  if (!status) fail('INVALID_TRANSITION', `An RFQ that is ${RFQ_STATUS_LABEL[row.status]} cannot be ${verb}.`);
  return status;
}

export function assertRfqVersion(row: RfqRow, expectedVersion: number): void {
  if (row.version !== expectedVersion) fail('CONFLICT', 'This RFQ was changed since you loaded it. Reload the page and try again.');
}

export function assertRequisitionApproved(requisition: RequisitionForSourcing): void {
  if (requisition.status !== 'approved') {
    failBusinessRule('REQUISITION_NOT_APPROVED', `Requisition ${requisition.number} is not approved, so it cannot be sourced.`);
  }
}
