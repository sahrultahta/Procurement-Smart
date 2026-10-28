# ADR 0009: Append-only audit trail enforced by the database

- Status: Accepted
- Date: 2026-10-18

## Context

Auditors need to answer "who did what, when, and what changed?" for every procurement decision. If the application can edit or delete audit rows, so can an attacker who compromises it.

## Decision

### Table

`audit_events` (full columns in `docs/schema.md`): identity `bigint` id, `occurred_at timestamptz DEFAULT now()` (database clock, not app clock), actor user id plus actor role snapshot, `action` (e.g. `requisition.submitted`), `entity_type`, `entity_id`, `changes jsonb` (field → `[before, after]`, secrets redacted), optional `reason`, `request_id`, `ip`, `user_agent`.

### Rules

1. **Same transaction.** Audit rows are inserted inside the transaction that makes the change. If the change rolls back, so does its audit row. A committed change always has its audit row.
2. **Append-only at the database level:**
   - The runtime role `procureflow_app` has `INSERT, SELECT` on `audit_events` and its identity sequence, and nothing else.
   - A `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE` statement trigger raise an exception for **every** role, including the owner. Removing them requires DDL, which the app role cannot run.
3. **Coverage.** Every command that changes state writes at least one audit event. Login success, login failure, logout, password change, role grant and revoke, user deactivation, settings changes, and approval-policy changes are all audited.
4. **Redaction.** Password hashes, session tokens, and secrets never enter `changes`. Each module declares a per-entity allowlist of audited fields.
5. **Reading.** Only `audit.read` (auditor, admin) can read audit events. Entity history views show events for documents the actor can already see. *(Implemented in Phase 9: audit search for `audit.read`; each document's get query embeds its own history, without request id, IP address, or user agent.)*
6. **Access-denied events** go to the structured server log, not `audit_events`. That keeps an unauthenticated flood from amplifying writes to the audit table. Login failures are both rate-limited and audited.

## Limits (stated honestly)

- This protects the audit trail against the **application** and anyone who compromises it. It does **not** protect against a PostgreSQL superuser or the schema owner, who can drop the trigger. Tamper *evidence* (a hash chain, or periodic export to write-once storage) is an optional hardening item in Phase 10.
- Retention and archival are operator procedures, documented in Phase 10. The app never deletes audit rows.

## Alternatives considered

- **Application-only "never update" convention.** Rejected: unenforced.
- **Event sourcing for all aggregates.** Rejected for v1: large complexity cost. State tables plus an append-only audit log meet the requirement.
- **Hash-chained rows from day one.** Deferred: chaining serializes all audit writes (each row needs the previous hash), which adds a global contention point.

## Verification

- Phase 2 integration tests: as `procureflow_app`, `UPDATE`, `DELETE`, and `TRUNCATE` on `audit_events` fail with permission denied. As the owner, the triggers reject the same operations. A failing command leaves no audit row. A succeeding command leaves exactly the expected rows.
- Every later phase: each new command's test asserts its audit event (action, actor, entity, changed fields).
