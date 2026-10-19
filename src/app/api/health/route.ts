import { checkHealth } from '@/modules/health';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const report = await checkHealth();
  return Response.json(report, {
    status: report.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
