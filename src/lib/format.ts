const timestamp = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

/**
 * Timestamps are shown in UTC, labeled, until the organization timezone setting
 * exists (deferred to the phase that introduces org settings).
 */
export function formatTimestamp(iso: string): string {
  return `${timestamp.format(new Date(iso))} UTC`;
}
