import 'server-only';
import { z } from 'zod';
import { findDepartmentDirectory, findUserDisplayNames } from '@/modules/identity';
import { defineQuery } from '@/shared/application/runner';
import { dec, toFixedScale } from '@/shared/decimal/decimal';
import type { ApprovalDocumentType, StepRole } from '../domain/approval';
import { searchInbox } from '../infrastructure/approval-repository';
import { stepLabel, stepRoleScopes } from './approval-requests';

/*
 * US-AP-01: the steps the caller can decide right now, oldest first. Filtered in SQL by role,
 * scope, and separation of duties. Anyone eligible for a step can also see its document
 * (an approver sees their departments, an org-wide approver and finance see everything),
 * so the inbox reveals nothing the caller could not open anyway.
 */

export type InboxItemDto = {
  approvalRequestId: string;
  requestVersion: number;
  documentType: ApprovalDocumentType;
  documentId: string;
  documentNumber: string;
  documentTitle: string;
  departmentCode: string;
  amount: string;
  currencyCode: string;
  currencyScale: number;
  round: number;
  stepNo: number;
  stepCount: number;
  label: string;
  submittedBy: string;
  submittedAt: string;
  waitingSince: string;
};
export const INBOX_ITEM_KEYS = [
  'approvalRequestId',
  'requestVersion',
  'documentType',
  'documentId',
  'documentNumber',
  'documentTitle',
  'departmentCode',
  'amount',
  'currencyCode',
  'currencyScale',
  'round',
  'stepNo',
  'stepCount',
  'label',
  'submittedBy',
  'submittedAt',
  'waitingSince',
] as const;

export const approvalInbox = defineQuery({
  name: 'approval.inbox',
  permission: 'approval.decide',
  input: z.strictObject({ limit: z.number().int().min(1).max(100).default(50) }),
  handler: async ({ tx, actor }, input): Promise<{ items: InboxItemDto[]; more: boolean }> => {
    const rows = await searchInbox(tx, { userId: actor.userId, scopes: await stepRoleScopes(tx, actor.userId), limit: input.limit + 1 });
    const page = rows.slice(0, input.limit);
    const names = await findUserDisplayNames(tx, [...new Set(page.map((r) => r.request.submittedByUserId))]);
    const directory = await findDepartmentDirectory(tx);
    const codes = new Map(directory.map((d) => [d.id, d.code]));
    return {
      items: page.map(({ request, step, stepCount }) => ({
        approvalRequestId: request.id,
        requestVersion: request.version,
        documentType: request.documentType as ApprovalDocumentType,
        documentId: request.documentId,
        documentNumber: request.documentNumber,
        documentTitle: request.documentTitle,
        departmentCode: codes.get(request.departmentId) ?? '',
        amount: toFixedScale(dec(request.amountSnapshot), request.currencyScale),
        currencyCode: request.currencyCode,
        currencyScale: request.currencyScale,
        round: request.round,
        stepNo: step.stepNo,
        stepCount,
        label: stepLabel(step.requiredRole as StepRole, step.scopeDepartmentId ? (codes.get(step.scopeDepartmentId) ?? null) : null),
        submittedBy: names.get(request.submittedByUserId) ?? 'Unknown user',
        submittedAt: request.createdAt.toISOString(),
        waitingSince: (step.activatedAt ?? request.createdAt).toISOString(),
      })),
      more: rows.length > input.limit,
    };
  },
});
