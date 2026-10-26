# ADR 0008: Transactions and concurrency control

- Status: Accepted. Amended 2026-10-22 (Phase 3b): mechanism C9, the admin-set lock. Phase 5b (2026-10-25): the lock order for approvals (C8) and CC-01, CC-02 implemented. Phase 7 (2026-10-26): C2 on ordered quantities, CC-03, CC-06.
- Date: 2026-10-18

## Context

Races that matter in this domain:

- Two approvers approve the same step at the same moment.
- A requester edits a PR while it is being submitted.
- Two buyers turn the same approved PR line into POs, which over-orders it.
- Two receivers post receipts for the last units of a PO line, which over-receives it.
- Two documents are given the same number.

## Decision

Every command runs inside **one database transaction** at PostgreSQL's default **READ COMMITTED** isolation, with the following explicit mechanisms. SERIALIZABLE is not the default, because it needs blanket retry handling. It may be used per command where a test shows it is needed.

| # | Mechanism | Used for |
| --- | --- | --- |
| C1 | **Aggregate row lock + optimistic version.** Load the aggregate root `FOR UPDATE`. If the client-supplied `expectedVersion` differs from the row's `version`, return `CONFLICT`. Otherwise apply the transition and set `version = version + 1`. | All state transitions and edits on PR, approval request, RFQ, quotation, PO, GR, supplier |
| C2 | **Conditional atomic counter update.** `UPDATE ... SET qty = qty + $d WHERE id = $id AND qty + $d <= limit RETURNING`. Zero rows returned means a business-rule violation. | `pr_lines.ordered_qty` (no over-ordering), `po_lines.received_qty` (no over-receipt) |
| C3 | **Database CHECK constraints as backstop.** `received_qty BETWEEN 0 AND max_receivable_qty`, `ordered_qty BETWEEN 0 AND quantity`. | The same counters, if application code is ever wrong |
| C4 | **Unique indexes.** | One decision per approval step; distinct approvers per round; one live quotation per supplier per RFQ; document numbers; idempotency keys |
| C5 | **Sequence rows.** `UPDATE document_sequences SET last_value = last_value + 1 WHERE doc_type = $t AND year = $y RETURNING last_value`, in the same transaction. The row lock serializes allocation, and committed numbers are gapless. | PR-, RFQ-, PO-, GR- numbers |
| C6 | **Idempotency keys.** Create commands accept an optional `idempotencyKey`. `(user_id, key)` is unique, and a repeat returns the first result. | Double-clicks, retries |
| C7 | **Timeouts.** `SET LOCAL lock_timeout = '5s'` and `statement_timeout = '15s'` per transaction. A lock timeout maps to `CONFLICT` ("try again"). | All commands |
| C8 | **Deadlock avoidance.** Fixed lock order: documents PR → RFQ → PO → GR, then lines by ascending `id`. Retry the whole transaction up to 3 times with jitter on SQLSTATE `40001` / `40P01`, only for commands marked retry-safe. | All multi-row commands |

Domain state transitions are validated **after** acquiring the lock, against the row as it now stands. A stale UI can never push an invalid transition.

## Amendment (2026-10-22, Phase 3b)

Row locks cannot protect an invariant over a **set** of rows that no single row represents. "At least one active admin" (`LAST_ADMIN`, ADR 0006 SOD-05) is such an invariant: admin A revoking B and B revoking A touch different rows, both see two admins under READ COMMITTED, and both commit. `tests/concurrency/admin-set.test.ts` shows exactly this with plain SQL (zero admins left).

| # | Mechanism | Used for |
| --- | --- | --- |
| C9 | **Set lock.** `pg_advisory_xact_lock(<fixed key>)` taken first in the transaction, before any row lock, so it cannot join a deadlock cycle with C1 locks. Held until commit or rollback, bounded by `lock_timeout` (C7). It lives in PostgreSQL, so it holds across app instances. Under the lock, the command re-resolves its own actor (the caller may have been removed since the request started) and then checks the invariant. | Every `admin.user.*` and `admin.role.*` command (key `0x50460001`, `src/modules/identity/infrastructure/admin-repository.ts`) |

This narrows the earlier rejection of advisory locks below: they are not used *instead of* row locks and constraints, only for set-level invariants, and only inside the database.

**CC-08:** two admins remove each other (revoke/revoke, deactivate/deactivate, revoke/deactivate). A third connection holds the set lock until both commands are waiting on it, then releases it. Over 20 iterations exactly one succeeds, the other gets `FORBIDDEN` or `LAST_ADMIN`, and exactly one admin remains. With the lock removed, both succeed on the first iteration (mutation check, Phase 3b report).

