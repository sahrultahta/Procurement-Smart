# ADR 0008: Transactions and concurrency control

- Status: Accepted. Amended 2026-10-22 (Phase 3b): mechanism C9, the admin-set lock.
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
