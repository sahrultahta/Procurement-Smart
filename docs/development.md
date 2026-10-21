# Local development

## Prerequisites

- Node.js 24 LTS (`.nvmrc`). npm comes with it.
- PostgreSQL 18 server binaries (see below).
- For E2E tests on Windows: Microsoft Edge, used through Playwright's `msedge` channel, so no browser download is needed. Elsewhere, set `PLAYWRIGHT_CHANNEL` or run `npx playwright install chromium`.

`.npmrc` sets `ignore-scripts=true`, so dependency install scripts never run (ADR 0012).

```
npm ci
```

## PostgreSQL 18 (portable, no admin rights, no service)

`scripts/db-local.ts` manages a cluster in `.local/` (gitignored), bound to `127.0.0.1:54318`. **It never downloads anything.** Get the binaries yourself:

1. Download the PostgreSQL 18 **Windows x86-64 binaries** zip from EDB's binaries page: https://www.enterprisedb.com/download-postgresql-binaries
2. Extract it so that `.local/pgsql/bin/pg_ctl.exe` exists. The archive's top folder is `pgsql/`, so extract it into `.local/`.
3. On macOS or Linux, point `PG_BIN` at your PostgreSQL 18 `bin` directory instead.

Then:

```
npm run db:local -- init             # cluster + both roles + procureflow_dev database + .env
npm run db:local -- start
npm run db:migrate                   # as procureflow_owner (DATABASE_MIGRATION_URL)
npm run db:local -- status
npm run db:local -- stop
```

`init` generates random passwords. The superuser password goes to `.local/superuser-password.txt`, and the four connection URLs go into `.env`. It refuses to run if `.env` already exists.

**Database roles (ADR 0013).** `procureflow_owner` owns the schema and runs migrations. `procureflow_app` is the runtime role: it can read and write business tables but cannot run DDL, and it can only INSERT and SELECT `audit_events`. Roles are created outside migrations.

- **Cluster created before Phase 2:** run `npm run db:local -- ensure-app-role` once. It creates `procureflow_app`, backs up `.env` to `.local/env-backup-*.txt`, then points `DATABASE_URL` at the app role and adds `DATABASE_MIGRATION_URL` and `TEST_APP_DATABASE_URL`.
- **Other environments (CI, staging):** `npm run db:app-role`, with `DATABASE_ADMIN_URL` and `APP_DB_PASSWORD` set.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server (needs `.env`) |
| `npm run lint` | ESLint, including architecture boundary rules |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | Unit tests (no database) |
| `npm test` | Unit + integration + concurrency tests (needs PostgreSQL running) |
| `npm run test:coverage` | The same, plus the 85% line-coverage gate on `domain/` and `application/` code |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright against `next start` on port 3100 (run `npm run build` and `npm run db:migrate` first) |
| `npm run db:generate` | Generate a migration from schema changes (review the SQL before committing) |
| `npm run db:migrate` | Apply migrations to `DATABASE_MIGRATION_URL` (falls back to `DATABASE_URL`) |
| `npm run db:app-role` | Create or update `procureflow_app` outside the local cluster |

Integration tests clone a migrated template database (`pf_template`) once per test file (ADR 0011). Setup uses `TEST_DATABASE_URL` (needs `CREATEDB`). Application code under test runs through `TEST_APP_DATABASE_URL`, with the runtime role's real privileges.

Custom SQL (triggers, grants) goes into migrations made with `npx drizzle-kit generate --custom --name=<name>`. Table declarations (`*/infrastructure/schema.ts`, `src/shared/db/tables.ts`) must stay free of `server-only` and I/O, because drizzle-kit loads them directly.

## Telemetry

Next.js collects anonymous telemetry by default. CI disables it with `NEXT_TELEMETRY_DISABLED=1`. To opt out locally, set the same variable in your shell, or run `npx next telemetry disable` (a per-user setting).
