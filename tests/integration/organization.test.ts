import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPROVAL_POLICY_KEYS,
  SETTINGS_DTO_KEYS,
  getActiveApprovalPolicy,
  getOrganizationProfile,
  getSettings,
  listApprovalPolicyVersions,
  publishApprovalPolicy,
  resolveApprovalRoute,
  updateOrganizationSettings,
} from '@/modules/organization';
import { createRequisition } from '@/modules/requisitions';
import { runCommand, runQuery, type Operation } from '@/shared/application/runner';
import type { Result } from '@/shared/result';
import { contextOf, provisionActor } from '../support/actors';
import { createTestDatabase, sqlStateOf, type TestDatabase } from '../support/test-db';

/* Phase 5a: organization settings and approval policies, as the runtime role. */

let t: TestDatabase;
let ada: string; // admin
let rina: string; // requester in OPS
let lena: string; // auditor
let opsId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query("INSERT INTO departments (code, name, is_active) VALUES ('OPS', 'Operations', true), ('FIN', 'Finance', true), ('OLD', 'Closed', false)");
  opsId = (await t.pool.query("SELECT id FROM departments WHERE code = 'OPS'")).rows[0].id as string;
  ada = await provisionActor(t.appDb, 'ada@example.com', 'Ada Admin', ['admin']);
  rina = await provisionActor(t.appDb, 'rina@example.com', 'Rina Requester', ['requester'], { departmentCode: 'OPS' });
  lena = await provisionActor(t.appDb, 'lena@example.com', 'Lena Auditor', ['auditor']);
});

afterAll(async () => {
  await t?.drop();
});

