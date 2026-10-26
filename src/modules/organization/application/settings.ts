import 'server-only';
import { z } from 'zod';
import { auditChanges, defineAuditPolicy, recordAuditEvent } from '@/modules/audit';
import { defineCommand, defineQuery } from '@/shared/application/runner';
import { dec, moneyInput, percentInput } from '@/shared/decimal/decimal';
import type { Database, Tx } from '@/shared/db/transaction';
import { fail, failBusinessRule } from '@/shared/result';
import { isCurrencyCode, isTimeZone } from '../domain/settings';
import { lockCurrency, lockSettings, readSettings, readSettingsForShare, updateSettings, type SettingsRow } from '../infrastructure/organization-repository';

/*
 * Organization settings (US-AD-04). Phase 5a: name, time zone, currency; the currency is
 * locked by the first monetary document (`lockCurrencyForNewDocument`), then never changes.
 * Phase 6b: the sourcing rules the award checks (RFQ-T05), `rfqRequiredAbove` and `minQuotes`.
 * Phase 7: the purchase-order approval rule (PO-T03) and the receipt tolerance fixed at issue (PO-T05).
 */

type SettingsFields = {
  orgName: string;
  timezone: string;
  currencyCode: string;
  currencyScale: number;
  rfqRequiredAbove: string | null;
  minQuotes: number;
  poApprovalThreshold: string | null;
  poPriceTolerancePct: string;
  overReceiptTolerancePct: string;
};

const settingsAudit = defineAuditPolicy<SettingsFields>({
  entityType: 'org_settings',
  fields: [
    'orgName',
    'timezone',
    'currencyCode',
    'currencyScale',
    'rfqRequiredAbove',
    'minQuotes',
    'poApprovalThreshold',
    'poPriceTolerancePct',
    'overReceiptTolerancePct',
  ],
});

export type OrganizationProfileDto = { orgName: string; timezone: string; currencyCode: string; currencyScale: number };
export type SettingsDto = OrganizationProfileDto & {
  /** Decimal string without trailing zeros; null means the minimum never applies. */
  rfqRequiredAbove: string | null;
  minQuotes: number;
  /** Decimal strings without trailing zeros; a null threshold means every purchase order needs approval. */
  poApprovalThreshold: string | null;
  poPriceTolerancePct: string;
  overReceiptTolerancePct: string;
  currencyLocked: boolean;
  version: number;
  updatedAt: string;
};
export const SETTINGS_DTO_KEYS = [
  'orgName',
  'timezone',
  'currencyCode',
  'currencyScale',
  'rfqRequiredAbove',
  'minQuotes',
  'poApprovalThreshold',
  'poPriceTolerancePct',
  'overReceiptTolerancePct',
  'currencyLocked',
  'version',
  'updatedAt',
] as const;

/** An amount without trailing zeros, so the stored '500.0000' and the entered '500' compare equal. */
function amount(value: string | null): string | null {
  return value === null ? null : dec(value).toString();
}

function profile(row: SettingsRow): OrganizationProfileDto {
  return { orgName: row.orgName, timezone: row.timezone, currencyCode: row.currencyCode, currencyScale: row.currencyScale };
}

function fields(row: SettingsRow): SettingsFields {
  return {
    ...profile(row),
    rfqRequiredAbove: amount(row.rfqRequiredAbove),
    minQuotes: row.minQuotes,
    poApprovalThreshold: amount(row.poApprovalThreshold),
    poPriceTolerancePct: dec(row.poPriceTolerancePct).toString(),
    overReceiptTolerancePct: dec(row.overReceiptTolerancePct).toString(),
  };
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
    return { ...fields(row), currencyLocked: row.currencyLockedAt !== null, version: row.version, updatedAt: row.updatedAt.toISOString() };
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
    /** An estimated total, or null for "never". */
    rfqRequiredAbove: moneyInput.nullable(),
    minQuotes: z.number().int().min(1, 'At least 1').max(10, 'At most 10'),
    /** A purchase-order total (tax included), or null for "every purchase order". */
    poApprovalThreshold: moneyInput.nullable(),
    poPriceTolerancePct: percentInput,
    overReceiptTolerancePct: percentInput,
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
  }),
  handler: async ({ tx, actor, request }, input): Promise<{ version: number }> => {
    const row = await lockSettings(tx);
    if (row.version !== input.expectedVersion) fail('CONFLICT', 'The settings were changed by someone else. Reload the page and try again.');
    const currencyChanged = input.currencyCode !== row.currencyCode || input.currencyScale !== row.currencyScale;
    if (currencyChanged && row.currencyLockedAt) {
      failBusinessRule('CURRENCY_LOCKED', 'The currency cannot change: requisitions already use it.');
    }
    const changes = auditChanges(settingsAudit, fields(row), {
      ...input,
      rfqRequiredAbove: amount(input.rfqRequiredAbove),
      poApprovalThreshold: amount(input.poApprovalThreshold),
      poPriceTolerancePct: dec(input.poPriceTolerancePct).toString(),
      overReceiptTolerancePct: dec(input.overReceiptTolerancePct).toString(),
    });
    if (Object.keys(changes).length === 0) return { version: row.version };
    const version = await updateSettings(tx, row.version, {
      orgName: input.orgName,
      timezone: input.timezone,
      currencyCode: input.currencyCode,
      currencyScale: input.currencyScale,
      rfqRequiredAbove: input.rfqRequiredAbove,
      minQuotes: input.minQuotes,
      poApprovalThreshold: input.poApprovalThreshold,
      poPriceTolerancePct: input.poPriceTolerancePct,
      overReceiptTolerancePct: input.overReceiptTolerancePct,
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

export type SourcingRules = { timezone: string; rfqRequiredAbove: string | null; minQuotes: number };

/**
 * For sourcing (Phase 6b): the time zone that decides "today", and the award's minimum-quotations
 * rule. A plain read: the award stores the values it used, so a later change cannot rewrite it.
 */
export async function findSourcingRules(db: Database | Tx): Promise<SourcingRules> {
  const row = await readSettings(db);
  return { timezone: row.timezone, rfqRequiredAbove: amount(row.rfqRequiredAbove), minQuotes: row.minQuotes };
}

export type PurchasingRules = {
  timezone: string;
  rfqRequiredAbove: string | null;
  poApprovalThreshold: string | null;
  poPriceTolerancePct: string;
  overReceiptTolerancePct: string;
};

/**
 * For purchase orders (Phase 7): "today", the RFQ threshold (RFQ_REQUIRED), the approval rule
 * (PO-T03), and the receipt tolerance (PO-T05). Each order stores the values it used.
 */
export async function findPurchasingRules(db: Database | Tx): Promise<PurchasingRules> {
  return purchasingRules(await readSettings(db));
}

/**
 * The same, held until the caller's transaction ends (a shared lock): the database compares what
 * a purchase order stores with the settings, so they must not change in between.
 */
export async function lockPurchasingRules(tx: Tx): Promise<PurchasingRules> {
  return purchasingRules(await readSettingsForShare(tx));
}

function purchasingRules(row: SettingsRow): PurchasingRules {
  return {
    timezone: row.timezone,
    rfqRequiredAbove: amount(row.rfqRequiredAbove),
    poApprovalThreshold: amount(row.poApprovalThreshold),
    poPriceTolerancePct: dec(row.poPriceTolerancePct).toString(),
    overReceiptTolerancePct: dec(row.overReceiptTolerancePct).toString(),
  };
}
