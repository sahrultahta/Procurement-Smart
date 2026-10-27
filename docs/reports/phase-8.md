## Phase 8 report: goods receipts

- Date: 2026-10-27
- Base commit: `1877256` (Phase 7 decisions recorded, on top of Phase 7 `4875c21`). Phase 8 is committed as a single commit on top of it (2026-10-27, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer instructions (2026-10-26): "Mulai phase 8" — inspect and plan; (2026-10-27) "Rencana Phase 8 saya setujui, termasuk keputusan 1 sampai 8. Silakan mulai implementasi. Jangan commit tanpa izin saya." The plan and its decisions below were approved before any file changed.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### Plan and acceptance criteria

Phase 8 delivers PLAN.md P8-AC1 to AC7. They are broken down as follows (each row says which PLAN criterion it covers).

| ID | Acceptance criterion | Covers | Verified by |
| --- | --- | --- | --- |
| P8-AC1 | Goods-receipt state machine: every (kind, status, command) triple against a table written out by hand; which orders take receipts and reversals; PO-T06 from the lines | P8-AC1 | unit |
| P8-AC2 | Record (GR-T01): order status (`NOT_FOUND`, `PO_NOT_RECEIVABLE`), SOD-04, lines of this order once each, quantity > 0, dates, `OVER_RECEIPT` already at create, a blocked supplier's issued order still receives, idempotency, audit, fields the client may not send refused | P8-AC4 | integration |
| P8-AC3 | Post (GR-T02): `OVER_RECEIPT` refuses the whole receipt and names every line with what it can take; the exact edge (the receivable quantity passes, 0.001 more does not); the order's status and version; SOD-04; stale versions; audit. The CHECK backstop proven by a direct SQL attempt as the app role | P8-AC2 | integration |
| P8-AC4 | Cancel a draft (GR-T03): its creator only; not once posted; audit | P8-AC1 | integration |
| P8-AC5 | Reverse (GR-T04): a new posted document with the same lines, quantities taken back, the order's status back (received → partially received → issued), once only, `PO_CLOSED`, a reason, not a reversal, SOD-04, audit | P8-AC6 | integration |
| P8-AC6 | The order follows its receipts: status after postings and reversals; cancelling after everything was reversed; `RECEIPTS_EXIST`; closing a partially received or over-received order releases the right quantity; PO-I1 and GR-I1 after every test | P8-AC5 | integration |
| P8-AC7 | Access: the operation matrix with the new operations; who reads what; `NOT_FOUND` for orders receivers cannot read; DTO allowlists; the order's `receive` action | ADR 0006 | integration |
| P8-AC8 | Database guards (`PFG01`, and `PFC01` extended) proven by direct SQL as the app role and the owner: no deletes, frozen receipts, lines only into drafts, SOD-04, received quantities only with documents, the order's status from its lines, reversals that mirror their receipt, one reversal per receipt | P8-AC2, AC6 | integration |
| P8-AC9 | Races, 20 forced overlaps each: CC-04 (five postings on the last units), two reversals of one receipt, a posting and a short-close, a posting and a cancellation | P8-AC3, AC6 | concurrency |
| P8-AC10 | E2E: requisition → approval → order issued → partial receipt → final receipt → order received → reversal → partially received; finance and the auditor only read; one h1 per page, every control labeled, no CSP violations | P8-AC7 | E2E |
| P8-AC11 | Definition of done (PLAN.md) | all | commands below |

### Decisions taken within the plan (accepted by the maintainer before implementation, 2026-10-27)

1. **Drafts are never edited.** The spec has no update command; a wrong draft is cancelled and recorded again. The database has no UPDATE grant on receipt lines and refuses any change to a draft other than posting or cancelling it.
2. **`OVER_RECEIPT` is also checked when a draft is recorded**, against what each line can take at that moment, so a draft that could not be posted is not created. Posting checks again (that check decides).
3. **New business rule `PO_NOT_RECEIVABLE`** for recording or posting a receipt on an order that is not `issued` or `partially_received` (received or closed). An order receivers cannot read at all (not issued yet, or cancelled) is `NOT_FOUND`.
4. **Drafts are not cancelled automatically** when their order is closed or cancelled. They can no longer be posted (`PO_NOT_RECEIVABLE`), and the user who recorded them can cancel them.
5. **A reversal is dated the org day it is recorded**, not the day of the receipt it reverses. A Phase 9 report "by date received" will show the correction in the period it happened.
6. **Everyone with `receipt.read` reads every goods receipt**, drafts included (procurement, receivers, finance, auditors).
7. **Posting and reversing are audited on the receipt (and the reversal) and, when its status changes, on the order** (`po.receiptStatusChanged`, with the receipt's number), so the order's own history shows it.
8. **The Phase 7 test helper that faked receipts** (guards switched off as the owner) **is gone**; those tests now record and post real receipts.

Choices made while implementing, inside the approved plan:

- **`RECEIPTS_EXIST` before the transition check.** With real receipts, an order with anything received is `partially_received` or `received`, so the state table alone would answer `INVALID_TRANSITION` to a cancellation. The command now answers `RECEIPTS_EXIST` ("close it instead") first, as the Phase 7 contract promised. Found by a new test (see Failures).
- **New query `receipt.formOptions`** (`receipt.create`) for the receipt form: the order, today, whether it takes receipts, whether the caller created it, and what each line can still take. `po.receivable` needs `receipt.create` too (the API contracts named it "for receivers" without a permission).
- **Every posting and reversal changes the order's version**, also when its status stays, so a buyer who closes or cancels from an older page gets `CONFLICT` instead of acting on quantities they did not see.
- **A reversal is recorded as a draft and posted in the same command**; the database refuses to commit a reversal that is not posted.

### What Phase 8 adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Goods-receipt state machine (GR-T02 to T04 for receipts and reversals), what a line can still take, `OVER_RECEIPT` per line | `src/modules/receiving/domain/goods-receipt.ts` |
| Commands `receipt.create`, `.post`, `.cancel`, `.reverse`; lock order order → receipt → lines | `src/modules/receiving/application/{goods-receipt-commands,goods-receipt-locks,goods-receipt-input}.ts` |
| Queries `receipt.list`, `receipt.get`, `receipt.formOptions` | `src/modules/receiving/application/goods-receipt-queries.ts` |
| What receiving reads from purchasing: the order with its lines (locked or not), headers for lists, and `applyReceivedQuantities` (C2 on the received quantity, PO-T06, the order's version and audit); `po.receivable`; the `receive` action on `po.get`; `RECEIPTS_EXIST` before the transition | `src/modules/purchasing/application/{receiving,purchase-order-queries,purchase-order-commands}.ts`, `src/modules/purchasing/infrastructure/purchase-order-repository.ts`, `src/modules/purchasing/domain/purchase-order.ts`, `src/modules/purchasing/tables.ts` |
| Tables `goods_receipts`, `goods_receipt_lines`; grants; triggers `goods_receipts_guard`, `goods_receipt_lines_guard` (`PFG01`), the commit-time GR-I1 check; the purchase-order guards opened for PO-T06 and GR-I1 (`PFC01`) | `db/migrations/0018` (generated), `0019` (hand-written) |
| Screens: **Receiving** (orders waiting for goods, for receivers; goods receipts with filters, for readers), **Receive goods** form, receipt detail (details, lines with what the order line has received, post, reverse, cancel); on the order page a **Receive goods** button, a received column, and its goods receipts | `src/app/(app)/goods-receipts/**`, `src/app/(app)/purchase-orders/[id]/page.tsx`, navigation |
| Seed: *Printer supplies for Operations* (418.00), ordered directly and issued by Dewi; Agus has received 8 of 12 boxes of paper | `scripts/seed.ts` |

### Commands run (exact) and results

One full run of `scratchpad/verify8/run.sh` from `npm ci` (2026-10-27), with `NEXT_TELEMETRY_DISABLED=1`, after the mutation checks; before it, each new test file ran on its own while it was written, and the whole suite and the E2E suite once.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run db:local -- start` | 0 | the local PostgreSQL was not running (the machine had restarted); started before the first integration run |
| `npx drizzle-kit generate --name goods_receipts` | 0 | `0018`: 2 tables, CHECKs, FKs, the unique reversal reference, indexes. Reviewed; additive only |
| `npx drizzle-kit generate --custom --name goods_receipts_guards_and_grants` | 0 | `0019`: grants, 2 functions, 2 guard triggers, 1 deferred constraint trigger, and 3 purchase-order functions replaced (hand-written; the replaced bodies were copied from `0017` by a script that applied each change exactly once) |
| `git diff --stat HEAD -- package.json package-lock.json` | 0 | empty: **no dependency changes** |
| `npm ci` | 0 | 597 packages from the lockfile |
| `npm run db:migrate` | 0 | 0018 and 0019 applied to the development database |
| `npm run lint` | 0 | no findings |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 18 files, **705 passed** (was 682: 22 goods-receipt domain cases, 1 purchase-order case) |
| `npm run test:integration` | 0 | 27 files, **367 passed** (was 329: 26 goods-receipt tests, 4 races, 8 matrix operations; the purchase-order tests now post real receipts) |
| `npx vitest run --coverage` | 0 | **1072 passed**; domain/application scope **1873/1884 lines (99.42 %)**; the receiving domain, input, locks, commands, and queries at 100 % of lines; `purchasing/application/receiving.ts` 89.3 % (lines 142–143 and 146: the C2 refusal after the line check under the order's lock passed, reached only by mutation M5, and a reversal that finds less received than it takes back) |
| `rm -rf .next && npm run build` | 0 | **0 warnings**; new routes `/goods-receipts`, `/goods-receipts/new`, `/goods-receipts/[id]` |
| `npx playwright test` (twice, back to back) | 0 / 0 | **42 passed** both times (41 earlier + 1 new) |
| `npm audit --omit=dev --audit-level=high` | 0 | nothing at high or above in production dependencies |
| `npm audit` | 1 | the same **4 moderate** findings as in Phase 7 (esbuild through drizzle-kit, development only); no high or critical; no change |
| `node scratchpad/worktree-secret-scan.mjs` | 0 | 18 secrets × 397 committable files, **0 hits** |
| `node scratchpad/doc-links.mjs` | 0 | 57 relative links in 36 files, **0 broken** |
| `npm run seed` (development database) | 1, 0, 0 | the first run refused the demo order with `RFQ_REQUIRED` (see Failures); after the fix one run created the requisition, the order, and the receipt, and the next created nothing (idempotent) |
| `node scratchpad/mut/run8.mjs` | 0 | **24 of 26 killed** on the first run; M25 and M26 survived, two cases were added, and `run8.mjs M25` / `M26` then killed them (table below); every mutated file's checksum matched the original afterwards |

### Acceptance criteria

| ID | Result | Evidence |
| --- | --- | --- |
| P8-AC1 state machine | **PASS** | All 18 (kind, status, command) triples against a table written out by hand; cancelled receipts and posted reversals accept nothing; which order statuses take receipts and reversals; PO-T06 at its edges (`tests/unit/goods-receipt-domain.test.ts`, `purchase-order-domain.test.ts`) |
| P8-AC2 record | **PASS** | A draft numbered `GR-YYYY-NNNNNN`, nothing received, the order's status and version unchanged, the delivery note trimmed, blank notes stored as none, audit with the lines; an approved, cancelled, or unknown order `NOT_FOUND`; a closed or received order `PO_NOT_RECEIVABLE` (with its message); SOD-04 `ORDER_RECEIVE_CONFLICT` in the app and `PFG01` in the database; another order's line and a line twice as field errors; tomorrow and the day before the issue day refused on `receivedOn`; 15 malformed or server-only inputs `VALIDATION_FAILED` with nothing written; `OVER_RECEIPT` at 11.001 / 4.401 naming both lines with 11 and 4.4, exactly 11 / 4.4 accepted; a blocked supplier's issued order receives and reverses; idempotent replay and `IDEMPOTENCY_KEY_REUSED`; six other roles `FORBIDDEN` |
| P8-AC3 post | **PASS** | Posting adds every line, the order becomes partially received then received, its version changes (also when the status stays: a buyer's older close is `CONFLICT`), audits on the receipt and on the order; a receipt that would take one line over is refused whole and names it; one that would take two lines over names both; the receivable quantity exactly is fine, 0.001 more is refused at create and at posting; not a posted or cancelled receipt; stale version `CONFLICT`; SOD-04; an order closed in between `PO_NOT_RECEIVABLE`, the draft can then only be cancelled; four other roles `FORBIDDEN`. The CHECK refuses 12 received against 11 receivable as the app role when a matching posted receipt lets every guard pass (`23514`) |
| P8-AC4 cancel a draft | **PASS** | Its creator cancels with a trimmed reason or none, audited; another receiver or a buyer `FORBIDDEN`; stale version `CONFLICT`; a 501-character reason refused; twice, or a posted receipt, `INVALID_TRANSITION` |
| P8-AC5 reverse | **PASS** | A posted reversal with the receipt's lines, dated today, with the reason; the quantities back; the order from received to partially received, then to issued with the second reversal; the receipt's row unchanged byte for byte; audits on the reversal, the receipt, and the order; `ALREADY_REVERSED` naming the reversal; a reversal, a draft, or a cancelled receipt `INVALID_TRANSITION`; four bad reasons refused; stale version; SOD-04; another receiver may; `PO_CLOSED` on a closed order |
| P8-AC6 the order follows | **PASS** | Cancelling with goods received `RECEIPTS_EXIST`, and after everything was reversed the order is issued and can be cancelled, releasing all; short-closing releases 7.5 of 10 after 2.5 received; an over-received order (11 of 10) closes without a reason and keeps 10 ordered; `receive` on `po.get` for a receiver who did not create the order, while it takes receipts; GR-I1, PO-T06, and PO-I1 checked after every test (`afterEach`) |
| P8-AC7 access | **PASS** | Procurement, receivers, finance, and the auditor list and read every receipt; requester, approver, and admin `FORBIDDEN`; filters by kind, status, number, cursor; bad input refused; allowlisted fields (summary, detail, order, lines, form options, receivable orders); the caller's actions per role; `po.receivable` lists issued and partially received orders with open lines and SOD-04 marked; `receipt.formOptions` with what each line can still take, `NOT_FOUND` for an unissued order; 8 new operations in the matrix (68 in all) |
| P8-AC8 database guards | **PASS** | As the app role and the owner: a received quantity without a document and a status the lines do not give `PFC01` (also where the status would not change); a posted receipt whose quantities did not move `PFG01` at commit; quantities moved without the order's status `PFC01` at commit; no deletes (`42501` / `PFG01`), no line updates (`42501`); 10 kinds of change to drafts, posted, and cancelled receipts or their lines `PFG01`; inserts as posted, for an unissued, closed, or received order, before the issue day, or by the order's creator `PFG01`; posting by the order's creator, without lines, on a closed order, or on a received order (within the tolerance, with the quantity moved to match) `PFG01`; reversals of a draft, with different lines (also with quantities and status moved to match), or left as a draft `PFG01`; a second reversal `23505` |
| P8-AC9 races | **PASS** | 4 races × 20 forced overlaps (`tests/concurrency/goods-receipts.test.ts`): CC-04 two of five postings succeed, three `OVER_RECEIPT`, 2.000 received; two reversals: one succeeds, one `ALREADY_REVERSED`, one reversal row; posting vs short-close and posting vs cancellation: one wins, the other `CONFLICT` or `PO_NOT_RECEIVABLE`, PO-I1 and GR-I1 hold |
| P8-AC10 E2E | **PASS** | `tests/e2e/goods-receipts.spec.ts`: Rina's requisition is approved by whoever holds the step, Dewi orders it directly and issues it and is not offered receiving (the form is "Access denied" for her); Agus finds the order under **Receiving**, 11 of 10 is refused with the typed values kept, 6 are recorded and posted (partially received), the remaining 4 from the order page (received, no more **Receive goods**), and the last receipt is reversed with a reason (partially received again); finance and the auditor read receipts and the reversal without actions; Rina has no **Receiving**; one h1 and only labeled controls; no CSP violations |
| P8-AC11 definition of done | **PASS**, except `gitleaks`, `actionlint`, and CI (**BLOCKED**) | the tables above |

### Mutation checks

Each change was applied alone (two changed two places), the named tests ran, and the files were restored (checked by content after each, and by checksum after the run).

| ID | Mutation | Result |
| --- | --- | --- |
| M1 | recording does not check SOD-04 | killed (the trigger stops it as `INTERNAL`, not `ORDER_RECEIVE_CONFLICT`) |
| M2 | posting does not check SOD-04 | killed |
| M3 | reversing does not check SOD-04 | killed |
| M4 | recording does not check `OVER_RECEIPT` | killed |
| M5 | posting does not check every line first | killed (C2 still refuses, but names only the first line) |
| M6 | no line check and no C2 condition: only the CHECK is left | killed (`INTEGRITY_CONSTRAINT` instead of `OVER_RECEIPT`, also in CC-04) |
| M7 | posting and reversing read the order without locking it | killed (three races) |
| M8 | a posting does not re-derive the order's status | killed (the commit-time PO-T06 check) |
| M9 | a posting that keeps the status does not change the order's version | killed |
| M10 | PO-T06 counts an order received only when over-received | killed (unit and integration) |
| M11 | no `ALREADY_REVERSED` check (only the unique index) | killed (also in the race) |
| M12 | a receipt of a closed order can be reversed | killed |
| M13 | a reversal does not take the quantities back | killed (GR-I1) |
| M14 | anyone with `receipt.create` cancels a draft | killed |
| M15 | posting does not check that the order still takes receipts | killed |
| M16 | goods can be received in the future | killed |
| M17 | goods can be received before the order was issued | killed |
| M18 | `po.get` offers `receive` to the order's creator | killed |
| M19 | `po.receivable` also lists received orders | killed |
| M20 | the database lets an issued line take any received quantity | killed |
| M21 | the database does not check GR-I1 at commit | killed |
| M22 | the database does not check PO-T06 at commit | killed |
| M23 | the database lets a reversal differ from its receipt | killed |
| M24 | the database lets the order's creator record a receipt | killed |
| M25 | the database lets a receipt be recorded for any order | **survived the first run**, killed after adding a case (see Failures) |
| M26 | the database lets a receipt be posted when the order no longer takes receipts | **survived the first run**, killed after adding a case (see Failures) |

### Failures and fixes during the phase

1. **`RECEIPTS_EXIST` had become unreachable** (found by a new test): with real receipts an order with anything received is `partially_received` or `received`, and the state table answers `INVALID_TRANSITION` to cancelling it before the receipts check ran. The command now checks for receipts first. The Phase 7 test that faked a receipt while leaving the order `issued` had hidden this.
2. **CC-04 tested the wrong refusal at first:** with a one-line order of 2, the order is received after two postings, so the other three got `PO_NOT_RECEIVABLE` (correct behavior). The race order now has a second line nobody receives, so the three are refused as `OVER_RECEIPT`.
3. **Wrong expectation in my tests (no code change):** inserting a receipt as `posted` is refused by the guard trigger (`PFG01`) before the CHECK runs (`23514` expected).
4. **The seed's demo requisition was above the RFQ threshold:** the first run created and approved *Printer paper for Operations* (740.00), then `po.create` refused it with `RFQ_REQUIRED` (the seed sets the threshold to 500), which stopped the run. The demo is now *Printer supplies for Operations* (418.00). The development database keeps the approved 740.00 requisition from that run (PR-2026-000006), which can be ordered through an RFQ; the refused order wrote nothing.
5. **Tests added for the mutation checks before running them**, so each guard is the only thing that can refuse its case: a receipt over on two lines at posting; a received quantity changed without a document where the status would not change; a reversal with different lines whose quantities and status were moved to match.
6. **M25 and M26 survived:** for an order that was never issued, the "on or after the issue day" check refused the insert first, and posting on a closed order is also refused at commit by GR-I1. A case now records a draft for a closed and a received order, and posts an older draft on a received order with the quantity moved to match (within the tolerance, where only the posting check applies); both are killed.
7. **Tooling:** two shell commands with nested quotes failed before running (bash syntax errors); the changes went through patch scripts instead. The shell's working directory twice reset to another folder; every command used absolute paths, and nothing was written there.

### Files changed

- New: `src/modules/receiving/**` (domain, application, infrastructure, index); `src/modules/purchasing/application/receiving.ts`, `src/modules/purchasing/tables.ts`; `src/app/(app)/goods-receipts/**` (list, new, detail, actions, form, action forms, status); `db/migrations/0018_goods_receipts.sql`, `0019_goods_receipts_guards_and_grants.sql` and their snapshots; `tests/unit/goods-receipt-domain.test.ts`, `tests/integration/goods-receipts.test.ts`, `tests/concurrency/goods-receipts.test.ts`, `tests/e2e/goods-receipts.spec.ts`; this report.
- Changed: purchasing domain (receiving statuses), commands (`RECEIPTS_EXIST` first), input (audit field), queries (`po.receivable`, `receive`), repository (C2 on received quantities, lists for receiving), schema comments, index; `src/server/schema.ts`; screens: navigation, purchase-order page (received column, its receipts, **Receive goods**); `scripts/seed.ts`; migration journal; tests `purchase-orders` (real receipts instead of the helper), `permission-matrix`, `unit/purchase-order-domain`; docs `PLAN`, `state-machines`, `schema`, `api-contracts`, `architecture`, `threat-model`, `user-stories`, `development`, ADR 0006, ADR 0008, ADR index, `README`.

### Dependency changes

None.

### Known limitations / not verified

- **Drafts are not edited** (decision 1), and a receipt is reversed whole: to correct part of a delivery, reverse it and record it again.
- Drafts of an order that was closed or cancelled stay until their creator cancels them (decision 4).
- ProcureFlow records what the receiver says arrived; there is no inspection, rejected quantity, or returns-to-supplier flow in v1.
- "Not received in the future" is checked by the application only (it depends on its clock); the database checks "not before the issue day".
- The races where either side may win (posting vs close, posting vs cancel) require at least one order to occur; which orders occurred in the 20 iterations was not recorded.
- The development database has one extra approved demo requisition from the first seed run (Failures, 4).
- `gitleaks` and `actionlint` are not installed here, and CI has not run (no remote).
- **Not verified:** a person looking at the new screens (the E2E tests check text, roles, labels, status codes, and behavior, not layout); browsers other than Microsoft Edge; screen readers.

### Threat-model updates

`docs/threat-model.md` "Phase 8 status": AB-08 and AB-09 marked verified; T-01, T-02, I-01, E-01, R-01 for goods receipts; residual risks (what a receiver says is recorded, not checked; a colluding receiver; drafts of closed orders).

### Next steps

- Done (2026-10-27): the maintainer asked to commit Phase 8 as one commit, without pushing.
- Maintainer review of the choices made inside the plan (above); any change is a follow-up commit.
- Phase 9: audit trail UI and reporting (the received-basis spend report uses the reversal dates decided here).
