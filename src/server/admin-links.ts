import 'server-only';
import { prepareSetupLink } from '@/modules/identity';
import type { RequestContext } from '@/shared/application/context';
import { runCommand } from '@/shared/application/runner';
import type { Database } from '@/shared/db/transaction';
import { getEnv } from '@/shared/env';
import { logger } from '@/shared/logger';
import { err, ok, type Result } from '@/shared/result';
import { getAuth, issuePasswordSetupToken, passwordSetupPath, type Auth } from './auth';

export type SetupLinkOptions = { auth?: Auth; db?: Database; baseURL?: string };

/**
 * Issues a one-time password-setup link for a user an admin manages (US-AD-01).
 * Two steps, because Better Auth writes the token through its own connection:
 *   1. `admin.user.issueSetupLink` checks the rules, invalidates older links, and audits (one transaction).
 *   2. Better Auth creates the token for the now-committed user.
 * If step 2 fails, nothing is half-done: the admin sees an error and can issue a link again.
 * The link is returned to the admin once and is never logged or audited.
 */
export async function issueSetupLink(
  request: RequestContext,
  userId: string,
  options: SetupLinkOptions = {},
): Promise<Result<{ url: string }>> {
  const prepared = await runCommand(request, prepareSetupLink, { userId }, options.db ? { db: options.db } : undefined);
  if (!prepared.ok) return err(prepared.error);
  const token = await issuePasswordSetupToken(options.auth ?? getAuth(), prepared.data.email);
  if (!token) {
    logger.error('admin.setup_link_failed', { requestId: request.requestId, userId });
    return err({ code: 'INTERNAL', message: 'The link could not be created. Try again.' });
  }
  return ok({ url: new URL(passwordSetupPath(token), options.baseURL ?? getEnv().BETTER_AUTH_URL).toString() });
}
