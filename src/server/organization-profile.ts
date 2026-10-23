import 'server-only';
import { cache } from 'react';
import { getOrganizationProfile, type OrganizationProfileDto } from '@/modules/organization';
import { runQuery } from '@/shared/application/runner';
import { getRequestContext } from './request-context';

const FALLBACK: OrganizationProfileDto = { orgName: 'ProcureFlow', timezone: 'UTC', currencyCode: 'USD', currencyScale: 2 };

/**
 * The organization's name, time zone, and currency for the current request (once per
 * request). Signed-out callers, who cannot read it, get neutral defaults for display.
 */
export const getOrganization = cache(async (): Promise<OrganizationProfileDto> => {
  const result = await runQuery(await getRequestContext(), getOrganizationProfile, {});
  return result.ok ? result.data : FALLBACK;
});
