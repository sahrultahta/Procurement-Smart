import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { resolveActor } from '@/modules/identity';
import { accounts, rateLimits, sessions, users, verifications } from '@/modules/identity/infrastructure/auth-schema';
import { getDb } from '@/shared/db/client';
import type { Database } from '@/shared/db/transaction';
import { getEnv } from '@/shared/env';
import { logger } from '@/shared/logger';
import { authSchemaOptions } from './auth-schema-options';
import { auditAuthEvent, emailFingerprint } from './auth-audit';

/**
 * Better Auth: authentication only (ADR 0005, ADR 0014). Authorization lives in
 * the identity module. Notes on the choices below:
 *  - Public sign-up is disabled. Users are provisioned, then set a password via a one-time link.
 *  - Rate limiting is on in every environment and stored in PostgreSQL. It applies to
 *    HTTP requests through the handler only (Better Auth docs: server-side `auth.api`
 *    calls bypass it), so sign-in must go through /api/auth/sign-in/email.
 *  - Cookie cache is off, so a revoked session stops working on the very next request.
 */
export type AuthOptions = {
  db: Database;
  baseURL: string;
  secret: string;
  /** Secure (__Secure-) cookies. True whenever the public URL is HTTPS. */
  secureCookies: boolean;
};

export const SIGN_IN_RATE_LIMIT = { window: 60, max: 5 } as const;
export const PASSWORD_SETUP_TTL_SECONDS = 24 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 12;

// Captures the one-time token when we issue a password-setup link ourselves (no email in v1).
const setupTokenCapture = new AsyncLocalStorage<{ token?: string }>();

export function createAuth(options: AuthOptions) {
  const { db } = options;
  return betterAuth({
    ...authSchemaOptions,
    appName: 'ProcureFlow',
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [options.baseURL],
    telemetry: { enabled: false },
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { users, sessions, accounts, verifications, rateLimits },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: PASSWORD_SETUP_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ token }) => {
        const capture = setupTokenCapture.getStore();
        if (capture) capture.token = token;
        // No email delivery in v1: a self-service reset request issues a token nobody receives.
        else logger.warn('auth.password_reset_not_delivered');
      },
    },
    session: {
      ...authSchemaOptions.session, // keep modelName: overriding it breaks the schema mapping
      expiresIn: 60 * 60 * 12, // 12 hours
      updateAge: 60 * 60, // extend at most hourly
      cookieCache: { enabled: false },
    },
    rateLimit: {
      ...authSchemaOptions.rateLimit,
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': SIGN_IN_RATE_LIMIT,
        '/reset-password': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
      },
    },
    advanced: {
      ...authSchemaOptions.advanced,
      // Explicit: Better Auth 1.7.7 skips the origin check when NODE_ENV=test unless
      // these are set (context/create-context.mjs). Keep CSRF/origin checks on everywhere.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: options.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: options.secureCookies },
    },
    databaseHooks: {
      session: {
        create: {
          // Before: if the audit write fails, no session is created (no unaudited sign-in).
          before: async (session, context) => {
            // A deactivated user (or one without a profile) gets no session at all, and the
            // same answer as a wrong password, so the response reveals nothing about the account.
            if (!(await resolveActor(db, session.userId))) {
              await auditAuthEvent(db, context, { action: 'auth.signInRejected', userId: session.userId });
              throw new APIError('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
            }
            await auditAuthEvent(db, context, { action: 'auth.signedIn', userId: session.userId });
          },
        },
        delete: {
          // After, and never blocking: signing out must always work.
          after: async (session, context) => {
            await auditAuthEvent(db, context, { action: 'auth.signedOut', userId: session.userId }).catch((error: unknown) =>
              logger.error('auth.audit_failed', { error: { name: 'AuditError', message: String(error) } }),
            );
          },
        },
      },
      account: {
        create: {
          before: async (account, context) => {
            if (account.providerId === 'credential' && account.password) {
              await auditAuthEvent(db, context, { action: 'auth.passwordSet', userId: account.userId });
            }
          },
        },
        update: {
          before: async (account, context) => {
            if (account.password && account.userId) {
              await auditAuthEvent(db, context, { action: 'auth.passwordChanged', userId: account.userId });
            }
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-in/email' && isAPIError(ctx.context.returned)) {
          const email = typeof ctx.body?.email === 'string' ? ctx.body.email : '';
          await auditAuthEvent(db, ctx, { action: 'auth.signInFailed', emailFingerprint: emailFingerprint(email) }).catch(
            (error: unknown) => logger.error('auth.audit_failed', { error: { name: 'AuditError', message: String(error) } }),
          );
        }
      }),
    },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

export function getAuth(): Auth {
  if (!instance) {
    const env = getEnv();
    instance = createAuth({
      db: getDb(),
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      secureCookies: env.BETTER_AUTH_URL.startsWith('https://'),
    });
  }
  return instance;
}

/**
 * Issues a one-time password-setup token for an existing user (valid 24 h, single use)
 * through Better Auth's public reset flow. Returns the token, or null for an unknown email.
 */
export async function issuePasswordSetupToken(auth: Auth, email: string): Promise<string | null> {
  const capture: { token?: string } = {};
  await setupTokenCapture.run(capture, () => auth.api.requestPasswordReset({ body: { email } }));
  return capture.token ?? null;
}

export function passwordSetupPath(token: string): string {
  return `/set-password?token=${encodeURIComponent(token)}`;
}
