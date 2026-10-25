import 'server-only';
import { sql } from 'drizzle-orm';
import type { ApprovalDocumentPort, ApprovalOutcome } from '@/modules/approvals';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { isRequisitionStatus, nextRequisitionStatus, type RequisitionCommand } from '../domain/requisition';
import { findRequisition, isVisible, lockRequisition, updateRequisition } from '../infrastructure/requisition-repository';
import { requisitionAudit } from './requisition-input';
import { visibilityFor } from './visibility';

/*
 * The requisition side of an approval (PR-T04 to T06). Registered with the approvals module
 * by the composition root (src/server/approvals.ts), called inside the decision's transaction.
 */

const COMMAND: Record<ApprovalOutcome['outcome'], RequisitionCommand> = { approved: 'approve', rejected: 'reject', returned: 'return' };

export const requisitionApprovalDocument: ApprovalDocumentPort = {
  async lockForDecision(tx, actor, documentId) {
    const row = await lockRequisition(tx, documentId);
    if (!row) return null;
    return { status: row.status, visible: isVisible(await visibilityFor(tx, actor), row) };
  },

  async applyOutcome({ tx, request }, event) {
    const row = await findRequisition(tx, event.documentId);
    if (!row || !isRequisitionStatus(row.status) || row.currentApprovalRequestId !== event.approvalRequestId) {
      throw new Error(`requisition ${event.documentId} is not waiting for approval request ${event.approvalRequestId}`);
    }
    const status = nextRequisitionStatus(row.status, COMMAND[event.outcome]);
    if (!status) throw new Error(`requisition ${row.id} cannot become ${event.outcome} from ${row.status}`);
    await updateRequisition(tx, row.id, row.version, { status, ...(status === 'approved' ? { approvedAt: sql`now()` } : {}) });
    await recordAuditEvent(tx, request, {
      action: `requisition.${event.outcome}`,
      entityType: 'requisition',
      entityId: row.id,
      changes: auditChanges(requisitionAudit, { status: row.status }, { status }),
      ...(event.comment ? { reason: event.comment } : {}),
    });
    return status;
  },
};
