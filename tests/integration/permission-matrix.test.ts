import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provisionUser, provisionUserInput, resolveActor, type Role } from '@/modules/identity';
import { createRequestContext, type RequestContext } from '@/shared/application/context';
import { registeredOperations, runCommand, runQuery, type Operation } from '@/shared/application/runner';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/*
 * P3b-AC10 / P3-AC5 / threat E-01: every registered command and query, called as every
 * role (one role per user), as a user with no role, and anonymously, is allowed or
 * denied exactly as ADR 0006 says. The expected table is written out by hand from the
 * ADR, not derived from ROLE_PERMISSIONS, so a wrong permission mapping fails here.
 */

// Load every module, so every operation in the application registers itself.
const modules = import.meta.glob('/src/modules/*/index.ts', { eager: true });

const ROLES_UNDER_TEST = ['admin', 'requester', 'approver', 'procurement', 'receiver', 'finance', 'auditor'] as const;
type Caller = Role | 'no role' | 'anonymous';

/** Who may call each operation. Everyone else signed in gets FORBIDDEN; anonymous gets UNAUTHENTICATED. */
const EXPECTED: Record<string, readonly Caller[]> = {
  'account.me': [...ROLES_UNDER_TEST, 'no role'],
  'admin.user.create': ['admin'],
  'admin.user.update': ['admin'],
  'admin.user.deactivate': ['admin'],
  'admin.user.reactivate': ['admin'],
  'admin.user.issueSetupLink': ['admin'],
  'admin.user.list': ['admin'],
  'admin.user.get': ['admin'],
  'admin.role.grant': ['admin'],
  'admin.role.revoke': ['admin'],
  'admin.department.create': ['admin'],
  'admin.department.update': ['admin'],
  'admin.department.list': ['admin'],
  // Phase 4 (ADR 0006: supplier.manage = procurement, supplier.review = finance,
  // supplier.read = procurement/finance/auditor; supplier.block = procurement or finance).
  'supplier.create': ['procurement'],
  'supplier.update': ['procurement'],
  'supplier.review': ['finance'],
  'supplier.block': ['procurement', 'finance'],
  'supplier.unblock': ['finance'],
  'supplier.deactivate': ['procurement'],
  'supplier.reactivate': ['procurement'],
  'supplier.list': ['procurement', 'finance', 'auditor'],
  'supplier.get': ['procurement', 'finance', 'auditor'],
  'supplier.selectableForPurchasing': ['procurement', 'finance', 'auditor'],
  // Phase 5a. Requisitions: create/edit/cancel need requisition.create (requester); reading
  // needs any one of read.own (requester), read.department (approver), read.all
  // (procurement, finance, auditor). Settings and policies are admin-only.
  'organization.profile': [...ROLES_UNDER_TEST, 'no role'],
  'admin.settings.get': ['admin'],
  'admin.settings.update': ['admin'],
  'admin.approvalPolicy.publish': ['admin'],
  'admin.approvalPolicy.getActive': ['admin'],
  'admin.approvalPolicy.list': ['admin'],
  'requisition.create': ['requester'],
  'requisition.update': ['requester'],
  'requisition.list': ['requester', 'approver', 'procurement', 'finance', 'auditor'],
  'requisition.get': ['requester', 'approver', 'procurement', 'finance', 'auditor'],
  // Phase 5b. Submitting is the requester's; cancelling an approved requisition is also
  // procurement's (PR-T09, po.create), and so is closing (PR-T10). Approval decisions and the
  // inbox need approval.decide (approver, finance); the step's role is checked per step.
  'requisition.submit': ['requester'],
  'requisition.cancel': ['requester', 'procurement'],
  'requisition.close': ['procurement'],
  'approval.decide': ['approver', 'finance'],
  'approval.inbox': ['approver', 'finance'],
  // Phase 6a. Managing RFQs is procurement's (rfq.manage); reading them is also finance's and
  // the auditor's (rfq.read, ADR 0006 amendment). The RFQ form's options are for managers only.
  'rfq.create': ['procurement'],
  'rfq.update': ['procurement'],
  'rfq.issue': ['procurement'],
  'rfq.close': ['procurement'],
  'rfq.cancel': ['procurement'],
  'rfq.list': ['procurement', 'finance', 'auditor'],
  'rfq.get': ['procurement', 'finance', 'auditor'],
  'rfq.sourcingOptions': ['procurement'],
  // Phase 6b. Recording, editing, submitting, and withdrawing quotations need quotation.record;
  // the award needs quotation.award (both procurement). Reading them is rfq.get (rfq.read).
  'quotation.record': ['procurement'],
  'quotation.update': ['procurement'],
  'quotation.submit': ['procurement'],
  'quotation.withdraw': ['procurement'],
  'quotation.award': ['procurement'],
  // Phase 7. Purchase orders are procurement's (po.create); reading them is also finance's and the
  // auditor's (po.read.all), the approvers' for their departments (po.read.department, ADR 0006
  // amendment), and the receivers' once issued (po.read.issued). The form's options are for buyers.
  'po.create': ['procurement'],
  'po.update': ['procurement'],
  'po.submit': ['procurement'],
  'po.issue': ['procurement'],
  'po.cancel': ['procurement'],
  'po.close': ['procurement'],
  'po.list': ['approver', 'procurement', 'receiver', 'finance', 'auditor'],
  'po.get': ['approver', 'procurement', 'receiver', 'finance', 'auditor'],
  'po.formOptions': ['procurement'],
  // Phase 8. Recording, posting, cancelling, and reversing goods receipts need receipt.create
  // (receivers); so does the list of orders waiting for goods (po.receivable) and the receipt
  // form's options. Reading receipts is receipt.read (procurement, receivers, finance, auditor).
  'po.receivable': ['receiver'],
  'receipt.create': ['receiver'],
  'receipt.post': ['receiver'],
  'receipt.cancel': ['receiver'],
  'receipt.reverse': ['receiver'],
  'receipt.list': ['procurement', 'receiver', 'finance', 'auditor'],
  'receipt.get': ['procurement', 'receiver', 'finance', 'auditor'],
  'receipt.formOptions': ['receiver'],
};

