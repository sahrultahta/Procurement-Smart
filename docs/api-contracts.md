# API contracts (application commands and queries)

These are the contracts of the application layer (ADR 0010). In v1 they are invoked through Server Actions. The "REST (later)" column is the planned `/api/v1` mapping and is **not implemented** until its phase.

## Conventions (all commands)

- **Envelope:** `Result<T>` as in ADR 0010. HTTP status codes apply only to the later REST transport.
- **Runner order:** authenticate → permission → validate (Zod, `.strict()`) → transaction → resource checks + domain transition → persist → audit → commit.
- **Decimals** are strings (ADR 0007). Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 UTC.
- **`expectedVersion: int`** is required on every command that changes an existing aggregate. A mismatch returns `CONFLICT`.
- **`idempotencyKey?: string(8..100)`** is accepted on every `*.create` command (ADR 0008 C6).
- **Never accepted from clients:** ids of new rows, numbers, totals, statuses, `*_by` / `*_at` fields, `department_id` on requisitions (taken from the actor's profile), `currency_code` (taken from org settings). Sending them fails strict validation.
- **Lists:** cursor pagination `{ cursor?: string, limit?: 1..100 = 25 }`. Sorting only by whitelisted fields. Filters are typed enums or dates, never raw SQL fragments.
- **Business-rule sub-codes** (`error.code = 'BUSINESS_RULE'`, `error.rule = ...`): `SELF_APPROVAL`, `DUPLICATE_APPROVER`, `NO_APPROVAL_ROUTE`, `NOT_ELIGIBLE_APPROVER`, `SUPPLIER_NOT_ACTIVE`, `SUPPLIER_DUPLICATE`, `MAKER_CHECKER`, `OVER_ORDER`, `RFQ_REQUIRED`, `MIN_QUOTES_JUSTIFICATION_REQUIRED`, `NON_LOWEST_JUSTIFICATION_REQUIRED`, `QUOTATION_EXPIRED`, `ORDER_RECEIVE_CONFLICT` (SOD-04), `OVER_RECEIPT`, `RECEIPTS_EXIST`, `ALREADY_REVERSED`, `PO_CLOSED`, `SELF_ADMINISTRATION`, `LAST_ADMIN`, `EMAIL_TAKEN`, `UNKNOWN_DEPARTMENT`, `ROLE_NOT_SCOPABLE`, `ROLE_ALREADY_ASSIGNED`, `USER_DEACTIVATED`, `PASSWORD_ALREADY_SET`, `DEPARTMENT_CODE_TAKEN`, `CURRENCY_MISMATCH`, `AMOUNT_TOO_LARGE`, `INTEGRITY_CONSTRAINT` (a database constraint caught what an application check should have; logged at warn).
- **Database conditions are mapped by the runner** (`src/shared/application/runner.ts`, Phase 2):

  | SQLSTATE | Result |
  | --- | --- |
  | `55P03` lock timeout | `CONFLICT` "being changed by someone else" |
  | `40001` / `40P01` | `CONFLICT`, after up to 3 whole-transaction retries for retry-safe commands |
  | `23505` | `CONFLICT` |
  | `23502` / `23503` / `23514` / `23P01` | `BUSINESS_RULE` / `INTEGRITY_CONSTRAINT` |
  | anything else (incl. `PFA01`, `PFR01`, `PFS01`, `25006`, `57014`) | `INTERNAL`, with a generic message; details only in the server log |

Each command writes the audit action `<command name, past tense>` (e.g. `requisition.submit` writes `requisition.submitted`) unless noted.

---

## Identity and administration

| Command | Permission | Input (key fields) | Guards / rules | Output | REST (later) |
| --- | --- | --- | --- | --- | --- |
**Implemented in Phase 3b** (`src/modules/identity/application/admin-*.ts`), except `admin.settings.update` and `admin.approvalPolicy.publish`, which arrive with the phases that use them.

Every `admin.user.*` and `admin.role.*` command first takes the admin-set lock (ADR 0008 C9) and re-checks that the caller still holds the permission (`FORBIDDEN` otherwise). Departments are referred to by `departmentCode` (`^[A-Z0-9-]{2,16}$`), not by id, except in `admin.department.update`. `departmentCode: null` means "no department" for a profile, and "whole organization" for a role scope.

| Command | Permission | Input (key fields) | Guards / rules | Output | REST (later) |
| --- | --- | --- | --- | --- | --- |
| `auth.signIn` / `auth.signOut` | public / session | email, password | Better Auth. Rate-limited. Sign-up disabled. A deactivated user (or one without a profile) gets the same 401 as a wrong password, no session, and an `auth.signInRejected` audit event. | session cookie | Better Auth routes |
| `admin.user.create` | `admin.users` (+ `admin.roles` when roles are given) | email, name, departmentCode, roles[{role, departmentCode}] | `EMAIL_TAKEN` (case-insensitive). `UNKNOWN_DEPARTMENT` (unknown or inactive). `ROLE_NOT_SCOPABLE` (only requester/approver take a department). The same role and scope twice → `VALIDATION_FAILED`. | userId. The Server Action then issues the one-time link (`admin.user.issueSetupLink`), shown once. | `POST /users` |
| `admin.user.update` *(added 3b)* | `admin.users` | userId, name, departmentCode, expectedVersion | `SELF_ADMINISTRATION`. `UNKNOWN_DEPARTMENT` for a *new* inactive department (an unchanged one is kept). Email cannot change. A no-op writes nothing. | version | `PATCH /users/{id}` |
| `admin.user.deactivate` | `admin.users` | userId, reason (1–500), expectedVersion | `SELF_ADMINISTRATION`, `LAST_ADMIN`. Already deactivated → `INVALID_TRANSITION`. In the same transaction, deletes all the user's sessions and unused setup links. | version, revokedSessions | `POST /users/{id}/deactivate` |
| `admin.user.reactivate` | `admin.users` | userId, expectedVersion | `SELF_ADMINISTRATION`. Already active → `INVALID_TRANSITION`. The user signs in again with their existing password. | version | `POST /users/{id}/reactivate` |
| `admin.user.issueSetupLink` *(added 3b)* | `admin.users` | userId | `SELF_ADMINISTRATION`. `USER_DEACTIVATED`. `PASSWORD_ALREADY_SET`: links are only for accounts that never set a password, so an admin cannot take over an account in use. Deletes earlier unused links. The token is created by Better Auth **after** this commits (`src/server/admin-links.ts`). | email (to the Server Action, which returns only the link) | `POST /users/{id}/setup-link` |
| `admin.role.grant` | `admin.roles` | userId, role, departmentCode | `SELF_ADMINISTRATION`. `USER_DEACTIVATED`. `ROLE_NOT_SCOPABLE`. `UNKNOWN_DEPARTMENT`. `ROLE_ALREADY_ASSIGNED` (same role and scope active; unique index as backstop). | assignmentId | `POST /users/{id}/roles` |
| `admin.role.revoke` | `admin.roles` | assignmentId, reason (1–500) | `SELF_ADMINISTRATION`, `LAST_ADMIN` (admin role). Already revoked → `INVALID_TRANSITION`. The row is kept; a trigger forbids any other change (`PFR01`). | assignmentId | `DELETE /role-assignments/{id}` |
| `admin.department.create` | `admin.settings` | code, name | Code format. `DEPARTMENT_CODE_TAKEN`. | departmentId | `POST /departments` |
| `admin.department.update` | `admin.settings` | departmentId, name, isActive, expectedVersion | The code cannot change (sending it fails validation). Inactive: existing members and scopes stay, nobody new gets it. A no-op writes nothing. | version | `PATCH /departments/{id}` |
| `admin.settings.update` | `admin.settings` | any `org_settings` field, expectedVersion | `currency_code` / `currency_scale` cannot change once any monetary document exists | settings | `PATCH /settings` |
| `admin.approvalPolicy.publish` | `admin.approvalPolicies` | documentType, name, rules[{departmentId?, minAmount, maxAmount?, steps[{role, scopeMode}]}] | No overlapping bands. Full coverage from 0. ≥1 step per rule. | policyId (new active version) | `POST /approval-policies` |

Audit actions: `user.provisioned`, `role.granted` (create), `user.updated`, `user.deactivated` (with reason, `revokedSessions`, `invalidatedSetupLinks`), `user.reactivated`, `user.setupLinkIssued`, `role.granted`, `role.revoked` (with reason), `department.created`, `department.updated`. Setup-link tokens are never written to audit events (tested), and the application logger never receives them (the runner logs no inputs or outputs).

Queries:
- **Implemented:** `account.me` (Phase 3a; own profile, roles, and effective permissions); `admin.user.list` (`status?`, cursor by email, `limit` 1–100); `admin.user.get`; `admin.department.list`. Admin DTOs are field allowlists (`ADMIN_USER_*_KEYS`, `DEPARTMENT_DTO_KEYS`).
- **Later:** `admin.approvalPolicy.getActive` (Phase 5).

`idempotencyKey` is not accepted by the Phase 3b create commands yet: a repeated `admin.user.create` or `admin.department.create` fails on the unique email or code, so it never creates a duplicate. The `idempotency_keys` table arrives with the first document-creating command.

## Suppliers

| Command | Permission | Input | Guards | REST (later) |
| --- | --- | --- | --- | --- |
| `supplier.create` | `supplier.manage` | supplier fields | SUP-T01, `SUPPLIER_DUPLICATE` (message names the existing code) | `POST /suppliers` |
| `supplier.update` | `supplier.manage` | supplierId, expectedVersion, supplier fields (all of them) | SUP-T02 / SUP-T03; a no-op writes nothing; `SUPPLIER_DUPLICATE` on an identity change | `PATCH /suppliers/{id}` |
| `supplier.review` | `supplier.review` | supplierId, expectedVersion, decision `approve\|reject`, note (required to reject) | SUP-T04/T05, `MAKER_CHECKER` | `POST /suppliers/{id}/review` |
| `supplier.block` | `supplier.block` (procurement, finance) | supplierId, expectedVersion, reason | SUP-T06 | `POST /suppliers/{id}/block` |
| `supplier.unblock` | `supplier.review` | supplierId, expectedVersion, reason | SUP-T07 | `POST /suppliers/{id}/unblock` |
| `supplier.deactivate` | `supplier.manage` | supplierId, expectedVersion, reason | SUP-T08 | `POST /suppliers/{id}/deactivate` |
| `supplier.reactivate` | `supplier.manage` | supplierId, expectedVersion | SUP-T09, `SUPPLIER_DUPLICATE` (name taken meanwhile) | `POST /suppliers/{id}/reactivate` |

**Implemented in Phase 4** (`src/modules/suppliers/application/`). Supplier fields: `legalName` (1–200, at least one letter or digit), `taxId` (letters, digits, spaces, `. - /`; 5–30 letters or digits), `email`, `phone`, `addressLine1`, `addressLine2`, `city`, `region`, `postalCode`, `countryCode` (ISO 3166-1 alpha-2). Blank optional fields become null. Code, status, normalized keys, and reviewers are never accepted.

Audit actions: `supplier.created`, `supplier.updated`, `supplier.reviewed` (note as reason), `supplier.blocked`, `supplier.unblocked`, `supplier.deactivated` (reason), `supplier.reactivated`, each with before/after of the supplier fields and status.

Queries (`supplier.read`: procurement, finance, auditor; every holder sees every supplier):
- `supplier.list`: `q?` (≤ 100; matches the name key, the code, or the tax ID key, all literally), `status?`, cursor by code, `limit` 1–100. Keys `SUPPLIER_SUMMARY_KEYS`.
- `supplier.get`: details with user **names** (not ids) for creator, identity changer, and reviewer, plus `callerIsMaker`. Keys `SUPPLIER_DETAIL_KEYS`.
- `supplier.selectableForPurchasing`: active suppliers only, `{ id, code, legalName }` (SUP-R1).

## Requisitions

| Command | Permission | Input | Guards | Output | REST (later) |
| --- | --- | --- | --- | --- | --- |
| `requisition.create` | `requisition.create` | title, justification?, neededBy, lines[1..200]{description, quantity, uom, estimatedUnitPrice}, idempotencyKey? | PR-T01, `AMOUNT_TOO_LARGE` | {id, number, version, estimatedTotal} | `POST /requisitions` |
| `requisition.update` | owner | id, expectedVersion, same fields | PR-T02 (draft/returned only) | {version, estimatedTotal} | `PUT /requisitions/{id}` |
| `requisition.submit` | owner | id, expectedVersion | PR-T03, `NO_APPROVAL_ROUTE` | {status, approvalRequestId} | `POST /requisitions/{id}/submit` |
| `requisition.cancel` | owner, or `po.create` when approved | id, expectedVersion, reason? | PR-T07/T08/T09 | {status} | `POST /requisitions/{id}/cancel` |
| `requisition.close` | `po.create` | id, expectedVersion, reason | PR-T10 | {status} | `POST /requisitions/{id}/close` |

Queries (visibility scoped in SQL per ADR 0006): `requisition.list` (own / department / all, depending on role; filters: status, department, date range), `requisition.get` (header, lines with `orderedQty` and remaining, approval history), `requisition.orderable` (approved, remaining qty > 0, for buyers).

## Approvals

| Command | Permission | Input | Guards | Output | REST (later) |
| --- | --- | --- | --- | --- | --- |
| `approval.decide` | `approval.decide` | approvalRequestId, stepNo, expectedVersion (of the request), decision `approve\|reject\|return`, comment? (required for reject/return, ≤2000) | AP-T02/T03/T04, `SELF_APPROVAL`, `DUPLICATE_APPROVER`, `NOT_ELIGIBLE_APPROVER` | {requestStatus, documentStatus} | `POST /approvals/{id}/steps/{n}/decision` |

Queries: `approval.inbox` (pending steps the actor is eligible to decide, excluding SoD-blocked ones), `approval.history` (per document).

## Sourcing

| Command | Permission | Input | Guards | REST (later) |
| --- | --- | --- | --- | --- |
| `rfq.create` | `rfq.manage` | requisitionId, title, responseDueAt, lines[{requisitionLineId, quantity}], supplierIds[] | RFQ-T01 | `POST /rfqs` |
| `rfq.update` | `rfq.manage` | id, expectedVersion, … | RFQ-T02 | `PUT /rfqs/{id}` |
| `rfq.issue` / `rfq.close` / `rfq.cancel` | `rfq.manage` | id, expectedVersion, reason? | RFQ-T03/T04/T06 | `POST /rfqs/{id}/{action}` |
| `quotation.record` | `quotation.record` | rfqId, supplierId, supplierReference?, validUntil, leadTimeDays, lines[{rfqLineId, unitPrice}] | QUO-T01/T02 | `POST /rfqs/{id}/quotations` |
| `quotation.update` / `.submit` / `.withdraw` | `quotation.record` | id, expectedVersion, … | QUO-T02/T03/T04 | |
| `quotation.award` | `quotation.award` | rfqId, quotationId, expectedVersion (RFQ), justification? | RFQ-T05 + justification rules | `POST /rfqs/{id}/award` |

Queries: `rfq.list`, `rfq.get` (with a quotation comparison matrix computed server-side: per-line unit prices, totals, lowest-valid flag).

## Purchase orders

| Command | Permission | Input | Guards | REST (later) |
| --- | --- | --- | --- | --- |
| `po.create` | `po.create` | supplierId, quotationId?, paymentTerms?, deliveryAddress?, expectedDeliveryDate?, lines[{requisitionLineId, quotationLineId?, quantity, unitPrice, taxRatePct}], idempotencyKey? | PO-T01, `OVER_ORDER`, `RFQ_REQUIRED`, `SUPPLIER_NOT_ACTIVE`. With `quotationId`, unit prices come **from the quotation** and client prices are ignored. | `POST /purchase-orders` |
| `po.update` | `po.create` | id, expectedVersion, … | PO-T02 | `PUT /purchase-orders/{id}` |
| `po.submit` | `po.create` | id, expectedVersion | PO-T03 | `POST /purchase-orders/{id}/submit` |
| `po.issue` | `po.create` | id, expectedVersion | PO-T05 | `POST /purchase-orders/{id}/issue` |
| `po.close` | `po.create` | id, expectedVersion, reason? | PO-T07 | `POST /purchase-orders/{id}/close` |
| `po.cancel` | `po.create` | id, expectedVersion, reason | PO-T08/T09, `RECEIPTS_EXIST` | `POST /purchase-orders/{id}/cancel` |

Queries: `po.list`, `po.get` (lines with received and remaining qty), `po.receivable` (issued and partially received, for receivers), `po.printView` (HTML print layout; PDF is out of scope for v1).

## Goods receipts

| Command | Permission | Input | Guards | REST (later) |
| --- | --- | --- | --- | --- |
| `receipt.create` | `receipt.create` | purchaseOrderId, receivedOn, deliveryNoteRef?, notes?, lines[{purchaseOrderLineId, quantity, note?}], idempotencyKey? | GR-T01, `ORDER_RECEIVE_CONFLICT` | `POST /goods-receipts` |
| `receipt.post` | `receipt.create` | id, expectedVersion | GR-T02, `OVER_RECEIPT` (with `details: [{lineNo, remaining}]`) | `POST /goods-receipts/{id}/post` |
| `receipt.cancel` | creator | id, expectedVersion, reason? | GR-T03 | |
| `receipt.reverse` | `receipt.create` | id, expectedVersion, reason | GR-T04, `ALREADY_REVERSED`, `PO_CLOSED` | `POST /goods-receipts/{id}/reverse` |

Queries: `receipt.list`, `receipt.get`.

## Audit and reporting (queries only)

| Query | Permission | Input | Output |
| --- | --- | --- | --- |
| `audit.search` | `audit.read` | entityType?, entityId?, actorUserId?, action?, from?, to?, cursor | events (redacted) |
| `audit.entityHistory` | `audit.read`, or read access to that document | entityType, entityId | timeline |
| `report.spendBySupplier` | `report.view` | from, to, basis `issued\|received` | rows {supplier, poCount, total} + `asOf` |
| `report.spendByDepartment` | `report.view` | from, to, basis | rows + `asOf` |
| `report.requisitionCycleTime` | `report.view` | from, to, departmentId? | median, p90, count (submit to approve, in hours) |
| `report.approvalAging` | `report.view` | olderThanDays | pending steps with age |
| `report.openPurchaseOrders` | `report.view` | supplierId? | POs with outstanding qty and value |
| `report.potentialSplitPurchases` | `report.view` | windowDays, from, to | groups of PRs/POs by the same requester+supplier within a window whose individual totals are below a threshold but whose sum exceeds it |
| `report.export` | `report.view` | reportName, params | CSV (formula-injection safe: cells starting with `= + - @` TAB or CR are prefixed with `'`) |

Every report is a live SQL query over committed data. No number on any dashboard is hardcoded or sampled. Every report response carries `asOf` (DB `now()`). Empty data yields empty results and an explicit empty state, never placeholder numbers.