## Implemented in Phase 7 (2026-10-26)

- **C8, requisition → purchase order → approval round → requisition lines:** every purchase-order command except issuing locks the requisition row, then the order (the order is read once without a lock to find its requisition). `approval.decide` on a PO does the same through its document port, so a decision and a cancellation of one order queue on the requisition. Requisition lines are updated in ascending id order.
- **C2:** `requisition_lines.ordered_qty` moves only through `UPDATE … SET ordered_qty = ordered_qty + $d WHERE … AND ordered_qty + $d <= quantity` (reserving) and `… - $d … >= 0` (releasing). The command first checks each change against what is left under the requisition's lock, to name every line in `OVER_ORDER`; the conditional update is the guard and the CHECK the backstop (C3). PO-I1 is also checked by the database at commit.
- **C5** allocates `PO-YYYY-NNNNNN` numbers; **C6** makes `po.create` idempotent.
- **Shared lock on the settings:** create, submit, and issue read the settings `FOR SHARE`, because the database compares the rule the order stores with them; a settings change waits until the command ends.

| Test | Assertion |
| --- | --- |
| CC-03 | 5 parallel `po.create` of 1.5 pieces of the same 4-piece requisition line, forced to overlap (a third connection holds the requisition row until all wait), 20 times: exactly two succeed, three get `OVER_ORDER`, the ordered quantity is 3.000 and equals the sum of the order lines. |
| CC-06 | The same idempotency key sent twice at once, forced to overlap, 20 times: both get the same result and one PO exists. |
| Cancel vs reject | `po.cancel` and a rejecting `approval.decide` of the same pending order, forced to overlap, 20 times: one wins (the other gets `CONFLICT` or `INVALID_TRANSITION`), the order and its round end consistent (cancelled and cancelled, or rejected and rejected), and the quantity is released exactly once. |

## Implemented in Phase 6b (2026-10-25)

- **C8, requisition → RFQ → quotations:** `quotation.award` locks the requisition, then the RFQ, then all of the RFQ's quotations in id order. Recording, editing, submitting, and withdrawing a quotation, and closing an RFQ (which discards its drafts), lock the RFQ first and then the quotation(s), so none of them can interleave with an award.
- **C4:** the partial unique index `quotations_one_live_per_supplier` backs "one live quotation per supplier per RFQ"; the RFQ row lock makes concurrent recordings queue up before they reach it.
- **C1 on quotations:** every change bumps the quotation's `version`; the award checks the RFQ's.

| Test | Assertion |
| --- | --- |
| One live quotation per supplier | 5 parallel `quotation.record` for the same supplier and RFQ, forced to overlap (a third connection holds the RFQ row until all wait), 20 times: exactly one succeeds, the others get `SUPPLIER_ALREADY_QUOTED`, one live quotation exists. |
| One award per RFQ | 2 parallel `quotation.award` of different quotations, forced to overlap on the requisition row, 20 times: one succeeds, the other gets `CONFLICT`; exactly one quotation is awarded and the other not awarded. |
| Award vs withdrawal | `quotation.award` and `quotation.withdraw` of the same quotation, forced to overlap on the RFQ row, 20 times: if the award goes first the withdrawal gets `CONFLICT` (the quotation changed); if the withdrawal goes first the award gets `INVALID_TRANSITION`; the RFQ and the quotation always end consistent (awarded and awarded, or closed and withdrawn). |

## Implemented in Phase 6a (2026-10-25)

- **C8, requisition before RFQ:** `rfq.create`, `rfq.update`, and `rfq.issue` lock the requisition row, then the RFQ. Holding the requisition lock while checking "is this line on another RFQ that is not cancelled?" makes concurrent drafts of the same line queue up; the `rfq_lines` trigger repeats the check as a backstop.
- **C5** allocates `RFQ-YYYY-NNNNNN` numbers (year in the org time zone).

| Test | Assertion |
| --- | --- |
| One live RFQ per requisition line | 5 parallel `rfq.create` for the same line, forced to overlap (a third connection holds the requisition row until all wait), 20 times: exactly one succeeds, the others get `LINE_ALREADY_IN_RFQ`, one RFQ line exists, `RFQ-` numbers stay gapless. A mutation check that drops the requisition lock lets the four others reach the trigger (`PFB01`) instead. |

## Implemented in Phase 5b (2026-10-25)

- **C8 lock order for approvals:** the document row first, then its approval request. Submit and withdraw lock the requisition and then open or cancel the round; `approval.decide` reads the request without a lock only to find its document, locks the document through the approvals port, and only then locks the request. A mutation check that makes the decision skip the document lock turns the withdrawal race below into a deadlock (`40P01`), which the test detects.
- **C1 on approval requests:** every decision bumps the request's `version`; the inbox and the decision form carry it.

