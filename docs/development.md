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
npm run db:local -- init     # cluster + procureflow_owner role + procureflow_dev database + .env
npm run db:local -- start
npm run db:local -- status
npm run db:local -- stop
```

`init` generates random passwords. The superuser password goes to `.local/superuser-password.txt`, and `DATABASE_URL` and `TEST_DATABASE_URL` go into `.env`. If `.env` already exists, they are written to `.local/db.env` instead and `.env` is left alone.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server (needs `.env`) |
| `npm run lint` | ESLint, including architecture boundary rules |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | Unit tests (no database) |
| `npm test` | Unit + integration tests (needs PostgreSQL running) |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright against `next start` on port 3100 (run `npm run build` first) |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply migrations to `DATABASE_MIGRATION_URL` / `DATABASE_URL` |

Integration tests clone a migrated template database (`pf_template`) once per test file (ADR 0011), so they need a role with `CREATEDB`.

## Telemetry

Next.js collects anonymous telemetry by default. CI disables it with `NEXT_TELEMETRY_DISABLED=1`. To opt out locally, set the same variable in your shell, or run `npx next telemetry disable` (a per-user setting).
