import { defineAuditPolicy } from '@/modules/audit';
import type { StepStatus } from '../domain/approval';

/** Audit fields of an approval request: its status, and its steps as "1. approved". */
export const approvalAudit = defineAuditPolicy<{
  documentNumber: string;
  round: number;
  amount: string;
  route: string[];
  steps: string[];
  status: string;
}>({
  entityType: 'approval_request',
  fields: ['documentNumber', 'round', 'amount', 'route', 'steps', 'status'],
});

export function stepSummaries(steps: readonly { stepNo: number; status: StepStatus }[]): string[] {
  return [...steps].sort((a, b) => a.stepNo - b.stepNo).map((s) => `${s.stepNo}. ${s.status}`);
}
