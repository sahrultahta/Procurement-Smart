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
- **Business-rule sub-codes** (`error.code = 'BUSINESS_RULE'`, `error.rule = ...`): `SELF_APPROVAL`, `DUPLICATE_APPROVER`, `NO_APPROVAL_ROUTE`, `NOT_ELIGIBLE_APPROVER`, `SUPPLIER_NOT_ACTIVE`, `SUPPLIER_DUPLICATE`, `MAKER_CHECKER`, `OVER_ORDER`, `RFQ_REQUIRED`, `MIN_QUOTES_JUSTIFICATION_REQUIRED`, `NON_LOWEST_JUSTIFICATION_REQUIRED`, `QUOTATION_EXPIRED`, `ORDER_RECEIVE_CONFLICT` (SOD-04), `OVER_RECEIPT`, `RECEIPTS_EXIST`, `ALREADY_REVERSED`, `PO_CLOSED`, `SELF_ADMINISTRATION`, `LAST_ADMIN`, `EMAIL_TAKEN`, `UNKNOWN_DEPARTMENT`, `ROLE_NOT_SCOPABLE`, `ROLE_ALREADY_ASSIGNED`, `USER_DEACTIVATED`, `PASSWORD_ALREADY_SET`, `DEPARTMENT_CODE_TAKEN`, `NO_DEPARTMENT`, `CURRENCY_LOCKED`, `IDEMPOTENCY_KEY_REUSED`, `CURRENCY_MISMATCH`, `AMOUNT_TOO_LARGE`, `ZERO_TOTAL`, `NEEDED_BY_IN_PAST`, `ALREADY_ORDERED`, `REQUISITION_NOT_APPROVED`, `QUANTITY_EXCEEDS_REMAINING`, `LINE_ALREADY_IN_RFQ`, `NO_SUPPLIERS_INVITED`, `RESPONSE_DUE_IN_PAST`, `SUPPLIER_NOT_INVITED`, `SUPPLIER_ALREADY_QUOTED`, `INTEGRITY_CONSTRAINT` (a database constraint caught what an application check should have; logged at warn).
- **Database conditions are mapped by the runner** (`src/shared/application/runner.ts`, Phase 2):

  | SQLSTATE | Result |
  | --- | --- |
  | `55P03` lock timeout | `CONFLICT` "being changed by someone else" |
  | `40001` / `40P01` | `CONFLICT`, after up to 3 whole-transaction retries for retry-safe commands |
  | `23505` | `CONFLICT` |
  | `23502` / `23503` / `23514` / `23P01` | `BUSINESS_RULE` / `INTEGRITY_CONSTRAINT` |
  | anything else (incl. `PFA01`, `PFR01`, `PFS01`, `PFO01`, `PFP01`, `PFQ01`, `PFD01`, `PFB01`, `PFB02`, `25006`, `57014`) | `INTERNAL`, with a generic message; details only in the server log |

Each command writes the audit action `<command name, past tense>` (e.g. `requisition.submit` writes `requisition.submitted`) unless noted.

---

## Identity and administration

| Command | Permission | Input (key fields) | Guards / rules | Output | REST (later) |
| --- | --- | --- | --- | --- | --- |
**Implemented in Phase 3b** (`src/modules/identity/application/admin-*.ts`). `admin.settings.update` and `admin.approvalPolicy.publish` are implemented in Phase 5a, in the organization module (details below the table).

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

