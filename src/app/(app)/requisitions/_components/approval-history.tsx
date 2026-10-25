import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoney, formatTimestamp } from '@/lib/format';
import type { ApprovalRoundDto, RequestStatus } from '@/modules/approvals';
import { stepStatusLabel } from './requisition-status';

const ROUND_LABELS: Record<RequestStatus, string> = {
  pending: 'in progress',
  approved: 'approved',
  rejected: 'rejected',
  returned: 'returned for changes',
  cancelled: 'cancelled (withdrawn)',
};

/** US-AP-04: every round, newest first, with who decided what, when, and why. */
export function ApprovalHistory({
  rounds,
  currency,
  timezone,
}: {
  rounds: ApprovalRoundDto[];
  currency: { code: string; scale: number };
  timezone: string;
}) {
  if (rounds.length === 0) return <p className="text-sm text-muted-foreground">Not submitted for approval yet.</p>;
  return (
    <div className="grid gap-6">
      {[...rounds].reverse().map((round) => (
        <section key={round.round} className="grid gap-2" aria-labelledby={`round-${round.round}`}>
          <h3 id={`round-${round.round}`} className="text-sm font-medium">
            Round {round.round}: {ROUND_LABELS[round.status]}
          </h3>
          <p className="text-sm text-muted-foreground">
            Submitted by {round.submittedBy} on {formatTimestamp(round.submittedAt, timezone)} for{' '}
            {formatMoney(round.amount, currency.code, currency.scale)} (approval policy version {round.policyVersionNo})
          </p>
          <Table aria-label={`Approval round ${round.round}`}>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Decided by role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Decided by</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Comment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {round.steps.map((step) => (
                <TableRow key={step.stepNo}>
                  <TableCell>{step.stepNo}</TableCell>
                  <TableCell>{step.label}</TableCell>
                  <TableCell>{stepStatusLabel(step.status)}</TableCell>
                  <TableCell>{step.decidedBy ?? '—'}</TableCell>
                  <TableCell>{step.decidedAt ? formatTimestamp(step.decidedAt, timezone) : '—'}</TableCell>
                  <TableCell className="whitespace-pre-line">{step.comment ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ))}
    </div>
  );
}
