# ADR 0003: PostgreSQL 18 as the only datastore

- Status: Accepted. The "Database roles" bullet is refined by [ADR 0013](0013-database-role-bootstrap.md): roles are bootstrapped outside migrations.
- Date: 2026-10-18

## Context

The brief mandates PostgreSQL. Verified on 2026-10-18 at postgresql.org/support/versioning: the newest supported major version is **18**, current minor **18.6**, supported until November 2030. PostgreSQL 19 is at RC 1 and not yet released. EDB publishes Windows x86-64 binaries for 18.6.

The development machine (Windows 10) has neither PostgreSQL nor Docker. The author chose portable binaries for local development.

## Decision

- **Target PostgreSQL 18.x** in all environments. CI, local, and documented production use the same major version.
- **Local development:** official EDB PostgreSQL 18 Windows binaries, unpacked into a gitignored `.local/pgsql/` folder. A data directory lives in `.local/pgdata/`, and the server is started and stopped with `pg_ctl` by `scripts/db-local.*`. It binds to `127.0.0.1` only and needs no Windows service and no admin rights. Nothing is downloaded without the author's explicit approval at the time of download, and the checksum is verified where the publisher provides one.
- **CI:** GitHub Actions `services: postgres:18` container.
- **Database roles** (created by migration bootstrap, documented in Phase 2):
  - `procureflow_owner` owns the schema and runs migrations (DDL).
  - `procureflow_app` is the runtime role: DML on business tables, `INSERT`/`SELECT` only on `audit_events`, no DDL.
- Use only built-in PostgreSQL features: `numeric`, `CHECK` constraints, partial unique indexes, triggers, and row locks. No extensions are required for v1. `uuidv7()` is new in PostgreSQL 18; Phase 1 confirms it with a smoke test before the schema depends on it, and falls back to app-generated UUIDv7 if it is missing.

## Alternatives considered

- **PGlite (PostgreSQL compiled to WASM)** for tests. Rejected as the primary test database because it is single-connection, so it cannot exercise real concurrent transactions. It may be used later for fast domain-adjacent tests, never for concurrency tests.
- **Docker Compose.** Rejected for now because Docker isn't installed. The repo can still ship a `compose.yaml` for contributors who have Docker.

## Consequences

- Concurrency tests run against a real multi-connection server both locally and in CI.
- Contributors on macOS or Linux use their own PostgreSQL 18 or the optional compose file. The `DATABASE_URL` contract is the same.

## Verification

- Phase 1: `npm run db:start` launches 18.x locally, and an integration test asserts `server_version_num >= 180000` and that `uuidv7()` works.
