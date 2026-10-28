import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDate, formatMoney } from '@/lib/format';
import { SPEND_BASES, spendByDepartment, spendBySupplier } from '@/modules/reporting';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';
import { AccessDenied, EmptyReport, ReportError, ReportHeader, defaultRange, param } from './report-page';

const BASIS_LABELS: Record<(typeof SPEND_BASES)[number], string> = {
  issued: 'Issued: order totals on the day they were issued',
  received: 'Received: goods received, valued at the order price, on the day they arrived',
};

/** Spend by supplier or by department (one page each, same layout). */
export async function SpendReport({ by, params }: { by: 'supplier' | 'department'; params: Record<string, string | string[] | undefined> }) {
  const request = await getRequestContext();
  if (!request.actor?.permissions.has('report.view')) return <AccessDenied />;
  const defaults = await defaultRange();
  const input = {
    from: param(params, 'from') ?? defaults.from,
    to: param(params, 'to') ?? defaults.to,
    basis: SPEND_BASES.find((b) => b === param(params, 'basis')) ?? 'issued',
  };
  const result = await runQuery(request, by === 'supplier' ? spendBySupplier : spendByDepartment, input);
  const label = by === 'supplier' ? 'Supplier' : 'Department';

  return (
    <div className="grid gap-6">
      <ReportHeader
        title={`Spend by ${by}`}
        description={`Purchase-order spend per ${by}, tax included. Cancelled orders do not count.`}
        asOf={result.ok ? result.data.asOf : null}
        timezone={defaults.timezone}
        exportReport={by === 'supplier' ? 'spendBySupplier' : 'spendByDepartment'}
        exportParams={input}
      />
      <form method="get" className="grid gap-3 sm:grid-cols-[10rem_10rem_1fr_auto] sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="spend-from">From</Label>
          <Input id="spend-from" name="from" type="date" defaultValue={input.from} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="spend-to">To</Label>
          <Input id="spend-to" name="to" type="date" defaultValue={input.to} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="spend-basis">Basis</Label>
          <NativeSelect id="spend-basis" name="basis" defaultValue={input.basis}>
            {SPEND_BASES.map((b) => (
              <option key={b} value={b}>
                {BASIS_LABELS[b]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>
      {!result.ok ? (
        <ReportError message={result.error.message} fieldErrors={result.error.fieldErrors} />
      ) : result.data.rows.length === 0 ? (
        <EmptyReport>
          No spend between {formatDate(result.data.from)} and {formatDate(result.data.to)} on this basis.
        </EmptyReport>
      ) : (
        <Table aria-label={`Spend by ${by}`}>
          <TableHeader>
            <TableRow>
              <TableHead>{label}</TableHead>
              <TableHead className="text-right">Purchase orders</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.rows.map((row) => (
              <TableRow key={`${row.id}-${row.currencyCode}`}>
                <TableCell className="whitespace-normal">
                  {row.name}
                  <span className="block font-mono text-xs text-muted-foreground">{row.code}</span>
                </TableCell>
                <TableCell className="text-right">{row.poCount}</TableCell>
                <TableCell className="text-right font-mono">{formatMoney(row.total, row.currencyCode, row.currencyScale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            {result.data.totals.map((t) => (
              <TableRow key={t.currencyCode}>
                <TableCell colSpan={2}>Total</TableCell>
                <TableCell className="text-right font-mono" data-testid={`spend-total-${t.currencyCode}`}>
                  {formatMoney(t.total, t.currencyCode, t.currencyScale)}
                </TableCell>
              </TableRow>
            ))}
          </TableFooter>
        </Table>
      )}
    </div>
  );
}