**Phase 5a (organization module):**
- `admin.settings.update` (`admin.settings`): `orgName` (1–120), `timezone` (IANA), `currencyCode` (ISO 4217), `currencyScale` (0–4), and from Phase 6b `rfqRequiredAbove` (a decimal string, or `null` for "never") and `minQuotes` (1–10), all required, plus `expectedVersion`. Changing the currency or its scale after the first requisition is `CURRENCY_LOCKED`. Audit `settings.updated`. Queries: `admin.settings.get` (`admin.settings`, with `currencyLocked`), and `organization.profile` (`account.read`: every signed-in user; name, time zone, currency, for display).
- `admin.approvalPolicy.publish` (`admin.approvalPolicies`): `documentType` (`requisition` only until Phase 7), `name`, `rules[{ departmentCode | null, minAmount, maxAmount | null, steps[{ role: approver | finance, scopeMode: document_department | organization }] }]`. Overlaps, gaps, missing coverage from 0, an upper limit on the top any-department rule, empty or more than 5 steps, and department-scoped finance steps are `VALIDATION_FAILED` with paths like `rules.1.minAmount`; unknown or inactive departments are `UNKNOWN_DEPARTMENT`. Output `{ policyId, versionNo }`. Audit `approvalPolicy.published` (version, name, rule summaries). Queries `admin.approvalPolicy.getActive` and `admin.approvalPolicy.list` (versions).

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
| `requisition.submit` | owner | id, expectedVersion | PR-T03, `ZERO_TOTAL`, `NEEDED_BY_IN_PAST`, `NO_APPROVAL_ROUTE` | {version, status, approvalRequestId, round} | `POST /requisitions/{id}/submit` |
| `requisition.cancel` | owner, or `po.create` when approved | id, expectedVersion, reason? | PR-T07/T08/T09, `ALREADY_ORDERED` | {version, status} | `POST /requisitions/{id}/cancel` |
| `requisition.close` | `po.create` | id, expectedVersion, reason | PR-T10 | {version, status} | `POST /requisitions/{id}/close` |

Queries (visibility scoped in SQL per ADR 0006): `requisition.list` (own / department / all, depending on role; filters: status, department, date range), `requisition.get` (header, lines with `orderedQty` and remaining, approval history), `requisition.orderable` (approved, remaining qty > 0, for buyers).

**Implemented in Phase 5a:** `requisition.create`, `requisition.update`, `requisition.cancel` (draft and returned only; withdrawing a submitted or approved requisition comes with Phase 5b), `requisition.list`, `requisition.get`. Details:
- `requisition.create` / `.update` take `title` (1–200), `justification` (≤ 2000, blank = null), `neededBy` (`YYYY-MM-DD`, a real date), and `lines` (1–200 of `{ description 1–500, quantity, uom 1–16, estimatedUnitPrice }`, decimals as strings per ADR 0007). The department comes from the requester's profile (`NO_DEPARTMENT` if there is none); the currency and its scale come from the org settings (and lock them); the year in the number is the current year in the org time zone. `create` accepts `idempotencyKey` (`^[A-Za-z0-9_-]{8,100}$`); the same key with different input is `IDEMPOTENCY_KEY_REUSED`.
- `update` and `cancel` are for the requester only: someone who can see the requisition gets `FORBIDDEN`, anyone else `NOT_FOUND`. A no-op update writes nothing.
- Permissions: the three commands need `requisition.create`; the two queries need any one of `requisition.read.own`, `requisition.read.department`, `requisition.read.all` (ADR 0010 amendment). `requisition.list` filters by `status`, `departmentCode`, and `q` (number or title, literal match), pages by number (newest first); a date-range filter is not implemented yet. `requisition.get` returns lines with `orderedQty` and `remainingQty`, user **names** instead of ids, and `callerCanEdit`. Approval history was added in Phase 5b (below).
- Audit actions: `requisition.created`, `requisition.updated` (changed fields, lines as summaries), `requisition.cancelled` (reason).

