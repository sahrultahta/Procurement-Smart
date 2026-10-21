import { getAuth } from '@/server/auth';

// Better Auth's HTTP API (sign-in, sign-out, session, reset-password). The auth
// instance is created on first request, so building the app needs no secrets.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export async function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