async function run<I, O>(as: string, op: Operation<I, O>, input: unknown): Promise<Result<O>> {
  const context = await contextOf(t.appDb, as);
  return op.kind === 'command' ? runCommand(context, op, input, { db: t.appDb }) : runQuery(context, op, input, { db: t.appDb });
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

const auditOf = async (entityId: string) =>
  (await t.pool.query('SELECT action, actor_user_id AS actor, changes, reason FROM audit_events WHERE entity_id = $1 ORDER BY id', [entityId])).rows;

const approver = { role: 'approver', scopeMode: 'document_department' } as const;
const finance = { role: 'finance', scopeMode: 'organization' } as const;
const standardRules = [
  { departmentCode: null, minAmount: '0', maxAmount: '1000', steps: [approver] },
  { departmentCode: null, minAmount: '1000', maxAmount: null, steps: [approver, finance] },
];

describe('P5a-AC1: organization settings', () => {
  it('starts from the migration defaults; everyone may read the profile, only admins the settings', async () => {
    expect(data(await run(rina, getOrganizationProfile, {}))).toEqual({ orgName: 'My organization', timezone: 'UTC', currencyCode: 'USD', currencyScale: 2 });
    const settings = data(await run(ada, getSettings, {}));
    expect(Object.keys(settings).sort()).toEqual([...SETTINGS_DTO_KEYS].sort());
    expect(settings).toMatchObject({ currencyLocked: false, version: 1 });
    expect(await run(lena, getSettings, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await run(rina, updateOrganizationSettings, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('updates with a version check, validates time zone and currency, and audits the change', async () => {
    const input = { orgName: 'Example Holdings', timezone: 'Asia/Jakarta', currencyCode: 'IDR', currencyScale: 0, rfqRequiredAbove: null, minQuotes: 3, expectedVersion: 1 };
    for (const bad of [
      { ...input, timezone: 'Mars/Olympus' },
      { ...input, currencyCode: 'XYZ' },
      { ...input, currencyScale: 5 },
      { ...input, orgName: '' },
      { ...input, currencyLockedAt: null },
    ]) {
      expect(await run(ada, updateOrganizationSettings, bad)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    }
    expect(data(await run(ada, updateOrganizationSettings, input))).toEqual({ version: 2 });
    expect(await run(ada, updateOrganizationSettings, { ...input, orgName: 'Stale' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await auditOf('1')).at(-1)).toMatchObject({
      action: 'settings.updated',
      actor: ada,
      changes: { orgName: ['My organization', 'Example Holdings'], timezone: ['UTC', 'Asia/Jakarta'], currencyCode: ['USD', 'IDR'], currencyScale: [2, 0] },
    });
    // Back to USD for the rest of the suite; a no-op writes nothing.
    data(await run(ada, updateOrganizationSettings, { ...input, timezone: 'UTC', currencyCode: 'USD', currencyScale: 2, expectedVersion: 2 }));
    const events = (await auditOf('1')).length;
    expect(data(await run(ada, updateOrganizationSettings, { ...input, timezone: 'UTC', currencyCode: 'USD', currencyScale: 2, expectedVersion: 3 }))).toEqual({ version: 3 });
    expect((await auditOf('1')).length).toBe(events);
  });

  it('locks the currency with the first requisition, in the app and in the database', async () => {
    data(await run(rina, createRequisition, { title: 'First', justification: null, neededBy: '2030-01-01', lines: [{ description: 'Pens', quantity: '1', uom: 'box', estimatedUnitPrice: '5' }] }));
    const settings = data(await run(ada, getSettings, {}));
    expect(settings.currencyLocked).toBe(true);
    const base = { orgName: 'Example Holdings', timezone: 'UTC', currencyCode: 'USD', currencyScale: 2, rfqRequiredAbove: null, minQuotes: 3, expectedVersion: settings.version };
    expect(await run(ada, updateOrganizationSettings, { ...base, currencyCode: 'EUR' })).toMatchObject({
      ok: false,
      error: { code: 'BUSINESS_RULE', rule: 'CURRENCY_LOCKED' },
    });
    expect(await run(ada, updateOrganizationSettings, { ...base, currencyScale: 3 })).toMatchObject({ ok: false, error: { rule: 'CURRENCY_LOCKED' } });
    // The name and time zone can still change.
    data(await run(ada, updateOrganizationSettings, { ...base, orgName: 'Example Holdings Ltd', timezone: 'Asia/Jakarta' }));
    for (const statement of [
      "UPDATE org_settings SET currency_code = 'EUR'",
      'UPDATE org_settings SET currency_scale = 0',
      'UPDATE org_settings SET currency_locked_at = NULL',
      'UPDATE org_settings SET id = 2',
    ]) {
      expect(await sqlStateOf(() => t.appPool.query(statement))).toBe('PFO01');
      expect(await sqlStateOf(() => t.pool.query(statement))).toBe('PFO01');
    }
    expect(await sqlStateOf(() => t.appPool.query('DELETE FROM org_settings'))).toBe('42501');
    expect(await sqlStateOf(() => t.appPool.query("INSERT INTO org_settings VALUES (1, 'x', 'UTC', 'USD', 2)"))).toBe('42501');
  });
});

describe('P6b-AC2: the award rule in the settings', () => {
  const rule = (result: Result<unknown>) => (result.ok ? 'ok' : (result.error.rule ?? result.error.code));

  it('validates the RFQ threshold and the minimum number of quotations, admins only, audited; unchanged values write nothing', async () => {
    const settings = data(await run(ada, getSettings, {}));
    // Migration 0014: no threshold (never required), minimum 3.
    expect(settings).toMatchObject({ rfqRequiredAbove: null, minQuotes: 3 });
    const base = {
      orgName: settings.orgName,
      timezone: settings.timezone,
      currencyCode: settings.currencyCode,
      currencyScale: settings.currencyScale,
      rfqRequiredAbove: null as string | null,
      minQuotes: 3,
      expectedVersion: settings.version,
    };
    for (const bad of [
      { rfqRequiredAbove: 500 }, // a JSON number, not a decimal string (ADR 0007)
      { rfqRequiredAbove: '-1' },
      { rfqRequiredAbove: '1e3' },
      { rfqRequiredAbove: '1.00001' },
      { rfqRequiredAbove: '' },
      { minQuotes: 0 },
      { minQuotes: 11 },
      { minQuotes: 2.5 },
      { minQuotes: '3' },
      { minQuotes: null },
    ]) {
      expect({ bad, result: rule(await run(ada, updateOrganizationSettings, { ...base, ...bad })) }).toEqual({ bad, result: 'VALIDATION_FAILED' });
    }
    for (const omitted of ['rfqRequiredAbove', 'minQuotes'] as const) {
      const without: Record<string, unknown> = { ...base };
      delete without[omitted];
      expect({ omitted, result: rule(await run(ada, updateOrganizationSettings, without)) }).toEqual({ omitted, result: 'VALIDATION_FAILED' });
    }
    for (const as of [rina, lena]) expect(rule(await run(as, updateOrganizationSettings, { ...base, rfqRequiredAbove: '500' }))).toBe('FORBIDDEN');

    const v = base.expectedVersion;
    expect(data(await run(ada, updateOrganizationSettings, { ...base, rfqRequiredAbove: '500.00', minQuotes: 2 }))).toEqual({ version: v + 1 });
    expect(data(await run(ada, getSettings, {}))).toMatchObject({ rfqRequiredAbove: '500', minQuotes: 2, version: v + 1 });
    expect((await auditOf('1')).at(-1)).toMatchObject({ action: 'settings.updated', actor: ada, changes: { rfqRequiredAbove: [null, '500'], minQuotes: [3, 2] } });
    expect(Object.keys((await auditOf('1')).at(-1).changes).sort()).toEqual(['minQuotes', 'rfqRequiredAbove']);
    const events = (await auditOf('1')).length;
    expect(data(await run(ada, updateOrganizationSettings, { ...base, rfqRequiredAbove: '500.0000', minQuotes: 2, expectedVersion: v + 1 }))).toEqual({ version: v + 1 });
    expect((await auditOf('1')).length).toBe(events);
    expect(data(await run(ada, updateOrganizationSettings, { ...base, rfqRequiredAbove: null, minQuotes: 10, expectedVersion: v + 1 }))).toEqual({ version: v + 2 });
    expect((await auditOf('1')).at(-1)).toMatchObject({ changes: { rfqRequiredAbove: ['500', null], minQuotes: [2, 10] } });
    expect(data(await run(ada, updateOrganizationSettings, { ...base, rfqRequiredAbove: '0', minQuotes: 3, expectedVersion: v + 2 }))).toEqual({ version: v + 3 });
    expect(data(await run(ada, getSettings, {}))).toMatchObject({ rfqRequiredAbove: '0', minQuotes: 3 });

    for (const statement of ['UPDATE org_settings SET min_quotes = 0', 'UPDATE org_settings SET min_quotes = 11', 'UPDATE org_settings SET rfq_required_above = -1']) {
      expect(await sqlStateOf(() => t.appPool.query(statement))).toBe('23514');
    }
  });
});

describe('P5a-AC2: publishing approval policies', () => {
  it('rejects invalid policies with field paths, and unknown or inactive departments', async () => {
    const publish = (rules: unknown) => run(ada, publishApprovalPolicy, { documentType: 'requisition', name: 'Bad', rules });
    const gap = await publish([standardRules[0], { ...standardRules[1], minAmount: '1500' }]);
    expect(gap).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    if (!gap.ok) expect(gap.error.fieldErrors?.['rules.1.minAmount']?.[0]).toContain('gap');
    expect(await publish([{ ...standardRules[0], maxAmount: null }, standardRules[1]])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await publish([{ ...standardRules[0], steps: [] }, standardRules[1]])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await publish([...standardRules, { departmentCode: 'OPS', minAmount: '0', maxAmount: null, steps: [{ role: 'finance', scopeMode: 'document_department' }] }])).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await publish([...standardRules, { departmentCode: 'ZZZ', minAmount: '0', maxAmount: null, steps: [approver] }])).toMatchObject({
      ok: false,
      error: { code: 'BUSINESS_RULE', rule: 'UNKNOWN_DEPARTMENT' },
    });
    expect(await publish([...standardRules, { departmentCode: 'OLD', minAmount: '0', maxAmount: null, steps: [approver] }])).toMatchObject({
      ok: false,
      error: { rule: 'UNKNOWN_DEPARTMENT' },
    });
    expect(await run(ada, publishApprovalPolicy, { documentType: 'purchase_order', name: 'PO', rules: standardRules })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(await publish([{ ...standardRules[0], minAmount: 0 }, standardRules[1]])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(data(await run(ada, getActiveApprovalPolicy, { documentType: 'requisition' }))).toBeNull();
  });

  it('publishes versions: the new one is active, the old one superseded, both audited', async () => {
    const v1 = data(await run(ada, publishApprovalPolicy, { documentType: 'requisition', name: 'Standard', rules: standardRules }));
    expect(v1.versionNo).toBe(1);
    const v2 = data(
      await run(ada, publishApprovalPolicy, {
        documentType: 'requisition',
        name: 'Standard + OPS',
        rules: [...standardRules, { departmentCode: 'OPS', minAmount: '0', maxAmount: '500', steps: [finance] }],
      }),
    );
    expect(v2.versionNo).toBe(2);
    const active = data(await run(ada, getActiveApprovalPolicy, { documentType: 'requisition' }));
    expect(active && Object.keys(active).sort()).toEqual([...APPROVAL_POLICY_KEYS].sort());
    expect(active).toMatchObject({
      id: v2.policyId,
      versionNo: 2,
      createdBy: 'Ada Admin',
      rules: [
        { departmentCode: null, minAmount: '0.0000', maxAmount: '1000.0000', steps: [approver] },
        { departmentCode: null, minAmount: '1000.0000', maxAmount: null, steps: [approver, finance] },
        { departmentCode: 'OPS', departmentName: 'Operations', minAmount: '0.0000', maxAmount: '500.0000', steps: [finance] },
      ],
    });
    const versions = data(await run(ada, listApprovalPolicyVersions, { documentType: 'requisition' }));
    expect(versions.map((v) => [v.versionNo, v.supersededAt === null])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect((await auditOf(v2.policyId))[0]).toMatchObject({
      action: 'approvalPolicy.published',
      actor: ada,
      changes: { versionNo: [1, 2], name: ['Standard', 'Standard + OPS'] },
    });
    // The resolver used by submission (Phase 5b) follows the active version.
    expect(await resolveApprovalRoute(t.appDb, 'requisition', opsId, '499.99')).toMatchObject({ versionNo: 2, steps: [finance] });
    expect(await resolveApprovalRoute(t.appDb, 'requisition', opsId, '500')).toMatchObject({ steps: [approver] });
    expect(await resolveApprovalRoute(t.appDb, 'requisition', opsId, '1000')).toMatchObject({ steps: [approver, finance] });
  });

  it('keeps published policies immutable, even for the owner', async () => {
    const { rows } = await t.pool.query("SELECT id FROM approval_policies WHERE document_type = 'requisition' AND version_no = 1");
    const v1 = rows[0].id as string;
    const rule = (await t.pool.query('SELECT id FROM approval_policy_rules WHERE policy_id = $1 ORDER BY rule_no LIMIT 1', [v1])).rows[0].id as string;
    for (const pool of [t.appPool, t.pool]) {
      expect(await sqlStateOf(() => pool.query("UPDATE approval_policies SET name = 'Edited' WHERE id = $1", [v1]))).toBe('PFP01');
      expect(await sqlStateOf(() => pool.query('UPDATE approval_policies SET is_active = true, superseded_at = NULL WHERE id = $1', [v1]))).toBe('PFP01');
      expect(
        await sqlStateOf(() => pool.query("INSERT INTO approval_policy_rules (policy_id, rule_no, min_amount) VALUES ($1, 9, 0)", [v1])),
      ).toBe('PFP01');
      expect(
        await sqlStateOf(() => pool.query("INSERT INTO approval_policy_steps (rule_id, step_no, required_role, scope_mode) VALUES ($1, 4, 'finance', 'organization')", [rule])),
      ).toBe('PFP01');
    }
    expect(await sqlStateOf(() => t.pool.query("UPDATE approval_policy_rules SET min_amount = 1 WHERE id = $1", [rule]))).toBe('PFP01');
    expect(await sqlStateOf(() => t.pool.query('DELETE FROM approval_policy_steps WHERE rule_id = $1', [rule]))).toBe('PFP01');
    expect(await sqlStateOf(() => t.pool.query('DELETE FROM approval_policies WHERE id = $1', [v1]))).toBe('PFP01');
    for (const table of ['approval_policies', 'approval_policy_rules', 'approval_policy_steps']) {
      expect(await sqlStateOf(() => t.appPool.query(`DELETE FROM ${table}`))).toBe('42501');
    }
    expect(await sqlStateOf(() => t.appPool.query('UPDATE approval_policy_rules SET rule_no = 1'))).toBe('42501');
  });

  it('only admins publish or read policies', async () => {
    expect(await run(lena, publishApprovalPolicy, { documentType: 'requisition', name: 'x', rules: standardRules })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await run(rina, getActiveApprovalPolicy, { documentType: 'requisition' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});