| Test | Assertion |
| --- | --- |
| CC-01 | 2 to 10 approvers decide step 1 of the same request at once (approve, reject, or return), forced to overlap (a third connection holds the requisition row until all of them wait), 20 times: exactly one succeeds, the others get `INVALID_TRANSITION` or `CONFLICT`, exactly one step has a decider, one `approval.decided` audit row, and request, steps, and requisition agree. |
| CC-02 | An edit and a submit on the same requisition version, forced to overlap, 20 times, alternating who queues first: one succeeds, the other gets `CONFLICT`; after an edit win nothing was submitted, after a submit win the lines and the request's amount equal what was stored before the edit (no lost update). Both outcomes occurred. |
| Withdraw vs last approval | Withdrawal and the final approval forced to overlap, 20 times: one wins; the loser gets the version `CONFLICT` (withdrawal) or "already complete" (approval), never a deadlock; request and requisition end `approved/approved` or `cancelled/cancelled`. |

## Implemented in Phase 5a (2026-10-23)

- **C6 idempotency keys** (`src/shared/db/idempotency.ts`, table `idempotency_keys`): the key row is claimed first in the command's transaction; a concurrent request with the same key waits on the unique index, then returns the stored response, or claims the key if the first transaction rolled back. A sha256 of the canonical input is stored with the key, and the same key with a different input is refused (`IDEMPOTENCY_KEY_REUSED`). Used by `requisition.create`. Keys do not expire yet.
- **C9 set lock, second use:** publishing an approval policy takes an advisory lock per document type, so parallel publishes run one after another (each supersedes the previous version) instead of failing on the "one active" unique index.

| Test | Assertion |
| --- | --- |
| CC-06 (requisitions) | 5 parallel `requisition.create` with one key, 20 times: one requisition each time, the same response for all five, and `PR-` numbers stay gapless. |
| Parallel publish | 5 parallel publishes: all succeed with versions 1 to 5, exactly one active. A mutation check that removes the lock makes this test fail. |
| Currency race | The first requisition racing a currency change, on 10 fresh databases: the requisition's currency always equals the org currency, which is locked afterwards. |

## Verification added in Phase 4 (2026-10-22)

| Test | Assertion |
| --- | --- |
| CC-09 | 5 parallel `supplier.create` with one tax ID (or one name, punctuated differently), 20 times each: exactly one succeeds, the others get `SUPPLIER_DUPLICATE`, and `SUP-` codes stay gapless. The `SUP` sequence row lock (C5) serializes the creates; the partial unique indexes (C4) are the backstop. |
| CC-10 | Approval and identity change on the same supplier version, forced to overlap (a third connection holds the row until both wait), 20 times: exactly one succeeds, the other gets `CONFLICT` (C1), and no supplier is ever active with an unreviewed identity (CHECK `suppliers_active_is_reviewed`). |

## Alternatives considered

- **SERIALIZABLE everywhere.** Simpler to reason about, but every command needs retry logic and contention produces user-visible failures under load.
- **Application-level mutexes or advisory locks only.** These don't survive multiple app instances unless they live in the database. Row locks plus constraints are simpler.
- **Optimistic version only, no row lock.** Works for edits, but counters (C2) need atomic conditional updates regardless.

## Consequences

- Each UI form carries the aggregate's `version`. Conflicts produce a clear "this document changed, reload" message.
- Lock-order discipline must be code-reviewed. The concurrency test suite is the safety net.

## Verification (concurrency suite, `tests/concurrency/`, real PostgreSQL, separate pool connections)

| Test | Assertion |
| --- | --- |
| CC-01 | 2 to 10 approvers decide the same step concurrently. Exactly one succeeds and the others get `CONFLICT` or `INVALID_TRANSITION`. Exactly one decision row exists. |
| CC-02 | Edit and submit race on the same PR. The final state equals some serial order, with no lost update. |
| CC-03 | N parallel PO creations consume the same PR line. `sum(PO qty) <= PR line qty` and `ordered_qty` equals the recomputed sum. |
| CC-04 | N parallel GR postings on the same PO line. `received_qty <= max_receivable_qty` and the counter equals the sum of posted GR lines. |
| CC-05 | 50 parallel document creations get 50 distinct, consecutive numbers. |
| CC-06 | The same idempotency key sent twice in parallel creates one document. |
| CC-07 | Deterministic interleaving: connection A holds the lock (test hook) and B gets `CONFLICT` after `lock_timeout`, with no partial writes. |

Each randomized test runs at least 20 iterations per CI run.
