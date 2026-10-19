/**
 * Runs once when the Next.js server starts. Validates configuration so a
 * misconfigured deployment fails at startup instead of on the first request.
 *
 * Next.js compiles this file for every runtime, so Node.js-only code lives in
 * instrumentation-node.ts and is imported only under the Node.js runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertValidConfiguration } = await import('./instrumentation-node');
    assertValidConfiguration();
  }
}
