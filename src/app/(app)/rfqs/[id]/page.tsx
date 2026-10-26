import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAmount, formatDate, formatMoney, formatTimestamp, formatUnitPrice } from '@/lib/format';
import { getRfq, type QuotationDto, type RfqDetailDto } from '@/modules/sourcing';
import { getOrganization } from '@/server/organization-profile';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { AwardForm, SubmitQuotationForm, WithdrawQuotationForm } from '../_components/quotation-actions';
import { CancelRfqForm, CloseRfqForm, IssueRfqForm } from '../_components/rfq-actions';
import { RfqStatusBadge, quotationStatusLabel, rfqNotice, validityLabel } from '../_components/rfq-status';

export const metadata: Metadata = { title: 'RFQ' };

/** Quotations that were submitted at some point and not withdrawn: what the comparison shows. */
const compared = (q: QuotationDto) => q.status === 'submitted' || q.status === 'awarded' || q.status === 'not_awarded';

export default async function RfqPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await props.params;
  const notice = rfqNotice((await props.searchParams).notice);
  const request = await getRequestContext();
  const result = await runQuery(request, getRfq, { rfqId: id });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND' || result.error.code === 'VALIDATION_FAILED') notFound();
    return (
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold">{result.error.code === 'FORBIDDEN' ? 'Access denied' : 'RFQ'}</h1>
        <p className="text-muted-foreground">{result.error.message}</p>
      </div>
    );
  }
  const r = result.data;
  const { timezone } = await getOrganization();
  const can = new Set(r.callerActions);
  const manages = can.has('edit') || can.has('issue') || can.has('close') || can.has('cancel');
  const money = (value: string) => formatMoney(value, r.currencyCode, r.currencyScale);
  const live = new Set(r.quotations.filter((q) => q.status !== 'withdrawn').map((q) => q.supplierId));
  const recordable = can.has('record') ? r.suppliers.filter((s) => s.status === 'active' && !live.has(s.id)) : [];
  const draftCount = r.quotations.filter((q) => q.status === 'draft').length;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{r.title}</h1>
          <RfqStatusBadge status={r.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{r.number}</span> · for{' '}
          <Link href={`/requisitions/${r.requisitionId}`} className="font-mono underline-offset-4 hover:underline">
            {r.requisitionNumber}
          </Link>{' '}
          ({r.requisitionTitle}) · created by {r.createdBy} on {formatTimestamp(r.createdAt, timezone)}
        </p>
      </div>

      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {r.requisitionStatus !== 'approved' && (r.status === 'draft' || r.status === 'issued' || r.status === 'closed') ? (
        <Alert>
          <AlertDescription>Requisition {r.requisitionNumber} is no longer approved, so this RFQ cannot be issued or awarded.</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Details</h2>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Quotations due</dt>
            <dd>{formatTimestamp(r.responseDueAt, timezone)}</dd>
            <dt className="text-muted-foreground">Requisition estimate</dt>
            <dd>{money(r.requisitionEstimatedTotal)}</dd>
            {r.issuedAt ? (
              <>
                <dt className="text-muted-foreground">Issued</dt>
                <dd>
                  {formatTimestamp(r.issuedAt, timezone)} by {r.issuedBy}
                </dd>
              </>
            ) : null}
            {r.closedAt ? (
              <>
                <dt className="text-muted-foreground">Closed</dt>
                <dd>
                  {formatTimestamp(r.closedAt, timezone)} by {r.closedBy}
                </dd>
              </>
            ) : null}
            {r.cancelledAt ? (
              <>
                <dt className="text-muted-foreground">Cancelled</dt>
                <dd>
                  {formatTimestamp(r.cancelledAt, timezone)} by {r.cancelledBy}: {r.cancelReason}
                </dd>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Lines</h2>
        </CardHeader>
        <CardContent>
          <Table aria-label="Lines">
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Requisition line</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.lines.map((l) => (
                <TableRow key={l.lineNo}>
                  <TableCell>{l.lineNo}</TableCell>
                  <TableCell className="whitespace-normal">{l.description}</TableCell>
                  <TableCell className="text-right">
                    {l.quantity} {l.uom}
                  </TableCell>
                  <TableCell>{l.requisitionLineNo}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Invited suppliers</h2>
        </CardHeader>
        <CardContent>
          {r.suppliers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No supplier invited yet.</p>
          ) : (
            <Table aria-label="Invited suppliers">
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Supplier status</TableHead>
                  <TableHead>Invited</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.suppliers.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.legalName}</TableCell>
                    <TableCell className="font-mono">{s.code}</TableCell>
                    <TableCell>{s.status === 'active' ? 'Active' : `Not active (${s.status.replace('_', ' ')})`}</TableCell>
                    <TableCell>{formatTimestamp(s.invitedAt, timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {r.status !== 'draft' ? <QuotationsCard r={r} recordable={recordable} money={money} timezone={timezone} /> : null}
      {r.quotations.some(compared) ? <ComparisonCard r={r} money={money} /> : null}
      {r.award ? (
        <AwardResultCard r={r} money={money} timezone={timezone} canOrder={r.requisitionStatus === 'approved' && (request.actor?.permissions.has('po.create') ?? false)} />
      ) : null}

      {can.has('award') ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Award</h2>
          </CardHeader>
          <CardContent>
            {r.quotations.some((q) => q.status === 'submitted' && q.validity === 'valid') ? (
              <AwardForm
                rfqId={r.id}
                version={r.version}
                belowMinQuotes={r.comparison.belowMinQuotes}
                minQuotes={r.comparison.minQuotes}
                options={r.quotations
                  .filter((q) => q.status === 'submitted' && q.validity === 'valid')
                  .map((q) => ({ id: q.id, label: `${q.supplierName}, ${money(q.total)}`, lowest: q.lowest }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No valid quotation can be awarded. Cancel the RFQ and start a new one if needed.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {manages ? (
        <Card>
          <CardHeader>
            <h2 className="font-semibold">Actions</h2>
          </CardHeader>
          <CardContent className="grid gap-6">
            {can.has('edit') ? (
              <div>
                <Button asChild variant="outline">
                  <Link href={`/rfqs/${r.id}/edit`}>Edit RFQ</Link>
                </Button>
              </div>
            ) : null}
            {can.has('issue') ? <IssueRfqForm rfqId={r.id} version={r.version} /> : null}
            {can.has('close') ? <CloseRfqForm rfqId={r.id} version={r.version} draftCount={draftCount} /> : null}
            {can.has('cancel') ? <CancelRfqForm rfqId={r.id} version={r.version} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function QuotationsCard({
  r,
  recordable,
  money,
  timezone,
}: {
  r: RfqDetailDto;
  recordable: RfqDetailDto['suppliers'];
  money: (value: string) => string;
  timezone: string;
}) {
  const withActions = r.quotations.some((q) => q.callerActions.length > 0);
  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">Quotations</h2>
      </CardHeader>
      <CardContent className="grid gap-4">
        {r.quotations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No quotation recorded yet.</p>
        ) : (
          <Table aria-label="Quotations">
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total (without tax)</TableHead>
                <TableHead>Valid until</TableHead>
                <TableHead className="text-right">Lead time</TableHead>
                <TableHead>Recorded</TableHead>
                {withActions ? <TableHead>Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.quotations.map((q) => (
                <TableRow key={q.id}>
                  <TableCell className="whitespace-normal">
                    {q.supplierName}
                    {q.supplierReference ? <span className="block text-xs text-muted-foreground">Ref. {q.supplierReference}</span> : null}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {quotationStatusLabel(q.status)}
                    {q.late ? (
                      <Badge variant="outline" className="ml-2">
                        Late
                      </Badge>
                    ) : null}
                    {q.status === 'withdrawn' && q.withdrawReason ? <span className="block text-xs text-muted-foreground">{q.withdrawReason}</span> : null}
                  </TableCell>
                  <TableCell className="text-right">{money(q.total)}</TableCell>
                  <TableCell>{formatDate(q.validUntil)}</TableCell>
                  <TableCell className="text-right">{q.leadTimeDays} days</TableCell>
                  <TableCell className="whitespace-normal text-xs">
                    by {q.recordedBy}
                    {q.submittedAt ? (
                      <span className="block">
                        submitted {formatTimestamp(q.submittedAt, timezone)} by {q.submittedBy}
                      </span>
                    ) : null}
                  </TableCell>
                  {withActions ? (
                    <TableCell className="whitespace-normal">
                      <div className="grid gap-2">
                      {q.callerActions.includes('edit') ? (
                        <Link href={`/rfqs/${r.id}/quotations/${q.id}/edit`} className="text-sm underline-offset-4 hover:underline" aria-label={`Edit the quotation from ${q.supplierName}`}>
                          Edit
                        </Link>
                      ) : null}
                      {q.callerActions.includes('submit') ? <SubmitQuotationForm quotationId={q.id} version={q.version} supplierName={q.supplierName} /> : null}
                      {q.callerActions.includes('discard') ? (
                        <WithdrawQuotationForm quotationId={q.id} version={q.version} supplierName={q.supplierName} mode="discard" />
                      ) : null}
                      {q.callerActions.includes('withdraw') ? (
                        <WithdrawQuotationForm quotationId={q.id} version={q.version} supplierName={q.supplierName} mode="withdraw" />
                      ) : null}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {recordable.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {recordable.map((s) => (
              <Button key={s.id} asChild variant="outline" size="sm">
                <Link href={`/rfqs/${r.id}/quotations/new?supplierId=${s.id}`}>Record quotation from {s.legalName}</Link>
              </Button>
            ))}
          </div>
        ) : null}
        {r.status === 'issued' && r.comparison.pastDue ? (
          <p className="text-sm text-muted-foreground">The due time has passed. Quotations recorded and submitted now are marked late.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ruleSummary(r: RfqDetailDto): string {
  const c = r.comparison;
  const estimate = formatMoney(r.requisitionEstimatedTotal, r.currencyCode, r.currencyScale);
  if (c.rfqRequiredAbove === null) return 'No minimum number of quotations is set.';
  const threshold = formatMoney(c.rfqRequiredAbove, r.currencyCode, r.currencyScale);
  if (!c.minQuotesApplies) return `The requisition estimate (${estimate}) is below ${threshold}, so no minimum number of quotations applies.`;
  return `At least ${c.minQuotes} valid quotations are expected, because the requisition estimate (${estimate}) is at or above ${threshold}. Valid now: ${c.validCount}.${
    c.belowMinQuotes ? ' Awarding needs a justification.' : ''
  }`;
}

function ComparisonCard({ r, money }: { r: RfqDetailDto; money: (value: string) => string }) {
  const columns = r.quotations.filter(compared);
  const lineOf = (q: QuotationDto, rfqLineId: string) => q.lines.find((l) => l.rfqLineId === rfqLineId);
  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">Comparison</h2>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="overflow-x-auto">
          <Table aria-label="Quotation comparison">
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                {columns.map((q) => (
                  <TableHead key={q.id} className="text-right whitespace-normal">
                    {q.supplierName}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-normal">
                    {l.lineNo}. {l.description} ({l.quantity} {l.uom})
                  </TableCell>
                  {columns.map((q) => {
                    const line = lineOf(q, l.id);
                    return (
                      <TableCell key={q.id} className="text-right">
                        {line ? (
                          <>
                            {formatUnitPrice(line.unitPrice, r.currencyScale)} each = {money(line.lineTotal)}
                            {line.lowestOnLine ? <span className="block text-xs font-medium">Lowest on this line</span> : null}
                          </>
                        ) : null}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">Total (without tax)</TableCell>
                {columns.map((q) => (
                  <TableCell key={q.id} className="text-right font-medium">
                    {money(q.total)}
                    {q.lowest ? (
                      <Badge variant="secondary" className="ml-2">
                        Lowest
                      </Badge>
                    ) : null}
                  </TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableCell>Lead time</TableCell>
                {columns.map((q) => (
                  <TableCell key={q.id} className="text-right">
                    {q.leadTimeDays} days
                  </TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableCell>Valid until</TableCell>
                {columns.map((q) => (
                  <TableCell key={q.id} className="text-right">
                    {formatDate(q.validUntil)}
                  </TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableCell>Counts as</TableCell>
                {columns.map((q) => (
                  <TableCell key={q.id} className="text-right">
                    {validityLabel(q.validity)}
                    {q.late ? ', late' : ''}
                    {q.status !== 'submitted' ? ` (${quotationStatusLabel(q.status).toLowerCase()})` : ''}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
        {r.status !== 'awarded' ? (
          <p className="text-sm text-muted-foreground">
            {ruleSummary(r)} Choosing a quotation that is not the lowest valid total also needs a justification.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AwardResultCard({ r, money, timezone, canOrder }: { r: RfqDetailDto; money: (value: string) => string; timezone: string; canOrder: boolean }) {
  const a = r.award;
  if (!a) return null;
  const threshold = a.rfqRequiredAbove === null ? 'no minimum was set' : `from ${formatAmount(a.rfqRequiredAbove, r.currencyScale)} ${r.currencyCode}, ${a.minQuotes} expected`;
  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">Award</h2>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Awarded to</dt>
          <dd>
            {a.supplierName}, {money(a.total)}
          </dd>
          <dt className="text-muted-foreground">By</dt>
          <dd>
            {a.awardedBy} on {formatTimestamp(a.awardedAt, timezone)}
          </dd>
          <dt className="text-muted-foreground">Valid quotations</dt>
          <dd>
            {a.validQuotations} ({threshold}){a.belowMinQuotes ? ': fewer than the minimum' : ''}
          </dd>
          <dt className="text-muted-foreground">Lowest valid total</dt>
          <dd>{a.notLowest ? 'No, another valid quotation was lower' : 'Yes'}</dd>
          <dt className="text-muted-foreground">Justification</dt>
          <dd className="whitespace-pre-wrap">{a.justification ?? 'None given'}</dd>
        </dl>
        {canOrder ? (
          <div className="mt-4">
            <Button asChild variant="outline">
              <Link href={`/purchase-orders/new?requisitionId=${r.requisitionId}&quotationId=${a.quotationId}`}>Create purchase order from this award</Link>
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