**Implemented in Phase 5b:** `requisition.submit`, `requisition.cancel` in every state, `requisition.close`. Details:
- `submit` needs `requisition.create` and is for the requester only (`FORBIDDEN` / `NOT_FOUND` as for `update`). It resolves the route from the active policy by the stored department and total and opens an approval round (see Approvals). Output `{ version, status: 'pending_approval', approvalRequestId, round }`. Audit `requisition.submitted` (status, round, the route as "1. Approver for OPS"), plus `approval.requested` on the request.
- `cancel` needs `requisition.create` **or** `po.create` (any of, ADR 0010 amendment). `reason` is optional for drafts and returned requisitions and required (1 to 500) when withdrawing a pending one or cancelling an approved one. Withdrawing also cancels the approval round and its open steps (`approval.cancelled`).
- `close` needs `po.create` and a reason; only approved requisitions. Audit `requisition.closed` (reason).
- `requisition.get` adds `submittedAt`, `approvedAt`, `closedAt`, `closeReason`, `approvalHistory` (every round, oldest first: status, policy version, amount, submitter name, times, and steps with label, status, decider **name**, time, comment), `openDecision` (the step the caller may decide now: `approvalRequestId`, `requestVersion`, `stepNo`, `stepCount`, `label`; null otherwise), and `callerActions` (`edit`, `submit`, `cancel`, `close`, whichever the caller may use now; the commands check again).

## Approvals

| Command | Permission | Input | Guards | Output | REST (later) |
| --- | --- | --- | --- | --- | --- |
| `approval.decide` | `approval.decide` | approvalRequestId, stepNo, expectedVersion (of the request), decision `approve\|reject\|return`, comment? (required for reject/return, ≤2000) | AP-T02/T03/T04, `SELF_APPROVAL`, `DUPLICATE_APPROVER`, `NOT_ELIGIBLE_APPROVER` | {requestStatus, documentType, documentId, documentStatus, version} | `POST /approvals/{id}/steps/{n}/decision` |

Queries: `approval.inbox` (pending steps the actor is eligible to decide, excluding SoD-blocked ones), `approval.history` (per document).

**Implemented in Phase 5b** (`src/modules/approvals/`):
- `approval.decide`: the order of checks and the error for each are in docs/state-machines.md §2. A caller who cannot see the document gets `NOT_FOUND`, the same as for a request that does not exist. Server Actions import it from `src/server/approvals.ts`, the composition root that registers the requisition handler. Audit `approval.decided` (steps before and after, the comment as the reason), plus the document's own event when the round ends.
- `approval.inbox` (`approval.decide`): input `{ limit?: 1..100 = 50 }`, output `{ items, more }`, oldest open step first. Items: request id and version, document type, id, number, title, department code, amount, currency, round, step number and count, step label, submitter **name**, submission time, and when the step opened. Filtered in SQL by role and scope, minus SOD-01 and SOD-02. There is no cursor yet: `more` says that older items exist beyond the limit.
- **History is part of the document**, not a separate query: `requisition.get` returns `approvalHistory`, after its own visibility check. `approval.history` is not registered; purchase orders will embed history the same way (Phase 7).

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

**Implemented in Phase 6a** (`src/modules/sourcing/`): `rfq.create`, `rfq.update`, `rfq.issue`, `rfq.close`, `rfq.cancel`, `rfq.list`, `rfq.get`, and `rfq.sourcingOptions`. Details:
- Input fields: `title` (1–200), `responseDueAt` as a local date and time in the org time zone (`YYYY-MM-DDTHH:mm`, an HTML `datetime-local` value; outputs are ISO 8601 UTC), `lines` (1–200 of `{ requisitionLineId, quantity }`, each line once), `supplierIds` (0–50, each once). `create` takes `requisitionId` and accepts `idempotencyKey`. Descriptions and units come from the requisition lines.
- Errors: `REQUISITION_NOT_APPROVED`, `QUANTITY_EXCEEDS_REMAINING` (`details: [{ lineNo, remaining }]`), `LINE_ALREADY_IN_RFQ` (names the other RFQ), `SUPPLIER_NOT_ACTIVE`, `NO_SUPPLIERS_INVITED` and `RESPONSE_DUE_IN_PAST` (issue only); a line of another requisition is `VALIDATION_FAILED` on `lines.N.requisitionLineId`. `cancel` needs a `reason` (1–500). Outputs: `create` `{ rfqId, number, version }`; the others `{ version }` or `{ version, status }`.
- Permissions: the commands and `rfq.sourcingOptions` need `rfq.manage` (procurement); `rfq.list` and `rfq.get` need `rfq.read` (procurement, finance, auditor; ADR 0006 amendment). These roles read every requisition, so RFQs are not scoped further.
- `rfq.list` filters by `status`, `requisitionId`, and `q` (number or title, literal match), pages by number (newest first). `rfq.get` returns the requisition's number, title, and status, lines with their requisition line numbers, invited suppliers with their current status, user **names**, and `callerActions` (`edit`, `issue`, `close`, `cancel`). `rfq.sourcingOptions` `{ requisitionId, rfqId? }` returns the requisition's lines with what is left and the other RFQ each is on, plus the active suppliers, for the form.
- The comparison matrix, quotations, and award came with Phase 6b (below).

