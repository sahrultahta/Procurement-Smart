## Phase 7 report: purchase orders

- Date: 2026-10-26
- Base commit: `277296d` (Phase 6b). Phase 7 is committed as a single commit on top of it (2026-10-26, at the maintainer's request), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer instruction (2026-10-26): "Oke, lanjut mulai implementasi nya" — implement Phase 7 without a separate plan-approval stop. The plan below was therefore written and implemented in one go; the decisions it takes are listed below. (2026-10-26) The maintainer asked to commit the working tree as one commit.
- Maintainer review (2026-10-26, after the commit): decisions 1 to 13 below accepted as written, none changed.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### Plan and acceptance criteria

Phase 7 delivers PLAN.md P7-AC1 to AC9. They are broken down as follows (each row says which PLAN criterion it covers).

| ID | Acceptance criterion | Covers | Verified by |
| --- | --- | --- | --- |
| P7-AC1 | PO state machine: PO-T01 to T09 as a pure table; every (status, command) pair tested against a table written out by hand | P7-AC1 | unit |
| P7-AC2 | Settings `po_approval_threshold`, `po_price_tolerance_pct`, `over_receipt_tolerance_pct` (admin, validated, audited, DB CHECKs) | settings | integration |
| P7-AC3 | Approval policies for purchase orders: publish, read, version history, admin screen; `NO_APPROVAL_ROUTE` when approval is required and no policy is active | P7-AC5 | integration + E2E |
| P7-AC4 | Create and edit (PO-T01, PO-T02): one approved requisition per PO, active supplier, lines of that requisition, descriptions and units copied, server totals with tax; `OVER_ORDER` reservation and re-reservation of edit deltas; `RFQ_REQUIRED`; with a quotation the prices come from it and client prices are ignored; idempotent create; audit | P7-AC2, AC4 | integration |
| P7-AC5 | Submit (PO-T03): approval needed for the amount threshold, a unit-price variance, or a total variance, tested at the exact edges; otherwise `approved` with the audited reason `BELOW_THRESHOLD`; the reasons and the rule are stored; `RFQ_REQUIRED` checked again | P7-AC5 | unit + integration |
| P7-AC6 | Approval outcomes (PO-T04): approve → `approved`, return → `draft` (editable, a new round on resubmit), reject → `rejected` and every reserved quantity released; PO steps in the inbox; history on the PO | P7-AC2, AC5 | integration |
| P7-AC7 | SOD-01 (PO creator) and SOD-06 (buyer who awarded the quotation) on PO approval, in the application and in the database | P7-AC6 | integration |
| P7-AC8 | Issue (PO-T05): supplier active; `max_receivable_qty = floor3(quantity × (1 + tolerance/100))` with the tolerance stored on the PO; an issued PO and its lines are immutable for every role | P7-AC7 | unit + integration |
| P7-AC9 | Cancel and close (PO-T07 to T09): reserved quantity released exactly; reasons; `RECEIPTS_EXIST`; PO-I1 checked after every test and enforced at commit by the database | P7-AC2 | integration |
| P7-AC10 | Tax and totals per ADR 0007, table tests at 0, 11, and 12.5 %, and the database recomputes every line and the header sums | P7-AC8 | unit + integration |
| P7-AC11 | Visibility and access: who reads which POs, `NOT_FOUND` for others, every new operation in the operation matrix, DTO allowlists | ADR 0006 | integration |
| P7-AC12 | Races, 20 forced overlaps each: CC-03 (parallel creates on one requisition line never over-order), CC-06 (one idempotency key twice in parallel → one PO), cancel vs reject on one pending PO | P7-AC3 | concurrency |
| P7-AC13 | E2E: a PO from an award goes to approval, finance approves, the buyer issues, the print view shows it; a PO below the threshold is approved on submit; the print view is `404` for a user who cannot read the PO | P7-AC9 | E2E |
| P7-AC14 | Definition of done (PLAN.md) | all | commands below |

### Decisions taken within the plan (all accepted by the maintainer, 2026-10-26)

1. **One requisition per purchase order.** A PO has a `requisition_id`, and every line comes from that requisition. The PO's department is the requisition's, which decides the approval route and who can see it. A requisition can have several POs (several suppliers, partial orders).
2. **`over_receipt_tolerance_pct` moves from Phase 8 to Phase 7**, because issuing (PO-T05) needs it. The value used is stored on the PO at issue (`receipt_tolerance_pct`), so a later change cannot alter what an issued PO allows.
3. **New permission `po.read.department` for approvers** (ADR 0006 amendment): a department approver reads the POs of the departments they approve for (an organization-wide approver reads all). Without it, a PO approval step for a department approver would go to someone who cannot open the PO.
4. **Only the PO's creator edits and submits it.** So the submitter, whom SOD-01 excludes from deciding, is always the creator. Issuing, cancelling, and closing are open to every buyer.
5. **With a quotation:** the quotation must be awarded and still valid (by the org date), from the PO's supplier, for the PO's requisition; every line is one of its lines, at its price; the quantity may be lower than quoted, never higher (`QUANTITY_EXCEEDS_QUOTED`). Without a quotation, the buyer enters the price.
6. **What the approval rule compares.** Amount: the PO total including tax ≥ `po_approval_threshold` (no threshold: every PO needs approval). Unit-price variance: a line's unit price above the requisition line's estimate × (1 + tolerance/100). Total variance: the subtotal (without tax, like the estimate) above Σ round(quantity × estimate) × (1 + tolerance/100). The reasons are stored as `AMOUNT_THRESHOLD`, `NO_THRESHOLD`, `PRICE_VARIANCE`, `TOTAL_VARIANCE`, with the threshold and tolerance used, and the database recomputes them.
7. **`RFQ_REQUIRED` is checked at create and again at submit**, so lowering the threshold after a draft exists cannot skip sourcing.
8. **`po.receivable` moves to Phase 8**, which is where receivers use it. Receipt-driven statuses (PO-T06) and closing with receipts also arrive with goods receipts; Phase 7 implements the table rows and the release arithmetic and tests them in the domain.
9. **Expected delivery date** may not be before today (org time zone) when the PO is submitted (`DELIVERY_DATE_IN_PAST`).
10. **New business-rule codes:** `QUOTATION_NOT_AWARDED`, `QUANTITY_EXCEEDS_QUOTED`, `DELIVERY_DATE_IN_PAST`; **new SQLSTATE** `PFC01` for purchase-order guards.
11. **Shared lock on the settings.** Create, submit, and issue read the settings `FOR SHARE` (a settings change waits for them), because the database compares the rule an order stores with the settings.
12. **The supplier's contact block** (address, tax ID, email, phone) is part of `po.get`, so everyone who may read a PO (approvers of its department, receivers once issued) sees what the printed order carries.
13. **Shared approval screens:** the purchase-order page reuses the requisition pages' decision form and approval history (imported across routes, as the requisition page already does with the RFQ badge); the decision redirects to the document it decided.

### What Phase 7 adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Purchase-order state machine (PO-T02 to T05, T07 to T09; PO-T06 as a function for Phase 8), the approval rule, the receivable quantity, release on close | `src/modules/purchasing/domain/purchase-order.ts` |
| Commands `po.create`, `.update`, `.submit`, `.issue`, `.cancel`, `.close`; the approval outcomes (PO-T04) through the approvals port | `src/modules/purchasing/application/{purchase-order-commands,approval-document,purchase-order-locks,purchase-order-input}.ts`, `src/server/approvals.ts` |
| Queries `po.list`, `po.get`, `po.formOptions`; visibility by `po.read.all` / `po.read.department` / `po.read.issued` | `src/modules/purchasing/application/{purchase-order-queries,visibility}.ts` |
| What purchasing reads from other modules: requisition lines and the ordered-quantity counter (C2), the awarded quotation, the supplier's contact block, the purchasing rules (with a shared lock), approval rounds that name the awarding buyer | `src/modules/requisitions/application/purchasing.ts`, `src/modules/sourcing/application/purchasing.ts`, `src/modules/suppliers/application/directory.ts`, `src/modules/organization/application/settings.ts`, `src/modules/approvals/application/approval-requests.ts` |
| Settings `po_approval_threshold`, `po_price_tolerance_pct`, `over_receipt_tolerance_pct` (admin, audited); approval policies for purchase orders | `src/modules/organization/application/{settings,approval-policies}.ts`, Admin → Settings → Purchase orders, Admin → Approval policy → Purchase orders |
| New permission `po.read.department` for approvers (ADR 0006 amendment) | `src/modules/identity/domain/roles.ts` |
| Tables `purchase_orders`, `purchase_order_lines`, three settings columns; grants; triggers `purchase_orders_guard`, `purchase_order_lines_guard` (`PFC01`), commit-time totals and PO-I1 checks | `db/migrations/0016` (generated), `0017` (hand-written) |
| Screens: **Purchase orders** list, create (directly or from an award), detail (details, approval reasons, lines with estimates and tax, totals, decision form, approval history, actions), edit, and a **print view** without the app's navigation; links from the requisition page, the awarded RFQ, and the approval inbox | `src/app/(app)/purchase-orders/**`, `src/app/(print)/**`, requisition and RFQ pages, inbox, navigation |
| Seed: the PO rule (1,000, 5 %, 0), a PO policy, *Cleaning supplies for Operations* (to order directly), *Standing desks for Operations* (its RFQ awarded); a requisition an interrupted run left waiting is approved on the next run | `scripts/seed.ts` |
| A fix in the shared kernel, found by a Phase 7 test: `quantityInput` and `percentInput` threw instead of refusing a value that is not a decimal at all (`''`, `'abc'`, `'1,5'`) | `src/shared/decimal/decimal.ts` |

### Commands run (exact) and results

One full run of `scratchpad/verify7/run.sh` from `npm ci` (2026-10-26, machine kept awake), with `NEXT_TELEMETRY_DISABLED=1`; before it, each new test file ran on its own while it was written.

| Command | Exit | Result |
| --- | --- | --- |
| `npx drizzle-kit generate --name=purchase_orders` | 0 | `0016`: 2 tables, 3 settings columns, CHECKs, FKs, indexes. Reviewed; additive only |
| `npx drizzle-kit generate --custom --name=purchase_orders_guards_and_grants` | 0 | `0017`: grants, 2 guard triggers, 5 deferred constraint triggers (hand-written) |
| `git diff --stat HEAD -- package.json package-lock.json` | 0 | empty: **no dependency changes** |
| `npm ci` | 0 | 597 packages from the lockfile |
| `npm run db:migrate` | 0 | 0016 and 0017 applied to the development database |
| `npm run lint` | 0 | no findings |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 17 files, **682 passed** (was 556: 126 new) |
| `npm run test:integration` | 0 | 25 files, **328 passed** (was 273: 42 purchase-order tests, 3 races, 1 settings test, 9 matrix operations, and 2 older tests now create a real purchase order) |
| `npx vitest run --coverage` | 0 | **1010 passed**; domain/application scope **1652/1660 lines (99.52 %)**; the purchasing domain, input, locks, queries, and visibility at 100 % of lines; below 100 % of lines: `approval-document.ts` 95.2 %, `purchase-order-commands.ts` 98.9 %, `requisitions/application/purchasing.ts` 90 % (the summary report does not name the lines; not checked line by line) |
| `rm -rf .next && npm run build` | 0 | **0 warnings**; new routes `/purchase-orders`, `/purchase-orders/new`, `/purchase-orders/[id]`, `/purchase-orders/[id]/edit`, `/purchase-orders/[id]/print` |
| `npx playwright test` (twice, back to back) | 0 / 0 | **41 passed** both times (38 earlier + 3 new) |
| `npm audit --omit=dev --audit-level=high` | 0 | nothing at high or above in production dependencies |
| `npm audit` | 1 | the same **4 moderate** findings as in Phase 6b (esbuild through drizzle-kit, development only); no high or critical; no change |
| `node scratchpad/worktree-secret-scan.mjs` | 0 | 18 secrets × 371 committable files, **0 hits** |
| `node scratchpad/doc-links.mjs` | 0 | 55 relative links in 35 files, **0 broken** |
| `npm run seed` (development database, three times) | 1, 0, 0 | the first run stopped (see Failures), the next two completed; the third created nothing (idempotent) |
| `node scratchpad/mut/run7.mjs` | 0 | **24 of 25 killed** on the first run; M23 survived, a test was added, and `run7.mjs M23` then killed it (table below) |
| `npm run lint`, `npm run typecheck`, `npx vitest run` (after that test) | 0 | **1011 passed** (682 unit, 329 integration); the E2E suite and the build were not repeated, because only the test file changed |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| P7-AC1 state machine | **PASS** | All 81 (status, command) pairs against a table written out by hand; terminal states; reasons for closing; PO-T06 `receiptStatus` and the close release at their edges (`tests/unit/purchase-order-domain.test.ts`) |
| P7-AC2 settings | **PASS** | Threshold as a JSON number, negative, with an exponent, with 5 decimals, or empty; tolerances above 100, negative, as numbers, null, with 5 decimals, empty; each left out: `VALIDATION_FAILED`; only admins; audited with only the changed fields; "1000.0000" after "1000" writes nothing; 0 and 100 allowed; CHECKs refuse −1, 100.0001, −0.0001, 101 and NULL in the database (`organization.test.ts`) |
| P7-AC3 PO policies | **PASS** | Without a published PO policy a PO that needs approval gets `NO_APPROVAL_ROUTE` with nothing written; publishing one is version 1 of its own series, audited with its document type, the requisition series untouched; then the same PO submits (`purchase-orders.test.ts`); the policy page switches to purchase orders (E2E) |
| P7-AC4 create and edit | **PASS** | Server-priced draft (2 × 175 at 11 %, 4 × 33.333 at 12.5 % = 538.50), descriptions copied, quantities reserved, audit; 32 kinds of server-only or malformed field refused with nothing written; field paths for a foreign line, a missing price, a stray quotation line; draft, pending, closed, and cancelled requisitions `REQUISITION_NOT_APPROVED`; pending-review, unknown, and blocked suppliers `SUPPLIER_NOT_ACTIVE`; other roles `FORBIDDEN`; `OVER_ORDER` across orders with fractional quantities, naming every line; `RFQ_REQUIRED` at the threshold, not one cent below it; from an award: quoted prices whatever the client sends, its supplier only, its lines only, `QUANTITY_EXCEEDS_QUOTED`, `QUOTATION_NOT_AWARDED`, `QUOTATION_EXPIRED` the day after its last valid day (valid on it), another requisition's quotation refused; idempotency replay and reuse; edits by the creator only, stale version `CONFLICT`, re-reservation of more, less, an added and a removed line, `OVER_ORDER` with nothing changed, an unchanged draft writes nothing, not after submitting or once the requisition is closed, quoted prices kept on edit |
| P7-AC5 submit | **PASS** | 999.81 approved at once with reason `BELOW_THRESHOLD`, the rule stored, no round; 1000.00 exactly `AMOUNT_THRESHOLD`; 189 (= 180 × 1.05) no variance, 189.0001 `PRICE_VARIANCE`; tolerance 0; `TOTAL_VARIANCE` alone from rounding; `NO_THRESHOLD`; reasons in a fixed order; the round's route, amount, and audit; another buyer `FORBIDDEN`, stale `CONFLICT`, twice `INVALID_TRANSITION`, blocked supplier, `DELIVERY_DATE_IN_PAST` the day after (fine on the day), `RFQ_REQUIRED` again after the threshold was lowered; the database refuses approving on submit what needs approval, a rule other than the settings', wrong reasons, and another submitter, and accepts exactly what the command writes |
| P7-AC6 outcomes | **PASS** | Finance approves from the inbox (PO item with title, department, amount, label), history on the PO; return needs a comment, back to an editable draft, round 2 with the new amount; reject releases every line, is terminal, the quantity can be ordered again; a two-step route: Bayu (OPS) opens and decides, Nina (FIN) gets `NOT_FOUND`, finance before the approver step `NOT_ELIGIBLE_APPROVER` |
| P7-AC7 SoD | **PASS** | SOD-01: a creator holding finance is left out of the inbox, gets `SELF_APPROVAL`, and the trigger refuses a direct write as the app role and the owner (`PFD01`). SOD-06: the round names the awarding buyer, who is left out, gets `SELF_APPROVAL`, and is refused by the trigger. The PO trigger refuses a round without the awarding buyer or submitted by someone else (`PFC01`) |
| P7-AC8 issue | **PASS** | 4 × 1.025 = 4.1, 3.333 × 1.025 = 3.416325 → 3.416, stored tolerance, audit; a later settings change does not touch it; tolerance 0 gives the ordered quantity; draft and pending `INVALID_TRANSITION`, stale `CONFLICT`, blocked supplier, twice, other roles `FORBIDDEN`; 12 kinds of change to an issued order or line refused as the app role and as the owner (`PFC01`), delete `42501` / `PFC01`; a submitted (approved or pending) order's lines refused even when every amount stays equal; floor3 table at 9 edges (unit) |
| P7-AC9 cancel and close | **PASS** | Draft, approved, and issued orders cancelled with everything released, reasons required (empty, blank, 501 characters, null), stale `CONFLICT`, audit with what was released; a pending one withdraws its round and leaves the inbox; `RECEIPTS_EXIST` in the app and the database; closing an issued order releases everything, a partially received one keeps the received part ordered, a received one needs no reason; closing a draft or approved order `INVALID_TRANSITION`; PO-I1 checked after every test (`afterEach`) and by the database at commit (drifting ordered quantity and a cancellation without release refused) |
| P7-AC10 tax and totals | **PASS** | 11 table cases at 0, 11, and 12.5 % including half-up edges (0.0055 → 0.01, 0.005 → 0.01, 0.49995 → 0.5000) and scale 0; mixed rates sum the rounded lines; the database refuses a wrong subtotal or tax, a changed description or unit, a foreign requisition line, a stray quotation line, the quoted price or quantity exceeded, header totals out of step (at commit), and a header without lines; 8 kinds of bad insert refused (including a header with no line, at commit) |
| P7-AC11 access | **PASS** | Buyers, finance, the auditor, and Bayu (OPS approver) see draft and issued orders; Nina sees none of OPS; Agus sees issued only (`NOT_FOUND` for the draft); requester and admin `FORBIDDEN`; readers who are not buyers get no actions; allowlisted fields and no user ids; list filters, literal search, cursor, bad input refused; form options with what may still be ordered (plus what the edited order holds), awarded quotations and their expiry; 9 new operations in the matrix (60 in all), `po.read.department` in the role matrix |
| P7-AC12 races | **PASS** | 3 races × 20 forced overlaps (`tests/concurrency/purchase-orders.test.ts`): CC-03 two of five succeed and 3.000 is ordered; CC-06 one order, the same answer twice; cancel vs reject always consistent and released once |
| P7-AC13 E2E | **PASS** | `tests/e2e/purchase-orders.spec.ts`: Dewi orders the seeded cleaning supplies directly (a missing supplier refused with the typed tax rate kept), the draft prints with "Not issued", submitting approves it at once, she issues and prints it (no app navigation on the print view); Agus opens the print view of the issued order (200), Rina gets 404 for it and "Access denied" for the PO page; from the seeded desk award the prices are fixed by the quotation, submitting sends it to approval with the reason shown, Sari approves from the inbox and lands back on the PO, Dewi issues, the print shows the approver and the supplier's reference; the settings and the PO policy page, one h1 and only labeled controls; no CSP violations |
| P7-AC14 definition of done | **PASS**, except `gitleaks`, `actionlint`, and CI (**BLOCKED**) | the tables above |

### Mutation checks

Each change was applied alone (one also changed a second file), the named tests ran, and the files were restored (checked by content after each).

| ID | Mutation | Result |
| --- | --- | --- |
| M1 | create does not check that the requisition is approved | killed (the trigger stops it as `INTERNAL`, not `REQUISITION_NOT_APPROVED`) |
| M2 | `OVER_ORDER` not checked line by line before reserving | killed (C2 still refuses, but names only the first line) |
| M3 | no pre-check and no C2 condition: only the CHECK is left | killed (`INTEGRITY_CONSTRAINT` instead of `OVER_ORDER`, also in CC-03) |
| M4 | cancelling does not release | killed (PO-I1 at commit) |
| M5 | a rejection does not release | killed |
| M6 | closing releases the received part too | killed |
| M7 | `RFQ_REQUIRED` only above the threshold | killed |
| M8 | submit does not check `RFQ_REQUIRED` again | killed (the trigger stops it as `INTERNAL`) |
| M9 | with a quotation, the client price is used | killed (trigger) |
| M10 | more than quoted is allowed | killed (trigger) |
| M11 | an expired quotation can be ordered from | killed |
| M12 | the approval threshold is exclusive | killed (unit and integration) |
| M13 | a price exactly at the limit is a variance | killed |
| M14 | the total variance is never a reason | killed (unit, and the trigger recomputes it) |
| M15 | the round does not name the awarding buyer (SOD-06) | killed (the PO trigger refuses the round) |
| M16 | any buyer can submit | killed (the trigger refuses another submitter) |
| M17 | the receivable quantity rounded half-up | killed (unit: 1.0005 → 1.001) |
| M18 | issuing stores tolerance 0 whatever the settings | killed (trigger) |
| M19 | a department approver reads every PO | killed |
| M20 | receivers also read drafts | killed |
| M21 | the application lets an order with receipts be cancelled | killed (trigger, `INTERNAL` instead of `RECEIPTS_EXIST`) |
| M22 | the database does not recompute the reasons | killed |
| M23 | the database lets lines change outside a draft | **survived the first run**, killed after adding a case (see Failures) |
| M24 | the database does not check PO-I1 at commit | killed |
| M25 | the database accepts a stored rule other than the settings | killed |

### Failures and fixes during the phase

1. **Plpgsql syntax:** a `CASE … THEN … END` inside an `IF` condition ended the condition at its first `THEN` ("syntax error at end of input" when migrating a fresh template). The `CASE` is now in parentheses. Found by migrating an empty test template before any code ran; no database had the broken version.
2. **A variable named `round`** in the PO trigger would have shadowed `round()` used in the same function; renamed before the first run.
3. **Bug in the shared kernel (existing since Phase 2):** `quantityInput` and `percentInput` threw a `DecimalError` instead of refusing a value that is not a decimal at all (`''`, `'abc'`, `'1,5'`), because Zod 4 still runs a refinement after the pattern fails. A Server Action given such a quantity (on requisitions, RFQs, or orders) would have failed with an error page instead of a field message. The refinements now skip values the pattern refused; 8 unit cases added.
4. **The database checked the approval rule only against itself:** a test that stored a higher threshold and tolerance alongside empty reasons was accepted. The trigger now compares the stored rule with the settings (and the receipt tolerance at issue, and `RFQ_REQUIRED`), and the commands read the settings with a shared lock so a concurrent change cannot make that comparison fail spuriously.
5. **Wrong expectations in my tests (no code change):** 189.0001 rounds to a subtotal of 189.00, so it is a price variance only, not also a total variance; a tax rate of 101 % is refused by the guard (`PFC01`) before the CHECK; line indexes in field errors follow the lines sent, not the requisition's; fixtures ordered more chairs than a requisition had (now 10 for the threshold tests).
6. **Two older tests set `ordered_qty` directly** to simulate purchase orders (RFQ "what is left", requisition `ALREADY_ORDERED`). The new commit-time PO-I1 check refuses that, as it should; both now create a real purchase order.
7. **Test isolation:** a failing test left changed settings for the next; the settings are now reset after every test.
8. **Simulating receipts** (Phase 8) needs the guards switched off for one statement as the owner; `ALTER TABLE` refused while commit-time checks were pending, so the helper runs them (`SET CONSTRAINTS ALL IMMEDIATE`) first. Only the test database is touched.
9. **The first seed run stopped** halfway on the development database: the desk requisition (1,300) needs two approval steps, and the seed approved only the first. Each command is its own transaction, so it left a pending requisition and nothing broken. The seed now decides every open step (Bayu, then Sari), so the next run finished that requisition; a third run created nothing.
10. **E2E locator:** the requisition list has no accessible table name; the spec now looks for the table in the page's main area.
11. **M23 survived:** the guard's "lines change only in a draft" rule was never the reason a test failed, because every change to an issued line is also refused by the receivable-quantity rule, and the commit-time totals check refuses the rest. A case now changes a submitted (not yet issued) order's line in ways that keep every amount equal (a tax rate 0.0001 % higher; deleting and inserting the same line); M23 is killed.
12. **Tooling:** shell heredocs with nested quotes failed twice; one appended half a test block, which was removed (checked) and re-added through a script. The desktop app's preview points at another project's folder, so I did not look at the screens in a browser myself.

### Files changed

- New: `src/modules/purchasing/**` (domain, application, infrastructure, index); `src/modules/requisitions/application/purchasing.ts`; `src/modules/sourcing/application/purchasing.ts`, `src/modules/sourcing/tables.ts`; `src/app/(app)/purchase-orders/**` (list, new, detail, edit, actions, form, action forms, status); `src/app/(print)/**` (layout, print page, print button); `db/migrations/0016_purchase_orders.sql`, `0017_purchase_orders_guards_and_grants.sql` and their snapshots; `tests/unit/purchase-order-domain.test.ts`, `tests/integration/purchase-orders.test.ts`, `tests/concurrency/purchase-orders.test.ts`, `tests/e2e/purchase-orders.spec.ts`; this report.
- Changed: approvals (the round records the awarding buyer); identity roles (`po.read.department`); organization settings, policies (both document types), schema, repository, index; requisitions repository (C2 counter) and index; sourcing RFQ repository and index; suppliers directory and index; `src/server/approvals.ts`, `src/server/schema.ts`; `src/shared/decimal/decimal.ts`; screens: navigation, inbox links, requisition page (its POs, "Create purchase order"), RFQ page ("Create purchase order from this award"), decision redirect, admin settings form and action, policy page and editor; `scripts/seed.ts`; migration journal; tests `organization`, `permission-matrix`, `approvals`, `rfqs`, `concurrency/requisitions`, `unit/decimal`, `unit/roles`; docs `PLAN`, `state-machines`, `schema`, `api-contracts`, `architecture`, `threat-model`, `user-stories`, `development`, ADR 0006, ADR 0008, `README`.

### Dependency changes

None.

### Known limitations / not verified

- **Receipt-driven statuses** (PO-T06) and **`po.receivable`** come with goods receipts (Phase 8); the database refuses `issued → partially_received / received` until then. Closing and cancelling with receipts were tested with receipts simulated in the test database.
- A quotation's validity is checked when its prices are taken (create, edit), not again at submit or issue.
- Only the creator can edit or submit a PO; if they leave, another buyer cancels it and creates a new one.
- Search on the PO list is by number only (supplier and requisition are filters).
- ProcureFlow does not send purchase orders; the print view is HTML (the browser's "Save as PDF" makes a PDF).
- `gitleaks` and `actionlint` are not installed here, and CI has not run (no remote).
- **Not verified:** a person looking at the new screens and the printed page (the E2E tests check text, roles, labels, status codes, and behavior, not layout or paper output); browsers other than Microsoft Edge; screen readers.

### Threat-model updates

`docs/threat-model.md` "Phase 7 status": AB-05, AB-06, and AB-07 marked verified; SOD-01 and SOD-06 on PO approval; T-01, T-02, I-01, E-01, R-01 for purchase orders; residual risks (validity at take-time only, supplier contact visible to PO readers, issuing records intent, not delivery).

### Next steps

- Done (2026-10-26): maintainer review of decisions 1 to 13, all accepted as written.
- Phase 8: goods receipts (`receipt.*`, `po.receivable`, PO-T06, CC-04, SOD-04), opening the receipt-driven PO transitions in the trigger.
