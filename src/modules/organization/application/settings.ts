import 'server-only';
import { z } from 'zod';
import { auditChanges, defineAuditPolicy, recordAuditEvent } from '@/modules/audit';
import { defineCommand, defineQuery } from '@/shared/application/runner';
import type { Database, Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
import { isCurrencyCode, isTimeZone } from '../domain/settings';
import { lockCurrency, lockSettings, readSettings, updateSettings, type SettingsRow } from '../infrastructure/organization-repository';

/*
 * Organization settings (US-AD-04, Phase 5a: name, time zone, currency). The currency is
 * locked by the first monetary document (`lockCurrencyForNewDocument`), then never changes.
 */

const settingsAudit = defineAuditPolicy<{ orgName: string; timezone: string; currencyCode: string; currencyScale: number }>({
  entityType: 'org_settings',
  fields: ['orgName', 'timezone', 'currencyCode', 'currencyScale'],
});

export type OrganizationProfileDto = { orgName: string; timezone: string; currencyCode: string; currencyScale: number };
export type SettingsDto = OrganizationProfileDto & { currencyLocked: boolean; version: number; updatedAt: string };
export const SETTINGS_DTO_KEYS = ['orgName', 'timezone', 'currencyCode', 'currencyScale', 'currencyLocked', 'version', 'updatedAt'] as const;

function profile(row: SettingsRow): OrganizationProfileDto {
  return { orgName: row.orgName, timezone: row.timezone, currencyCode: row.currencyCode, currencyScale: row.currencyScale };
}

/** What every signed-in user may know about the organization: for display and formatting. */
export const getOrganizationProfile = defineQuery({
  name: 'organization.profile',
  permission: 'account.read',
  input: z.strictObject({}),
  handler: async ({ tx }): Promise<OrganizationProfileDto> => profile(await readSettings(tx)),
});

export const getSettings = defineQuery({
  name: 'admin.settings.get',
  permission: 'admin.settings',
  input: z.strictObject({}),
  handler: async ({ tx }): Promise<SettingsDto> => {
    const row = await readSettings(tx);
    return { ...profile(row), currencyLocked: row.currencyLockedAt !== null, version: row.version, updatedAt: row.updatedAt.toISOString() };
  },
});

export const updateOrganizationSettings = defineCommand({
  name: 'admin.settings.update',
  permission: 'admin.settings',
  input: z.strictObject({
    orgName: z.string().trim().min(1, 'Enter a name').max(120),
    timezone: z.string().refine(isTimeZone, 'Choose a time zone'),
    currencyCode: z.string().refine(isCurrencyCode, 'Choose a currency'),
    currencyScale: z.number().int().min(0).max(4),
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
  }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number }> => {
    const row = await lockSettings(tx);
    if (row.version !== input.expectedVersion) fail('CONFLICT', 'The settings were changed by someone else. Reload the page and try again.');
    const currencyChanged = input.currencyCode !== row.currencyCode || input.currencyScale !== row.currencyScale;
    if (currencyChanged && row.currencyLockedAt) {
      failBusinessRule('CURRENCY_LOCKED', 'The currency cannot change: requisitions already use it.');
    }
    const changes = auditChanges(settingsAudit, profile(row), input);
    if (Object.keys(changes).length === 0) return { version: row.version };
    const version = await updateSettings(tx, row.version, {
      orgName: input.orgName,
      timezone: input.timezone,
      currencyCode: input.currencyCode,
      currencyScale: input.currencyScale,
      updatedByUserId: actor.userId,
    });
    await recordAuditEvent(tx, request, { action: 'settings.updated', entityType: 'org_settings', entityId: '1', changes });
    return { version };
  },
});

/** For document modules: the org currency, locked from now on (in the caller's transaction). */
export async function lockCurrencyForNewDocument(tx: Tx): Promise<{ code: string; scale: number }> {
  return lockCurrency(tx);
}

export async function findOrganizationTimezone(db: Database | Tx): Promise<string> {
  return (await readSettings(db)).timezone;
}
