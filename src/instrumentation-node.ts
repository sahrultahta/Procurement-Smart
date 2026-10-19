import { EnvError, getEnv } from './shared/env';

/**
 * Node.js-only startup check, imported from instrumentation.ts only when
 * NEXT_RUNTIME is 'nodejs' (the pattern in Next.js's instrumentation guide), so
 * the Edge compile never sees process.exit.
 *
 * Throwing is not enough: Next.js 16.4 logs "Failed to prepare server" and keeps
 * the process running (observed in Phase 1). So exit explicitly.
 */
export function assertValidConfiguration(): void {
  try {
    getEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(`[procureflow] ${error.message} Refusing to start.`);
      process.exit(1);
    }
    throw error;
  }
}
