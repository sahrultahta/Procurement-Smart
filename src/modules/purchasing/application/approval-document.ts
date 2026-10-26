import 'server-only';
import { sql } from 'drizzle-orm';
import type { ApprovalDocumentPort, ApprovalOutcome } from '@/modules/approvals';
import { auditChanges, recordAuditEvent } from '@/modules/audit';
import { lockRequisitionForPurchasing } from '@/modules/requisitions';
import { isPurchaseOrderStatus, nextPurchaseOrderStatus, type PurchaseOrderCommand } from '../domain/purchase-order';
import { findPurchaseOrder, findPurchaseOrderLines, isVisible, lockPurchaseOrder, updatePurchaseOrder } from '../infrastructure/purchase-order-repository';
import { releaseAll } from './purchase-order-commands';
import { purchaseOrderAudit } from './purchase-order-input';
import { visibilityFor } from './visibility';

/*
 * The purchase-order side of an approval (PO-T04). Registered with the approvals module by the
 * composition root (src/server/approvals.ts), called inside the decision's transaction. A
 * rejected order is terminal and gives every reserved quantity back to its requisition.
 */

const COMMAND: Record<ApprovalOutcome['outcome'], PurchaseOrderCommand> = { approved: 'approve', rejected: 'reject', returned: 'return' };

export const purchaseOrderApprovalDocument: ApprovalDocumentPort = {
  async lockForDecision(tx, actor, documentId) {
    const found = await findPurchaseOrder(tx, documentId);
    if (!found) return null;
    // The requisition, then the order (ADR 0008 C8), as every purchase-order command does.
    await lockRequisitionForPurchasing(tx, found.requisitionId);
    const row = await lockPurchaseOrder(tx, documentId);
    if (!row) return null;
    return { status: row.status, visible: isVisible(await visibilityFor(tx, actor), row) };
  },

  async applyOutcome({ tx, request }, event) {
    const row = await findPurchaseOrder(tx, event.documentId);
    if (!row || !isPurchaseOrderStatus(row.status) || row.currentApprovalRequestId !== event.approvalRequestId) {
      throw new Error(`purchase order ${event.documentId} is not waiting for approval request ${event.approvalRequestId}`);
    }
    const status = nextPurchaseOrderStatus(row.status, COMMAND[event.outcome]);
    if (!status) throw new Error(`purchase order ${row.id} cannot become ${event.outcome} from ${row.status}`);
    let released: string[] = [];
    if (status === 'rejected') {
      const requisition = await lockRequisitionForPurchasing(tx, row.requisitionId);
      if (!requisition) throw new Error(`requisition ${row.requisitionId} of purchase order ${row.id} is missing`);
      released = await releaseAll(tx, requisition, await findPurchaseOrderLines(tx, row.id));
    }
    await updatePurchaseOrder(tx, row.id, row.version, { status, ...(status === 'approved' ? { approvedAt: sql`now()` } : {}) });
    await recordAuditEvent(tx, request, {
      action: `po.${event.outcome}`,
      entityType: 'purchase_order',
      entityId: row.id,
      changes: auditChanges(purchaseOrderAudit, { status: row.status }, { status, ...(released.length > 0 ? { released } : {}) }),
      ...(event.comment ? { reason: event.comment } : {}),
    });
    return status;
  },
};
