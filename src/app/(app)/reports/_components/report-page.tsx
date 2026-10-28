import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { formatTimestamp } from '@/lib/format';
import type { ReportName } from '@/modules/reporting';
import { todayIn } from '@/modules/organization';
import { getOrganization } from '@/server/organization-profile';

/*
 * Shared pieces of the report pages. Every figure on them comes from a report query; these
 * components only lay it out (P9-AC3: no metric is written into a component).
 */

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export function param(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 64) : undefined;
}

/** A whole number from the query, or undefined (the report's default applies). */
export function intParam(params: Record<string, string | string[] | undefined>, key: string): number | undefined {
  const value = param(params, key);
  return value !== undefined && /^[0-9]{1,4}$/.test(value) ? Number(value) : undefined;
}

/** The default range: 1 January of the org's current year to today (org dates). */
export async function defaultRange(): Promise<{ from: string; to: string; timezone: string }> {
  const { timezone } = await getOrganization();
  const today = todayIn(timezone, new Date());
  return { from: `${today.slice(0, 4)}-01-01`, to: today, timezone };
}

export function ReportHeader({
  title,
  description,
  asOf,
  timezone,
  exportReport,
  exportParams,
}: {
  title: string;
  description: ReactNode;
  asOf: string | null;
  timezone: string;
  exportReport: ReportName;
  exportParams: Record<string, string | number | undefined>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(exportParams)) if (value !== undefined) query.set(key, String(value));
  return (
    <div className="grid gap-2">
      <Link href="/reports" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        All reports
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
          {asOf ? (
            <p className="text-xs text-muted-foreground" data-testid="report-as-of">
              Figures as of {formatTimestamp(asOf, timezone)}.
            </p>
          ) : null}
        </div>
        {asOf ? (
          <Button asChild variant="outline" size="sm">
            <a href={`/reports/export/${exportReport}?${query}`} download>
              Download CSV
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ReportError({ message, fieldErrors }: { message: string; fieldErrors?: Record<string, string[]> | undefined }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}{' '}
      {Object.entries(fieldErrors ?? {})
        .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
        .join('; ')}
    </p>
  );
}

export function EmptyReport({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="report-empty">
      {children}
    </p>
  );
}

export function AccessDenied() {
  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="text-muted-foreground">Reports are for procurement, finance, and auditors.</p>
    </div>
  );
}
