import 'server-only';
import { decideApproval, registerApprovalDocument } from '@/modules/approvals';
import { requisitionApprovalDocument } from '@/modules/requisitions';

/*
 * Composition root for approvals (docs/architecture.md): the approvals module never imports
 * the documents it approves, so each document module's handler is registered here.
 * Anything that decides approvals imports `decideApproval` from this file, never from the
 * module directly, so the handlers are always in place.
 */
registerApprovalDocument('requisition', requisitionApprovalDocument);

export { decideApproval };
