import 'server-only';
import { headers } from 'next/headers';
import { cache } from 'react';
import { resolveActor, type IdentityActor } from '@/modules/identity';
import { clientIpFrom } from '@/shared/application/client-ip';
import { createRequestContext, type RequestContext } from '@/shared/application/context';
import { getDb } from '@/shared/db/client';
import { getEnv } from '@/shared/env';
import { getAuth } from './auth';

export type AppRequestContext = Omit<RequestContext, 'actor'> & { readonly actor: IdentityActor | null };

/**
 * The request context for Server Components, Server Actions, and Route Handlers.
 * Always validates the session against the database (never trusts the cookie alone),
 * then loads the actor's profile and roles. Cached for the duration of one request.
 */
export const getRequestContext = cache(async (): Promise<AppRequestContext> => {
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  const actor = session ? await resolveActor(getDb(), session.user.id) : null;
  const context = createRequestContext({
    actor,
    requestId: requestHeaders.get('x-request-id'),
    // The same client the sign-in rate limit sees (ADR 0014), not whatever a client wrote first.
    ip: clientIpFrom(requestHeaders.get('x-forwarded-for'), getEnv().TRUSTED_PROXIES),
    userAgent: requestHeaders.get('user-agent'),
  });
  return { ...context, actor };
});