let t: TestDatabase;
const contexts = new Map<Caller, RequestContext>();

beforeAll(async () => {
  t = await createTestDatabase();
  for (const role of [...ROLES_UNDER_TEST, 'no role'] as const) {
    // Real users with real assignments, resolved the way every request resolves its actor.
    const input = provisionUserInput.parse({
      email: `${role.replace(' ', '-')}@example.com`,
      name: `Matrix ${role}`,
      departmentCode: null,
      roles: role === 'no role' ? [] : [{ role, departmentCode: null }],
    });
    const { userId } = await t.appDb.transaction((tx) => provisionUser(tx, createRequestContext({ actor: null }), input, 'system:test'));
    const actor = await resolveActor(t.appDb, userId);
    if (!actor) throw new Error(`no actor for ${role}`);
    contexts.set(role, createRequestContext({ actor }));
  }
  contexts.set('anonymous', createRequestContext({ actor: null }));
});

afterAll(async () => {
  await t?.drop();
});

function operations(): Operation<unknown, unknown>[] {
  const found: Operation<unknown, unknown>[] = [];
  for (const exports of Object.values(modules) as Record<string, unknown>[]) {
    for (const value of Object.values(exports)) {
      if (value && typeof value === 'object' && 'kind' in value && 'permission' in value && 'name' in value) {
        found.push(value as Operation<unknown, unknown>);
      }
    }
  }
  return found;
}

describe('P3b-AC10: permission matrix (ADR 0006)', () => {
  it('covers every registered operation, and only those', () => {
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(3);
    const registered = registeredOperations().map((o) => o.name).sort();
    expect(registered).toEqual(Object.keys(EXPECTED).sort());
    expect(operations().map((o) => o.name).sort()).toEqual(registered);
  });

  const callers: Caller[] = [...ROLES_UNDER_TEST, 'no role', 'anonymous'];
  for (const [name, allowed] of Object.entries(EXPECTED)) {
    it(`${name}: allowed for ${allowed.join(', ')}; denied for everyone else`, async () => {
      const operation = operations().find((o) => o.name === name);
      if (!operation) throw new Error(`${name} is not exported by any module`);
      for (const caller of callers) {
        const context = contexts.get(caller);
        if (!context) throw new Error(`no context for ${caller}`);
        // `{}` fails validation for every operation that needs input, so allowed calls never write anything.
        const result =
          operation.kind === 'command'
            ? await runCommand(context, operation, {}, { db: t.appDb })
            : await runQuery(context, operation, {}, { db: t.appDb });
        const code = result.ok ? 'ok' : result.error.code;
        const expected = caller === 'anonymous' ? 'UNAUTHENTICATED' : allowed.includes(caller) ? 'passes authorization' : 'FORBIDDEN';
        const actual = code === 'UNAUTHENTICATED' || code === 'FORBIDDEN' ? code : 'passes authorization';
        expect({ caller, result: actual }).toEqual({ caller, result: expected });
      }
    });
  }
});
