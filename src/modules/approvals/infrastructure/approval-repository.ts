import 'server-only';
import { and, asc, desc, eq, exists, inArray, isNotNull, max, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, Tx } from '@/shared/db/transaction';
import type { ApprovalDocumentType, RoleScope, StepRole, StepStatus } from '../domain/approval';
import { approvalRequests, approvalSteps } from './schema';

type Queryable = Database | Tx;

export type RequestRow = typeof approvalRequests.$inferSelect;
export type StepRow = typeof approvalSteps.$inferSelect;

export async function insertRequest(
  tx: Tx,
  values: Pick<
    RequestRow,
    | 'documentType'
    | 'documentId'
    | 'round'
    | 'documentNumber'
    | 'documentTitle'
    | 'amountSnapshot'
    | 'currencyCode'
    | 'currencyScale'
    | 'departmentId'
    | 'policyId'
    | 'policyVersionNo'
    | 'submittedByUserId'
    | 'awardedByUserId'
  >,
): Promise<string> {
  const [row] = await tx.insert(approvalRequests).values(values).returning({ id: approvalRequests.id });
  if (!row) throw new Error('approval request insert returned no row');
  return row.id;
}

export async function insertSteps(
  tx: Tx,
  approvalRequestId: string,
  steps: readonly { stepNo: number; requiredRole: StepRole; scopeDepartmentId: string | null; status: StepStatus }[],
): Promise<void> {
  await tx.insert(approvalSteps).values(
    steps.map((s) => ({ ...s, approvalRequestId, activatedAt: s.status === 'pending' ? sql`now()` : null })),
  );
}

/** The highest round so far for a document (0 before its first submission). */
export async function lastRound(tx: Tx, documentType: ApprovalDocumentType, documentId: string): Promise<number> {
  const [row] = await tx
    .select({ round: max(approvalRequests.round) })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.documentType, documentType), eq(approvalRequests.documentId, documentId)));
  return row?.round ?? 0;
}

export async function findRequest(db: Queryable, id: string): Promise<RequestRow | null> {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  return row ?? null;
}

export async function lockRequest(tx: Tx, id: string): Promise<RequestRow | null> {
  const [row] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).for('update');
  return row ?? null;
}

export async function findSteps(db: Queryable, approvalRequestId: string): Promise<StepRow[]> {
  return db.select().from(approvalSteps).where(eq(approvalSteps.approvalRequestId, approvalRequestId)).orderBy(asc(approvalSteps.stepNo));
}

/** Moves one step, only from the status it was read in (the request row lock serializes callers). */
export async function updateStep(
  tx: Tx,
  approvalRequestId: string,
  stepNo: number,
  from: StepStatus,
  values: { status: StepStatus; decidedByUserId?: string; comment?: string | null; activate?: boolean; decide?: boolean },
): Promise<void> {
  const rows = await tx
    .update(approvalSteps)
    .set({
      status: values.status,
      ...(values.activate ? { activatedAt: sql`now()` } : {}),
      ...(values.decide ? { decidedByUserId: values.decidedByUserId, decidedAt: sql`now()`, comment: values.comment ?? null } : {}),
    })
    .where(and(eq(approvalSteps.approvalRequestId, approvalRequestId), eq(approvalSteps.stepNo, stepNo), eq(approvalSteps.status, from)))
    .returning({ id: approvalSteps.id });
  if (rows.length !== 1) throw new Error(`approval step ${stepNo} changed under its request lock`);
}

export async function updateRequest(
  tx: Tx,
  id: string,
  expectedVersion: number,
  values: { status?: RequestRow['status']; completed?: boolean },
): Promise<number> {
  const [row] = await tx
    .update(approvalRequests)
    .set({
      ...(values.status ? { status: values.status } : {}),
      ...(values.completed ? { completedAt: sql`now()` } : {}),
      version: sql`${approvalRequests.version} + 1`,
    })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.version, expectedVersion)))
    .returning({ version: approvalRequests.version });
  if (!row) throw new Error('approval_requests row changed under its lock');
  return row.version;
}

/** Every round of a document, oldest first, with its steps. */
export async function findRequestsWithSteps(
  db: Queryable,
  documentType: ApprovalDocumentType,
  documentId: string,
): Promise<{ request: RequestRow; steps: StepRow[] }[]> {
  const requests = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.documentType, documentType), eq(approvalRequests.documentId, documentId)))
    .orderBy(asc(approvalRequests.round));
  if (requests.length === 0) return [];
  const steps = await db
    .select()
    .from(approvalSteps)
    .where(
      inArray(
        approvalSteps.approvalRequestId,
        requests.map((r) => r.id),
      ),
    )
    .orderBy(asc(approvalSteps.stepNo));
  return requests.map((request) => ({ request, steps: steps.filter((s) => s.approvalRequestId === request.id) }));
}

export type InboxRow = { request: RequestRow; step: StepRow; stepCount: number };

/**
 * US-AP-01, filtered in SQL: pending steps of pending requests that the user's role scopes
 * cover, minus the ones separation of duties bars them from (SOD-01, SOD-02).
 */
export async function searchInbox(
  db: Queryable,
  search: { userId: string; scopes: Readonly<Record<StepRole, RoleScope>>; document?: { type: ApprovalDocumentType; id: string }; limit: number },
): Promise<InboxRow[]> {
  const coverage = (Object.entries(search.scopes) as [StepRole, RoleScope][])
    .map(([role, scope]): SQL | undefined => {
      if (scope.organizationWide) return eq(approvalSteps.requiredRole, role);
      if (scope.departmentIds.length === 0) return undefined;
      return and(eq(approvalSteps.requiredRole, role), inArray(approvalSteps.scopeDepartmentId, [...scope.departmentIds]));
    })
    .filter((condition) => condition !== undefined);
  if (coverage.length === 0) return [];

  const decided = alias(approvalSteps, 'decided');
  const rows = await db
    .select({
      request: approvalRequests,
      step: approvalSteps,
      stepCount: sql<number>`(select count(*)::int from approval_steps counted where counted.approval_request_id = ${approvalRequests.id})`,
    })
    .from(approvalSteps)
    .innerJoin(approvalRequests, eq(approvalRequests.id, approvalSteps.approvalRequestId))
    .where(
      and(
        eq(approvalSteps.status, 'pending'),
        eq(approvalRequests.status, 'pending'),
        or(...coverage),
        ne(approvalRequests.submittedByUserId, search.userId),
        or(sql`${approvalRequests.awardedByUserId} IS NULL`, ne(approvalRequests.awardedByUserId, search.userId)),
        sql`not ${exists(
          db
            .select({ one: sql`1` })
            .from(decided)
            .where(and(eq(decided.approvalRequestId, approvalRequests.id), isNotNull(decided.decidedByUserId), eq(decided.decidedByUserId, search.userId))),
        )}`,
        search.document ? and(eq(approvalRequests.documentType, search.document.type), eq(approvalRequests.documentId, search.document.id)) : undefined,
      ),
    )
    .orderBy(asc(approvalSteps.activatedAt), desc(approvalRequests.id))
    .limit(search.limit);
  return rows;
}
