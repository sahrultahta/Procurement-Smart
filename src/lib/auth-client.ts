'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * Browser client for Better Auth's HTTP API on the same origin. Sign-in goes through
 * HTTP (not a Server Action) so Better Auth's rate limiting applies (ADR 0014).
 */
export const authClient = createAuthClient();

/** Only same-site relative paths are allowed as post-sign-in destinations (no open redirect). */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
