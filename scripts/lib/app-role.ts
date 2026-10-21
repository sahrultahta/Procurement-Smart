/**
 * Creates or updates the runtime database role `procureflow_app` (ADR 0013).
 * Roles are cluster-level objects, so they are bootstrapped here, outside migrations.
 * The role gets LOGIN only: no superuser, no CREATEDB, no CREATEROLE, no ownership.
 * Table privileges are granted by migrations.
 */
import pg from 'pg';

export const APP_ROLE = 'procureflow_app';

export async function ensureAppRole(adminUrl: string, password: string): Promise<'created' | 'updated'> {
  if (password.length < 16) throw new Error('App role password must be at least 16 characters.');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    const literal = client.escapeLiteral(password);
    const attributes = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
    if (rowCount === 0) {
      await client.query(`CREATE ROLE ${APP_ROLE} ${attributes} PASSWORD ${literal}`);
      return 'created';
    }
    await client.query(`ALTER ROLE ${APP_ROLE} ${attributes} PASSWORD ${literal}`);
    return 'updated';
  } finally {
    await client.end();
  }
}
