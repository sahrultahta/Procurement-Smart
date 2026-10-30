# Threat model (v1 design)

Method: STRIDE per trust boundary, plus procurement-specific abuse cases. This model is reviewed at the end of every phase. Any new endpoint, role, or data type requires an update here **before** it is merged.

## 1. Scope and assumptions

- A self-hosted Next.js 16 server (Node.js runtime) behind a TLS-terminating reverse proxy, with PostgreSQL 18 on a private network.
- Users are employees of one organization. There are no supplier logins in v1.
- The operator controls the host, database, and secrets. A malicious operator or DB superuser is **out of scope** (see section 7).
- Not stored in v1: bank details, payment data, attachments, government IDs. Personal data is limited to names, work emails, departments, IP and user agent in sessions and audit.

## 2. Assets

| ID | Asset | Why it matters |
| --- | --- | --- |
| A1 | Credentials and sessions | Account takeover means acting as an approver or buyer |
| A2 | Approval decisions | They authorize spending |
| A3 | Supplier master data | Fake or altered suppliers are a fraud vector |
| A4 | PO quantities and prices | Inflation and over-ordering |
| A5 | Receipt quantities | Over-receipt means paying for goods never delivered (in downstream systems) |
| A6 | Audit trail | Detection and accountability |
| A7 | Role assignments and settings | Privilege escalation, threshold manipulation |
| A8 | Secrets (`BETTER_AUTH_SECRET`, `DATABASE_URL`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`) | Total compromise |

## 3. Threat agents

| ID | Agent | Capability |
| --- | --- | --- |
| T1 | Anonymous internet attacker | Reaches the login page and any public endpoint |
| T2 | Authenticated low-privilege insider (requester, receiver) | Valid session. Can craft raw POSTs to Server Actions and edit hidden form fields. |
| T3 | Privileged insider (buyer, approver, finance) acting alone | Wants to bypass controls for personal gain |
| T4 | Two colluding insiders | Complementary roles |
| T5 | Malicious or compromised admin | Manages users and settings |
| T6 | Compromised dependency or CI | Code execution at build or run time |

## 4. Trust boundaries and data flow

```mermaid
flowchart LR
  B[Browser] -- "TB1: HTTPS<br/>cookies, Server Action POSTs" --> P[Reverse proxy / TLS]
  P -- "TB2" --> N["Next.js server<br/>proxy.ts → pages / actions / route handlers<br/>→ runCommand → modules"]
  N -- "TB3: SQL as procureflow_app" --> D[(PostgreSQL 18)]
  M[Migration job<br/>procureflow_owner] -- "TB4: DDL" --> D
  G[GitHub repo + Actions] -- "TB5: build artifacts, dependencies" --> N
```

## 5. STRIDE analysis

| ID | Boundary | Threat | Mitigation | Verified by |
| --- | --- | --- | --- | --- |
| S-01 | TB1 | Credential stuffing or brute force on login (T1) | Better Auth rate limiting (DB-backed), per client IP resolved past `TRUSTED_PROXIES`. Generic error messages. Minimum password length 12. | Phase 3: rate-limit integration test, E2E message test. Phase 10: behind proxies. |
| S-02 | TB1 | Session theft through XSS | `HttpOnly` cookies. React escaping. `dangerouslySetInnerHTML` banned by lint. Nonce-based CSP. | Phase 3: header test. Lint rule. |
| S-03 | TB1 | Session fixation or replay after logout | Better Auth issues a new session on sign-in. Logout deletes the session row. Deactivation revokes all sessions. | Phase 3: tests US-ID-02 and US-ID-03 |
| S-04 | TB1 | Public self-registration creates accounts (T1) | Sign-up disabled. Users are created only by admins. | Phase 3: sign-up endpoint rejected |
| T-01 | TB1→TB2 | Tampered form fields: totals, status, department, `*_by` (T2) | Strict Zod schemas (`.strict()`) reject unknown fields. Server computes totals and derives department, currency, and actor. | Every phase: tamper tests per command |
| T-02 | TB2 | Editing a document after approval to change quantity or price (T3) | State machine allows edits only in draft/returned. Lines read-only after submit. Issued POs immutable. Version checks. | Phases 5 and 7: invalid-transition tests |
| T-03 | TB3 | SQL injection | Drizzle parameterized queries. `sql.raw` banned outside `db/` scripts. Sort and filter fields whitelisted. | Lint rule. Phase 5: injection-string tests on search filters. |
| T-04 | TB3 | Lost updates or races corrupting counters (T2/T3) | ADR 0008: row locks, versions, conditional updates, CHECK constraints | Concurrency suite CC-01 to CC-07 |
| T-05 | TB1 | CSRF on Server Actions or route handlers | Server Actions are POST-only with Next.js Origin/Host comparison. `SameSite=Lax` cookies. No state change on GET (lint and review rule). Route handlers mutating state also check Origin. | Phase 3: cross-origin POST test |
| T-06 | TB1 | CSV/formula injection in exports | Prefix cells starting with `= + - @`, TAB, or CR | Phase 9 (verified): unit and integration tests |
| R-01 | all | User denies performing an action | Append-only audit in the same transaction, DB clock, actor and role snapshot, request id | Phase 2: audit tests. Every command asserts its audit event. |
| R-02 | TB3 | Audit rows edited or deleted through a compromised app (T2–T5) | App role has only INSERT/SELECT. Triggers block UPDATE/DELETE/TRUNCATE for all roles. | Phase 2: privilege and trigger tests |
| I-01 | TB2 | IDOR: reading another user's PR or PO by id (T2) | Resource checks in every query. List queries scoped in SQL. Unauthorized reads return `NOT_FOUND`. | Phase 5 onward: cross-user read tests per entity |
| I-02 | TB2→TB1 | Over-exposed data in RSC payloads or action results | Data Access Layer returns DTOs only. `server-only` on DAL. Action results minimal. React taint API on user/session objects. | Lint check. Phase 3: test that DTO keys match an allowlist. |
| I-03 | TB2 | Error messages leaking SQL or stack traces | `INTERNAL` returns a generic message. Details only in server logs with request id. | Phase 2: runner test |
| I-04 | TB5 | Secrets committed to the repo | `.env*` gitignored. gitleaks in CI and local script. `.env.example` placeholders only. | Phase 1: gitleaks run in report |
| I-05 | logs | PII or secrets in logs | Structured logger with redaction allowlist. No request bodies logged. | Phase 2: logger unit test |
| D-01 | TB1 | Oversized payloads or line counts (T1/T2) | Max 200 lines per document. String length limits. Server Action body size limit configured. Pagination capped at 100. | Phase 5: validation tests |
| D-02 | TB3 | Long-held locks blocking others | `lock_timeout` 5 s, `statement_timeout` 15 s | CC-07 |
| D-03 | TB1 | Login flood filling audit table | Rate limiting before audit writes. Access-denied events go to logs, not the audit table. | Phase 3 |
| E-01 | TB2 | Calling a Server Action without the required role (T2) | `runCommand` permission check plus resource policy. The page-level check is not relied on. | Phase 3: permission matrix test (every command × every role × anonymous) |
| E-02 | TB2 | Admin escalates self or locks out other admins (T5) | SOD-05. `LAST_ADMIN`. Role definitions in code. All role changes audited. | Phase 3 tests |
| E-03 | TB2 | Lowering approval thresholds to dodge approval (T5) | Settings and policy changes audited. In-flight approvals use the snapshot. Never auto-approve when no route exists. Thresholds visible in reports. | Phase 5 tests. Phase 9 audit view. |
| E-04 | TB5 | Malicious dependency (T6) | Exact pins plus lockfile. `npm ci`. `npm audit` gate. Dependabot. Minimal dependency set. Install scripts reviewed for new dependencies. | Phase 1 onward: audit output in every report |

## 6. Procurement abuse cases

| ID | Abuse case | Control | Test |
| --- | --- | --- | --- |
| AB-01 | Requester approves own PR | SOD-01 (app + DB trigger) | Phase 5b (verified) |
| AB-02 | One approver clears every step | SOD-02 (app + unique index) | Phase 5b (verified) |
| AB-03 | Buyer creates a fake supplier and orders from it | SOD-03 maker-checker. Only active suppliers can be ordered from. | Phase 4 |
| AB-04 | Supplier identity swapped after review | Identity change sends supplier back to review | Phase 4 |
| AB-05 | Buyer inflates PO prices after PR approval | Price-variance tolerance triggers PO approval. SOD-01 and SOD-06 on PO approval. | Phase 7 (verified) |
| AB-06 | Buyer orders more than approved | `OVER_ORDER` (C2 + CHECK) | Phase 7, CC-03 (verified) |
| AB-07 | Buyer skips competitive sourcing | `RFQ_REQUIRED` above threshold. Justification for fewer than min quotes or non-lowest award. | Phases 6 and 7 (verified) |
| AB-08 | Buyer confirms receipt of goods never delivered | SOD-04 (PO creator ≠ receiver) | Phase 8 (verified) |
| AB-09 | Over-receipt to justify a larger invoice downstream | `OVER_RECEIPT` (C2 + CHECK) | Phase 8, CC-04 (verified) |
| AB-10 | Splitting a purchase to stay under thresholds | Not preventable by rule. Detected by the potential-split-purchases report. | Phase 9 (verified) |
| AB-11 | Colluding requester and approver (T4) | Not preventable by SoD. Detected by audit, aging, and spend reports. Residual risk accepted. | n/a |

### Phase 3a status (2026-10-21)

- **S-01** is implemented and verified: DB-backed limit of 5 sign-ins / 60 s per client IP, plus generic errors. **Residual:** the IP comes from `X-Forwarded-For`, which a client can spoof unless a reverse proxy overwrites it. Production must sit behind such a proxy, and Phase 10 configures `trustedProxies` (ADR 0014). There is no per-account limit yet.
- **S-02** CSP with per-request nonce, **S-03** sign-out and replay, **S-04** closed sign-up, and **T-05** cross-origin Better Auth and Server Action POSTs are all verified (`tests/integration/auth.test.ts`, `tests/e2e/auth.spec.ts`). Better Auth 1.7.7 skips its origin check under `NODE_ENV=test` by default; ProcureFlow forces it on.
- **I-02**: the account DTO allowlist is verified (`tests/integration/identity.test.ts`). **E-01**: the static role-to-permission matrix is verified. The per-command matrix arrives with the admin commands in Phase 3b.

### Phase 3b status (2026-10-22)

- **E-01** is verified per operation: `tests/integration/permission-matrix.test.ts` calls all 13 registered commands and queries as each of the 7 roles, a user with no role, and anonymously, against a table written from ADR 0006. It fails if an operation is added without a row. The E2E suite replays a captured admin Server Action POST: with a forged cookie it gets `UNAUTHENTICATED`, with a requester's session `FORBIDDEN`, and from another origin Next.js aborts it.
- **E-02** is verified: SOD-05 for every user and role command (`SELF_ADMINISTRATION`), with database CHECKs as a backstop (self-grant, self-revoke, and now self-deactivation). `LAST_ADMIN` is held by the admin-set lock (ADR 0008 C9) plus a re-check of the caller's own rights under that lock (CC-08, 20 forced overlaps). Role assignments cannot be edited, only revoked once (trigger `PFR01`, for the owner too).
- **S-03** is complete: deactivation deletes all of the user's sessions and unused setup links in the same transaction, and a deactivated user's correct password now gets the same 401 as a wrong one, with no session (before Phase 3b a session row was created and then ignored).
- **New residual risk (T5), accepted for v1:** without email delivery the admin sees the one-time setup link and could use it before the user does. Mitigations: links are issued only to accounts that never set a password (`PASSWORD_ALREADY_SET`), so an account in use cannot be taken over this way; every link is audited (`user.setupLinkIssued`); the user notices, because their link no longer works. It goes away when links are emailed to the user.
- Admin pages still render their queries for non-admins, who get "Access denied" (the queries return `FORBIDDEN`, logged as `query.denied`). No data reaches them.

### Phase 4 status (2026-10-22)

- **AB-03 (fake supplier) is controlled:** SOD-03 maker-checker in `supplier.review` (`MAKER_CHECKER`, even for a user holding procurement and finance), backed by the CHECK `suppliers_maker_checker` and a trigger that keeps the creator fixed (`PFS01`). Only active suppliers are selectable for purchasing (SUP-R1). Duplicates are caught after normalization (maintainer decision): punctuation, spacing, and case in names, and separators in tax IDs no longer create a "new" supplier. Concurrent creates: CC-09.
- **AB-04 (identity swapped after review) is controlled:** any edit of the legal name or tax ID as typed sends an active supplier back to review and clears the old review; the editor becomes a maker. The CHECK `suppliers_active_is_reviewed` makes "active without a review" impossible, and CC-10 shows that an approval racing an identity change cannot leave one.
- **T-03 (SQL injection) for search:** parameterized queries, LIKE wildcards escaped, and search terms normalized; `'; drop table`, `%`, `_`, and `\` are matched literally (tested, plus a mutation check that removing the escaping makes `%` match every supplier).
- **E-01:** all 10 supplier operations are in the operation matrix; the new permission `supplier.block` is in the role matrix (ADR 0006 amendment).
### Phase 5a status (2026-10-23)

- **T-01 (tampered fields)** for requisitions: totals, line totals, status, department, currency, number, requester, and ordered quantity sent by the client are `VALIDATION_FAILED` (strict schemas); totals are computed with the shared pricing function at the org currency scale. JSON numbers for decimals are refused.
- **T-02 (editing after submit):** besides the state machine, a trigger refuses any line change outside `draft` and `returned`, and another keeps a requisition's number, requester, department, and currency fixed (`PFQ01`, for every role).
- **I-01 (IDOR):** requisition lists are filtered in SQL by own / department / all; a requisition the caller may not see is `NOT_FOUND` by id, including for edits. Tested per role, including a requester who is also a department approver.
- **E-03 (threshold manipulation):** approval policies are versioned and immutable (triggers, `PFP01`); every publish is audited with rule summaries; the active rules and the version history are visible to admins. In-flight protection (steps frozen at submit) is Phase 5b.
- **Currency:** locked by the first requisition, in the app (`CURRENCY_LOCKED`) and by a trigger (`PFO01`); tested against a concurrent change.
- **Double submission:** `requisition.create` is idempotent per user and key (C6), and a reused key with different input is refused.

### Phase 5b status (2026-10-25)

- **AB-01 (self-approval) is controlled:** `SELF_APPROVAL` in `approval.decide`, even for a requester who holds `approver` for their own department; the submitter's own steps are not in their inbox; trigger `approval_steps_no_self_approval` (`PFD01`) refuses a direct write as the app role and as the owner.
- **AB-02 (one approver clears every step) is controlled:** `DUPLICATE_APPROVER`, even for a user holding both `approver` and `finance`; the unique index refuses a direct write (`23505`). SOD-02 is per round, so after a return the same approver may decide again.
- **E-03 (threshold manipulation):** the route is frozen at submit; a policy published afterwards does not change in-flight steps (tested). Without an active policy, submission fails (`NO_APPROVAL_ROUTE`); nothing is auto-approved.
- **T-02 (editing after submit):** lines stay read-only while pending (trigger), and editing is possible again only after a return, which then needs a new round with a new snapshot of the amount.
- **T-04 (races):** CC-01 (concurrent decisions on one step) and CC-02 (edit vs submit), plus withdrawal vs the last approval, 20 forced overlaps each (ADR 0008).
- **I-01 (IDOR) for approvals:** deciding on a requisition the caller cannot see is `NOT_FOUND`, the same as a request that does not exist; the inbox lists only steps whose documents the caller can open; history is returned only inside `requisition.get`, after its visibility check, with names instead of user ids.
- **R-01:** every submission, decision, withdrawal, cancellation, and close is audited in the same transaction, with the comment or reason.
- **Approval history is tamper-resistant in the database:** snapshot columns and completed requests are frozen, steps only move forward and cannot be added later, nothing can be deleted (`PFD01` for every role; no DELETE grant).
- **Residual:** if nobody is eligible for a step (for example, the only approver of a department is the requester), the step stays pending; nothing is skipped automatically. The approval-aging report (Phase 9) shows it. There are no notifications yet: approvers have to open their inbox.

### Phase 10 status (2026-10-30, release v0.1.0)

Every row of sections 5 and 6 was reviewed against the code and the tests; the mapping is in [reports/phase-10.md](reports/phase-10.md) ("Threat-model review"). Changes in this phase:

- **S-01 residual closed:** `TRUSTED_PROXIES` (IPs or CIDR ranges) feeds Better Auth's `advanced.ipAddress.trustedProxies`, and the request context and the sign-in audit events resolve the client by the same rule (the first `X-Forwarded-For` address from the right that is not a proxy). Before, the audit trail recorded the leftmost address, which a client can write; and a proxy that appends to the header left every sign-in in one shared rate-limit bucket. Tested with forged leftmost addresses (`tests/integration/auth.test.ts`, `tests/unit/client-ip.test.ts`). Still no per-account limit.
- **R-02 / section 7 (owner or superuser):** the hash-chained audit export (`npm run audit:export`, `audit:verify --against-db`) gives tamper *evidence*: a changed, deleted, or added event in the database, or a changed file, is reported. Kept last hashes are the anchor. It does not prevent tampering.
- **A8 (secrets in build output):** Next.js copies `.env` into the standalone build; `npm run build` now removes it, and a test checks the packaged server has none. The build still holds per-build keys (preview mode, Server Action encryption): docs/deployment.md treats `.next/` as confidential.
- **I-04 / E-04:** gitleaks 8.30.1 over the full history (15 commits): no leaks; over the working tree only ignored local files (`.env`, `.local/`, `.next/`). `npm audit`: nothing at high or critical (4 moderate in development tooling, unchanged since Phase 7, accepted below). actionlint 1.7.12 finds nothing in the CI workflow.
- **Availability of operations:** backup, restore, and a backup → drop → restore drill with per-table checksums and audit verification (docs/operations.md), done on a drill cluster.
- **Deferred, accepted for v0.1.0 (maintainer decision 2026-10-29):** TOTP two-factor authentication (section 7, compromised device: passwords only, rate-limited) and PostgreSQL row-level security as a second authorization layer (authorization is enforced in the application and checked for every operation by the permission matrix; the runtime role cannot change the schema or the audit trail).

### Phase 9 status (2026-10-28)

- **T-06 (CSV/formula injection) is controlled:** every exported text cell starting with `=`, `+`, `-`, `@`, TAB, or CR gets a leading apostrophe; amount and count cells are written as numbers only when they are plain decimals, and as protected text otherwise (unit tests for each prefix, an integration test with an order line named `=2+3 desk lamps`). Exports need `report.view`, like the reports, and accept only the report's own parameters.
- **AB-10 (splitting a purchase) is detected:** the potential-split-purchases report groups orders of one requester and supplier, approved within a window, each below the PO approval threshold (totals) or the RFQ threshold (subtotals, orders from an RFQ award left out), that together reach it. Seeded case and controls tested. It shows leads for review, not proof; a split across two requesters, two suppliers, or a longer window is not found.
- **E-03 (threshold manipulation):** the split report shows the thresholds in force, and audit search finds every `settings.updated` and `approvalPolicy.published` event with before and after values.
- **I-01 (IDOR) for history:** a document's history is returned only inside its get query, after the same visibility check (`NOT_FOUND` otherwise), with names instead of user ids and without request id, IP address, or user agent. Audit search, which shows those, needs `audit.read` (auditor, admin). **E-01:** 9 new operations in the matrix.
- **I-02 (information disclosure through reports):** reports show amounts and names across departments; `report.view` is limited to procurement, finance, and auditors (ADR 0006), and `/reports/export` answers 403 to everyone else.
- **R-01:** reads are not audited (as before); the audit trail stays append-only, and reporting reads it through a view without any write grant.
- **Residual:** reports are computed when opened, with no caching or limits beyond the statement timeout (15 s) and the 10-year range cap; a very large installation could need indexes on the report filters. Audit search matches an action exactly (no prefix search). `report.view` users can export everything they can see; exports are not audited.

### Phase 8 status (2026-10-27)

- **AB-08 (a buyer confirms goods never delivered) is controlled:** SOD-04 refuses the order's creator when recording, posting, or reversing a goods receipt (`ORDER_RECEIVE_CONFLICT`), in the application and in the database (`PFG01`, for every role); screens offer receiving only to receivers who did not create the order.
- **AB-09 (over-receipt) is controlled:** `OVER_RECEIPT` refuses the whole receipt, naming every line, before and while posting (C2), with the CHECK `received_qty <= max_receivable_qty` as the backstop (C3, proven by a direct SQL attempt as the app role). CC-04 (five receivers posting the last units at once, 20 forced overlaps) never over-receives.
- **T-02 (changing records after the fact):** posted and cancelled receipts never change, drafts are never edited, lines are only added to drafts, and nothing is deleted (`PFG01`; no DELETE grant). A received quantity changes only to what the posted receipts and reversals add up to (GR-I1), and an issued order's status only to what its lines say (PO-T06), checked by the database row by row and at commit. A reversal is a separate document with exactly the receipt's lines, once per receipt (unique index).
- **T-01 (tampered fields):** number, kind, status, what an order line ordered or received, and who and when sent by the client are `VALIDATION_FAILED`; quantities over what a line can take are refused whatever the client checks.
- **I-01 (IDOR):** `receipt.read` reads every receipt (no scoping needed: every role holding it reads every issued order). A receiver asking for the form of an order they cannot read gets `NOT_FOUND`. **E-01:** 8 new operations in the matrix.
- **R-01:** recording, posting, cancelling, and reversing are audited in the same transaction, on the receipt (and the reversal), and every status change of the order on the order (`po.receiptStatusChanged`).
- **Residual:** ProcureFlow records what a receiver says arrived; it cannot check the goods. SOD-04 keeps the buyer who ordered from confirming delivery, but a receiver colluding with a supplier (T4) is detected only by audit and reports. Drafts of an order that was closed or cancelled stay as drafts until their creator cancels them (they can no longer be posted).

### Phase 7 status (2026-10-26)

- **AB-05 (inflating PO prices after PR approval) is controlled:** a unit price more than the tolerance above the requisition estimate, or a subtotal above the estimate for those quantities, sends the order to approval, as does any total from the threshold; the database recomputes the reasons from the lines and refuses an order approved on submit that needs approval, a rule other than the one in the settings, and edits after submission (`PFC01`, for every role). With a quotation, prices come from it, whatever the client sends.
- **AB-06 (ordering more than approved) is controlled:** `OVER_ORDER` with C2 and the CHECK, proven under concurrency (CC-03, 20 forced overlaps), and PO-I1 (ordered quantity = what live orders hold) checked by the database at commit.
- **AB-07 (skipping competitive sourcing), the last part:** `RFQ_REQUIRED` at create and again at submit, in the application and the database: at or above the threshold an order comes from an awarded, still valid quotation, at its prices, for no more than it quoted.
- **SOD-01 and SOD-06 on PO approval:** the creator (the only one who submits) and the buyer who awarded the quotation get `SELF_APPROVAL`, are left out of the inbox, and are refused by the trigger; the PO trigger refuses a round that does not name the awarding buyer.
- **T-01 (tampered fields):** number, status, totals, line amounts, descriptions, units, currency, department, and who and when sent by the client are `VALIDATION_FAILED`. **T-02:** issued orders and their lines are immutable for every role (only the receivable quantity is set, once, at issue).
- **I-01 (IDOR):** POs are listed and read per `po.read.all` / `po.read.department` / `po.read.issued` in SQL; anything else is `NOT_FOUND`, also on the print view (`404`). **E-01:** 9 new operations in the matrix; `po.read.department` in the role matrix (ADR 0006 amendment).
- **R-01:** create, edit, submit (with `BELOW_THRESHOLD` when no approval was needed), approval outcomes, issue (receivable quantities), cancel, and close (released quantities) are audited in the same transaction.
- **Residual:** a quotation's validity is checked when its prices are taken (create, edit), not at submit or issue. Receivers see the supplier's contact block of issued orders, and approvers that of their departments' orders (what a printed order carries). ProcureFlow does not send the order: the buyer does, so "issued" records intent, not delivery.

### Phase 6b status (2026-10-25)

- **AB-07 (skipping competitive sourcing), second half:** the award needs a justification when fewer valid quotations than `min_quotes` arrived for a requisition at or above `rfq_required_above`, and whenever the chosen quotation is not the lowest valid total; the justification is the audit event's reason. Only valid quotations count (submitted, not expired, supplier active), so an expired or blocked supplier's low price cannot make up the numbers. The rule the award used is stored with it, so lowering the minimum afterwards leaves a trace, and the database refuses an award whose "fewer than the minimum" flag does not match. `RFQ_REQUIRED` on purchase orders comes in Phase 7.
- **T-01 (tampered fields):** quantities, totals, currency, status, and who and when sent by the client are `VALIDATION_FAILED`; quantities come from the RFQ, totals from the server (and the triggers refuse anything else, also at commit).
- **T-02 (changing a document after it is submitted):** a submitted quotation's terms, lines, and submission time are frozen, and an awarded RFQ cannot change at all, for every role (`PFB02`, `PFB01`).
- **E-01:** the 5 new operations are in the operation matrix (procurement only); finance and the auditor read quotations through `rfq.read`.
- **R-01:** recording, editing, submitting (with the late flag), withdrawing, discarding at close, and the award are audited in the same transaction.
- **Residual:** the buyer who records quotations may also award them; v1 has no maker-checker here (the spec has none). The control comes in Phase 7: SOD-06 keeps the awarding buyer off the purchase order's approval. Expiry and "lowest valid" are checked by the application only (they depend on its clock and the org time zone). Quotations are typed in by the buyer from what suppliers sent outside the system; ProcureFlow cannot prove a supplier really quoted that price.

### Phase 6a status (2026-10-25)

- **AB-07 (skipping competitive sourcing), first half:** RFQs start only from approved requisitions, ask for no more than what is left to order, and invite only active suppliers (SUP-R1), in the application and in the database. A requisition line can be on only one RFQ that is not cancelled, so parallel or duplicate sourcing of the same need is refused (also under concurrency). The justification rules for too few quotes or a non-lowest award, and `RFQ_REQUIRED` on purchase orders, come in Phases 6b and 7.
- **T-01 (tampered fields):** status, number, creator, descriptions, units, and times sent by the client are `VALIDATION_FAILED`; descriptions and units are copied from the requisition (and the trigger refuses anything else).
- **T-02 (changing a document after it is issued):** lines, invitations, title, and due time are frozen once an RFQ is issued, for every role (`PFB01`).
- **T-03:** RFQ search terms are matched literally (`%`, `_`).
- **E-01:** the 8 new operations are in the operation matrix; `rfq.read` is in the role matrix (ADR 0006 amendment).
- **Residual:** ProcureFlow does not send RFQs to suppliers; the buyer does, outside the system, so the invitation list records intent, not delivery.

- **Residual:** normalization does not catch look-alike names that differ in letters (for example "Maju Jaya" and "Maju Jaja") or a dropped legal suffix ("PT Maju Jaya" and "Maju Jaya"). Those remain a review task for finance, not a rule.

## 7. Accepted risks and out of scope

- **DB superuser or schema owner** can alter data and drop triggers. Mitigations are operational: separate credentials, backups, and the hash-chained audit export with its database check (Phase 10, docs/operations.md), which detects such changes but cannot prevent them.
- **Collusion** between users with complementary roles (AB-11) is detectable, not preventable.
- **Compromised endpoint device** of a legitimate user: TOTP 2FA would reduce but not remove this; it was deferred past v0.1.0 (Phase 10 decision), so passwords (12 characters minimum, rate-limited sign-in) are the only factor.
- **Availability under DDoS** is the reverse proxy and hosting provider's job, not the application's.

## 8. Security requirements checklist (verified in phases noted)

- [x] (P3a) Response headers: `Content-Security-Policy` (nonce, `frame-ancestors 'none'`), `Strict-Transport-Security` (production), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimal. Verified by `tests/e2e/security-headers.spec.ts`. HSTS and `upgrade-insecure-requests` are sent only over HTTPS (direct or via `x-forwarded-proto`).
- [x] (P3a) Cookies: `HttpOnly`, `Secure` in production, `SameSite=Lax`, host-only. `Secure` and `__Secure-` are tied to an HTTPS `BETTER_AUTH_URL` (ADR 0014). Verified by `tests/integration/auth.test.ts` and E2E.
- [x] (P1, verified P10) Environment validated at startup with Zod. The packaged server refuses to start with a missing or invalid `DATABASE_URL` or a `BETTER_AUTH_SECRET` under 32 characters, and names the variable without its value (`tests/e2e/startup-config.spec.ts`, against `.next/standalone/server.js`).
- [x] (P2) The app connects as `procureflow_app` (no DDL). Migrations run as `procureflow_owner`. Verified in Phase 2 by `tests/integration/audit.test.ts` (`current_user`, 42501 on DDL/UPDATE/DELETE/TRUNCATE/DISABLE TRIGGER). Deployment wiring documented and followed in Phase 10 (docs/deployment.md steps 3 to 6).
- [x] (P10) `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` documented for multi-instance deployments and rebuilds (docs/deployment.md, "Several instances"; rotation in docs/operations.md).
- [x] (P1, verified P10) No source maps served in production: `productionBrowserSourceMaps: false`, and the packaged server's static files contain no `.js.map` (`tests/e2e/startup-config.spec.ts`).
- [x] (P10) Dependency audit clean at `high`: `npm audit` reports no high or critical advisory. The 4 moderate ones (esbuild ≤ 0.24.2 through `drizzle-kit`, a development-only tool that never runs in production and whose dev server is not used) are accepted until drizzle-kit ships without them (Phase 10 report).
