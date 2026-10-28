import { REPORT_NAMES, exportReport } from '@/modules/reporting';
import { getRequestContext } from '@/server/request-context';
import { runQuery } from '@/shared/application/runner';

/**
 * CSV download of a report (P9-AC5). `report.export` checks `report.view` and validates the
 * parameters exactly as the report on screen does. Nothing is cached: the file is as of now.
 */
const STATUS: Record<string, number> = { UNAUTHENTICATED: 401, FORBIDDEN: 403, VALIDATION_FAILED: 400, NOT_FOUND: 404 };

export async function GET(request: Request, { params }: { params: Promise<{ report: string }> }): Promise<Response> {
  const { report } = await params;
  if (!(REPORT_NAMES as readonly string[]).includes(report)) return text(404, 'Report not found.');
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) query[key] = value;
  const result = await runQuery(await getRequestContext(), exportReport, { report, params: query });
  if (!result.ok) return text(STATUS[result.error.code] ?? 500, result.error.message);
  return new Response(result.data.csv, {
    status: 200,
    headers: {
      'Content-Type': result.data.contentType,
      'Content-Disposition': `attachment; filename="${result.data.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
