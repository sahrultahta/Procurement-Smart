/**
 * The E2E suite runs against its own database, recreated for every Playwright run
 * (scripts/e2e-db.ts), so test users never pile up in the development data: users
 * cannot be deleted, only deactivated.
 */
export const E2E_DATABASE = 'pf_e2e';

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
