import 'server-only';
import type { Actor } from '@/shared/application/context';
import type { HandlerContext } from '@/shared/application/runner';
import type { Tx } from '@/shared/db/transaction';
import type { ApprovalDocumentType, DecisionOutcome } from '../domain/approval';

/*
 * The approvals module never imports the documents it approves (docs/architecture.md).
 * Each document module implements this port, and the composition root (src/server/approvals.ts)
 * registers it. Both calls run inside the decision's transaction.
 */

export type ApprovalOutcome = {
  readonly documentId: string;
  readonly approvalRequestId: string;
  readonly outcome: NonNullable<DecisionOutcome['requestStatus']>;
  /** The deciding approver's comment (always present for reject and return). */
  readonly comment: string | null;
};

export type ApprovalDocumentPort = {
  /**
   * Locks the document row before its approval request (ADR 0008 C8: the same order as
   * submit and withdraw) and says whether the actor may see it. Null if it does not exist.
   */
  lockForDecision(tx: Tx, actor: Actor, documentId: string): Promise<{ status: string; visible: boolean } | null>;
  /** The request ended: move the document (PR-T04 to T06) and audit it. Returns its new status. */
  applyOutcome(context: HandlerContext, outcome: ApprovalOutcome): Promise<string>;
};

const ports = new Map<ApprovalDocumentType, ApprovalDocumentPort>();

/** Called by the composition root at startup. Registering again replaces the handler (dev reloads). */
export function registerApprovalDocument(documentType: ApprovalDocumentType, port: ApprovalDocumentPort): void {
  ports.set(documentType, port);
}

export function approvalDocumentPort(documentType: ApprovalDocumentType): ApprovalDocumentPort {
  const port = ports.get(documentType);
  if (!port) throw new Error(`No approval handler is registered for ${documentType} documents (import @/server/approvals)`);
  return port;
}
