import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Runs before every page and API request (Next.js 16 `proxy`, Node.js runtime):
 *  1. assigns a fresh request id (client-supplied ids are ignored),
 *  2. redirects to /sign-in when there is no session cookie at all. This is an optimistic
 *     check only: the cookie is not validated here. Pages, actions, and queries validate
 *     the session against the database (src/server/request-context.ts),
 *  3. sets security headers and a per-request CSP nonce (threat model section 8, P3a-AC9).
 */
const PUBLIC_PAGES = ['/sign-in', '/set-password'];

function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

/**
 * `production` (NODE_ENV) removes the relaxations dev tooling needs (eval, inline styles,
 * HMR websockets). `https` turns on transport rules (upgrade-insecure-requests, HSTS):
 * they depend on the scheme, because `next start` also runs in production mode over plain HTTP.
 */
export function contentSecurityPolicy(nonce: string, options: { production: boolean; https: boolean }): string {
  const { production, https } = options;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? '' : " 'unsafe-eval'"}`,
    production ? `style-src 'self' 'nonce-${nonce}'` : "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    production ? "connect-src 'self'" : "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

function applySecurityHeaders(response: NextResponse, options: { requestId: string; csp: string | null; https: boolean }) {
  const headers = response.headers;
  headers.set('x-request-id', options.requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (options.csp) headers.set('Content-Security-Policy', options.csp);
  // Browsers only honor HSTS over HTTPS.
  if (options.https) headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const production = process.env.NODE_ENV === 'production';
  // Behind a TLS-terminating reverse proxy, the original scheme arrives in x-forwarded-proto.
  const https = request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const isApi = pathname.startsWith('/api/');
  const requestId = crypto.randomUUID();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = isApi ? null : contentSecurityPolicy(nonce, { production, https });

  if (!isApi && !isPublicPage(pathname) && !getSessionCookie(request)) {
    const signIn = new URL('/sign-in', request.url);
    if (pathname !== '/') signIn.searchParams.set('next', `${pathname}${search}`);
    return applySecurityHeaders(NextResponse.redirect(signIn), { requestId, csp, https });
  }

  const forwarded = new Headers(request.headers);
  forwarded.set('x-request-id', requestId);
  if (csp) {
    forwarded.set('x-nonce', nonce);
    forwarded.set('Content-Security-Policy', csp); // Next.js reads the nonce from this request header
  }
  return applySecurityHeaders(NextResponse.next({ request: { headers: forwarded } }), { requestId, csp, https });
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
