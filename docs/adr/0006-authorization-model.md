# ADR 0006: Code-defined RBAC, scoped assignments, separation-of-duties policies

- Status: Accepted. Amended by [ADR 0014](0014-identity-and-sign-in.md): `buyer` is renamed `procurement` (same permissions), and every active user gets the base permission `account.read`. Amended 2026-10-22 (Phase 4): new permission `supplier.block`, see below. SOD-01 and SOD-02 implemented in Phase 5b (2026-10-25), see the end.
- Date: 2026-10-18

## Context

Procurement fraud usually exploits weak authorization: approving your own request, creating a fake supplier and paying it, inflating a PO after approval, or confirming receipt of goods you ordered yourself. The brief requires least privilege, a self-approval ban, and server-side enforcement.

## Decision

### 1. Roles are defined in code; assignments are data

Roles and their permission sets live in `src/modules/identity/domain/roles.ts`. Changing a role definition is a code change that goes through review and shows up in git history. Admins can only **assign or revoke** roles, and every assignment change is audited.

A role assignment is `(user, role, scope)`. `scope` is either a department or `null`, meaning organization-wide. Only some roles use scope (see below).

### 2. Roles and permissions

| Permission | requester | approver | buyer | receiver | finance | auditor | admin |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `requisition.create` / edit own draft | ✓ | | | | | | |
| `requisition.read` own | ✓ | | | | | | |
| `requisition.read` in scoped departments | | ✓ (scope) | | | | | |
| `requisition.read` all | | | ✓ | | ✓ | ✓ | |
| `approval.decide` (step role must match) | | ✓ (scope) | | | ✓ | | |
| `supplier.read` | | | ✓ | | ✓ | ✓ | |
| `supplier.manage` (create/edit/block) | | | ✓ | | | | |
| `supplier.review` (activate) | | | | | ✓ | | |
| `rfq.manage`, `quotation.record`, `quotation.award` | | | ✓ | | | | |
| `po.create` / submit / issue / cancel / close | | | ✓ | | | | |
| `po.read` all | | | ✓ | | ✓ | ✓ | |
| `po.read` issued (for receiving) | | | | ✓ | | | |
| `receipt.create` / post / reverse | | | | ✓ | | | |
| `receipt.read` | | | ✓ | ✓ | ✓ | ✓ | |
| `report.view` | | | ✓ | | ✓ | ✓ | |
| `audit.read` | | | | | | ✓ | ✓ |
| `admin.users`, `admin.roles`, `admin.settings`, `admin.approvalPolicies` | | | | | | | ✓ |

A user may hold several roles. **Admin grants no business permissions.** An admin who also needs to buy must be given `buyer` by *another* admin.

### 3. Separation-of-duties (SoD) rules

These rules apply **in addition to** permissions, at the resource level, in application-layer policy functions. Each rule has a test ID.

| ID | Rule |
| --- | --- |
| SOD-01 | **No self-approval.** The submitter of a document (PR requester, PO creator) cannot decide any approval step on it. |
| SOD-02 | **Distinct approvers per round.** One user decides at most one step in a given approval round. |
| SOD-03 | **Supplier maker-checker.** The user who created a supplier, or who last changed its identity fields (legal name, tax ID), cannot activate it. |
| SOD-04 | **Order vs receive.** The creator of a PO cannot create or post a goods receipt for that PO. |
| SOD-05 | **No self-administration.** An admin cannot grant or revoke their own roles or deactivate themselves. The last active admin cannot be removed. |
| SOD-06 | **Award vs approve.** The buyer who awarded the quotation behind a PO cannot approve that PO. |

### 4. Enforcement points

1. **Request context** validates the session on every request and loads the actor's active profile, roles, and scopes. A missing or invalid session means `UNAUTHENTICATED`.
2. **Coarse check** in `runCommand` / `runQuery`: the actor holds the command's permission, or the result is `FORBIDDEN`.
3. **Resource check** inside the transaction, after the row is loaded and locked: scope, ownership, SoD rules, and state. Failure is `FORBIDDEN`, or `NOT_FOUND` for reads the actor may not see, so existence does not leak.
4. **Query scoping:** list queries filter rows in SQL by the actor's visibility (own, department, all). They never filter after fetching.
5. **Defense in depth in the database:** a trigger rejects an approval decision whose `decided_by` equals the request's `submitted_by` (SOD-01). Unique indexes enforce SOD-02.

Pages hide buttons the actor can't use, but hidden buttons are a usability feature, not a security control. Every Server Action re-checks access on its own.

## Amendment (2026-10-22, Phase 4): `supplier.block`

SUP-T06 lets **procurement or finance** block a supplier ("Dewi or Sari", US-SUP-03), but the command runner checks exactly one permission per operation. Instead of giving the runner "any of" permissions, blocking gets its own permission:

| Permission | requester | approver | procurement | receiver | finance | auditor | admin |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `supplier.block` | | | ✓ | | ✓ | | |

Unblocking stays with `supplier.review` (finance), because an unblocked supplier goes back to review. Verified by `tests/unit/roles.test.ts` (168 cells) and the operation matrix in `tests/integration/permission-matrix.test.ts`.

SOD-03 is enforced in `supplier.review` (`MAKER_CHECKER`) and backed by the CHECK `suppliers_maker_checker` (reviewer ≠ creator and ≠ last identity changer). A trigger keeps `created_by_user_id` fixed (`PFS01`), so the maker cannot be rewritten.

## Alternatives considered

- **DB-editable roles and permissions.** Rejected for v1: it lets an admin quietly create a super-role. It can be revisited with its own audit and approval flow.
- **PostgreSQL row-level security (RLS) as the primary control.** Deferred: it needs `SET LOCAL` of the actor per transaction and complicates pooling. It may be added in hardening (Phase 10) as a second layer.
- **ABAC policy engine (Cedar, OPA).** Rejected for v1 as unneeded complexity. Plain TypeScript policy functions are unit-testable and readable.

## Consequences

- Adding a role is a code release.
- Residual risk: two colluding users with complementary roles can still defraud the system. Audit and reporting (for example, a "potential split purchases" report) make this detectable, not impossible.

## Verification

- Phase 3: a table-driven permission-matrix test calls every command and query as every role (plus anonymous) and asserts allow or deny exactly as in the table above.
- SoD tests SOD-01 to SOD-06 land in the phases that introduce the commands (5, 4, 8, 3, 7).

## Implementation of SOD-01 and SOD-02 (Phase 5b, 2026-10-25)

No decision changes; this records where the rules live.

- **Application:** `approval.decide` checks SOD-01 (`SELF_APPROVAL`: the submitter, or the awarding buyer once purchase orders exist) and SOD-02 (`DUPLICATE_APPROVER`: one decision per person per round) after locking the request, then the step's role and scope, read fresh from the database (a revoked assignment stops counting at once, even mid-session). The inbox applies the same rules in SQL, so barred steps are not listed (US-AP-01).
- **Database:** trigger `approval_steps_no_self_approval` (SQLSTATE `PFD01`) and the unique index `approval_steps_distinct_deciders`. Both are proven by direct SQL as the app role in `tests/integration/approvals.test.ts`, and mutation checks show that removing the application check makes the tests fail rather than fall through to the backstop.
- **Resource rule on cancel:** `requisition.cancel` requires `requisition.create` or `po.create` (any of, ADR 0010 amendment); a `po.create` holder who is not the requester may cancel only an approved requisition (PR-T09).
