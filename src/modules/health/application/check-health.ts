import 'server-only';
import { pingDatabase } from '../infrastructure/ping-database';

export type HealthReport = {
  status: 'ok' | 'unavailable';
  checks: { database: 'ok' | 'unavailable' };
};

/**
 * Operational readiness check. Public by design (load balancers call it unauthenticated),
 * so it reports only up/down and never versions, hostnames, or error details.
 */
export async function checkHealth(ping: () => Promise<boolean> = pingDatabase): Promise<HealthReport> {
  const database = (await ping()) ? 'ok' : 'unavailable';
  return { status: database === 'ok' ? 'ok' : 'unavailable', checks: { database } };
}