**Implemented in Phase 6b** (`src/modules/sourcing/`): `quotation.record`, `quotation.update`, `quotation.submit`, `quotation.withdraw`, `quotation.award`, and the quotations, comparison, and award in `rfq.get`. Details:
- `quotation.record`: `rfqId`, `supplierId`, `supplierReference` (optional, up to 100; blank means none), `validUntil` (`YYYY-MM-DD`), `leadTimeDays` (whole days, 0–365), `lines` (one `{ rfqLineId, unitPrice }` per RFQ line, each once; `unitPrice` a decimal string ≥ 0 with up to 4 decimals, without tax), and an optional `idempotencyKey`. Returns `{ quotationId, version }`. Errors: `SUPPLIER_NOT_INVITED`, `SUPPLIER_NOT_ACTIVE`, `SUPPLIER_ALREADY_QUOTED`, `INVALID_TRANSITION` unless the RFQ is issued, `VALIDATION_FAILED` on `lines` (a line missing), `lines.N.rfqLineId` (another RFQ's line, or twice), or any field the client may not send (quantities, totals, currency, status, who and when).
- `quotation.update`: `quotationId`, `expectedVersion`, and the same terms and lines; drafts of an issued RFQ only; an unchanged draft writes nothing. Returns `{ version, rfqId }`.
- `quotation.submit`: `quotationId`, `expectedVersion`. `QUOTATION_EXPIRED` (by the org date), `SUPPLIER_NOT_ACTIVE`. Returns `{ version, status, late, rfqId }`.
- `quotation.withdraw`: `quotationId`, `expectedVersion`, `reason` (1–500). A draft is discarded (RFQ issued); a submitted quotation is withdrawn until the award (RFQ issued or closed). Returns `{ version, status, rfqId }`.
- `quotation.award` (`quotation.award`): `rfqId`, `quotationId`, `expectedVersion` (of the RFQ), `justification` (optional, up to 2000; blank means none). Errors in the order of docs/state-machines.md §4, including `MIN_QUOTES_JUSTIFICATION_REQUIRED` and `NON_LOWEST_JUSTIFICATION_REQUIRED` with `details: { reasons, validQuotations, minQuotes, lowestTotal }`. Returns `{ version, status }`.
- Permissions: the four quotation commands need `quotation.record`, the award `quotation.award` (both procurement). Reading is `rfq.get` (`rfq.read`: procurement, finance, auditor).
- `rfq.get` adds `requisitionEstimatedTotal`, `currencyCode`, `currencyScale`; each line's `id`; `quotations` (supplier, status, terms, total, who recorded and submitted it, `late`, withdrawal, `validity` today, `lowest`, `version`, `lines` with `unitPrice`, `lineTotal`, `lowestOnLine`, and the caller's `callerActions`: `edit`, `submit`, `discard`, `withdraw`); `comparison` (`today`, `pastDue`, `validCount`, `lowestTotal`, the current `rfqRequiredAbove` and `minQuotes`, `minQuotesApplies`, `belowMinQuotes`); `award` (who, when, what, the justification, and the stored rule) or null; and the RFQ `callerActions` `record` and `award`. Prices are decimal strings without trailing zeros, totals at the currency scale, user names instead of ids.

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
