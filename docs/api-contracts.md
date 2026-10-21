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
- **Business-rule sub-codes** (`error.code = 'BUSINESS_RULE'`, `error.rule = ...`): `SELF_APPROVAL`, `DUPLICATE_APPROVER`, `NO_APPROVAL_ROUTE`, `NOT_ELIGIBLE_APPROVER`, `SUPPLIER_NOT_ACTIVE`, `SUPPLIER_DUPLICATE`, `MAKER_CHECKER`, `OVER_ORDER`, `RFQ_REQUIRED`, `MIN_QUOTES_JUSTIFICATION_REQUIRED`, `NON_LOWEST_JUSTIFICATION_REQUIRED`, `QUOTATION_EXPIRED`, `ORDER_RECEIVE_CONFLICT` (SOD-04), `OVER_RECEIPT`, `RECEIPTS_EXIST`, `ALREADY_REVERSED`, `PO_CLOSED`, `SELF_ADMINISTRATION`, `LAST_ADMIN`, `CURRENCY_MISMATCH`, `AMOUNT_TOO_LARGE`, `INTEGRITY_CONSTRAINT` (a database constraint caught what an application check should have; logged at warn).
- **Database conditions are mapped by the runner** (`src/shared/application/runner.ts`, Phase 2):

  | SQLSTATE | Result |
  | --- | --- |
  | `55P03` lock timeout | `CONFLICT` "being changed by someone else" |
  | `40001` / `40P01` | `CONFLICT`, after up to 3 whole-transaction retries for retry-safe commands |
  | `23505` | `CONFLICT` |
  | `23502` / `23503` / `23514` / `23P01` | `BUSINESS_RULE` / `INTEGRITY_CONSTRAINT` |
  | anything else (incl. `PFA01`, `25006`, `57014`) | `INTERNAL`, with a generic message; details only in the server log |

Each command writes the audit action `<command name, past tense>` (e.g. `requisition.submit` writes `requisition.submitted`) unless noted.

---

## Identity and administration

| Command | Permission | Input (key fields) | Guards / rules | Output | REST (later) |
| --- | --- | --- | --- | --- | --- |
| `auth.signIn` / `auth.signOut` | public / session | email, password | Better Auth. Rate-limited. Sign-up disabled. | session cookie | Better Auth routes |
| `admin.user.create` | `admin.users` | email, displayName, departmentId?, initialRoles[] | Email unique. Roles valid. Actor ≠ target (trivially true). | userId, one-time password-setup link (shown once) | `POST /users` |
| `admin.user.deactivate` | `admin.users` | userId, reason, expectedVersion | SOD-05 (not self), `LAST_ADMIN` | ok | `POST /users/{id}/deactivate` |
| `admin.user.reactivate` | `admin.users` | userId, expectedVersion | | ok | `POST /users/{id}/reactivate` |
| `admin.role.grant` | `admin.roles` | userId, role, departmentId? | SOD-05. No duplicate active assignment. | assignmentId | `POST /users/{id}/roles` |
| `admin.role.revoke` | `admin.roles` | assignmentId, reason | SOD-05, `LAST_ADMIN` | ok | `DELETE /role-assignments/{id}` |
| `admin.department.create` / `.update` | `admin.settings` | code, name, isActive | code format, unique | department | `POST/PATCH /departments` |
| `admin.settings.update` | `admin.settings` | any `org_settings` field, expectedVersion | `currency_code` / `currency_scale` cannot change once any monetary document exists | settings | `PATCH /settings` |
| `admin.approvalPolicy.publish` | `admin.approvalPolicies` | documentType, name, rules[{departmentId?, minAmount, maxAmount?, steps[{role, scopeMode}]}] | No overlapping bands. Full coverage from 0. ≥1 step per rule. | policyId (new active version) | `POST /approval-policies` |

Queries: `admin.user.list`, `admin.user.get`, `admin.department.list`, `admin.approvalPolicy.getActive`, `identity.me` (own profile, roles, and effective permissions, used by the UI to hide actions).

## Suppliers

| Command | Permission | Input | Guards | REST (later) |
| --- | --- | --- | --- | --- |
| `supplier.create` | `supplier.manage` | legalName, taxId?, email?, phone?, address{…}, countryCode | SUP-T01, `SUPPLIER_DUPLICATE` | `POST /suppliers` |
| `supplier.update` | `supplier.manage` | id, expectedVersion, fields… | SUP-T02 / SUP-T03 | `PATCH /suppliers/{id}` |
| `supplier.review` | `supplier.review` | id, expectedVersion, decision `approve\|reject`, note? | SUP-T04/T05, `MAKER_CHECKER` | `POST /suppliers/{id}/review` |
| `supplier.block` / `.unblock` | see SUP-T06/T07 | id, expectedVersion, reason | | `POST /suppliers/{id}/block` … |
| `supplier.deactivate` / `.reactivate` | `supplier.manage` | id, expectedVersion | | |

Queries: `supplier.list` (filters: status, search by name/code/tax id), `supplier.get`, `supplier.selectableForPurchasing` (active only).

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
