# Changelog

All notable changes to ProcureFlow. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each release links to the phase reports that record what was run and verified.

## [Unreleased]

### Added

- Deployment on Vercel with Neon PostgreSQL: the build skips the standalone server on Vercel, `DATABASE_POOL_MAX` sizes the connection pool, and docs/deployment.md has a "Vercel with Neon" section. A demo with fictional data is live.

### Changed

- The repository is on GitHub (private), and continuous integration has run: the first run was green, as reported by the maintainer. This resolves the CI limitation listed under 0.1.0.

## [0.1.0] - 2026-10-30

The first release: a complete purchase-to-receipt workflow with separation of duties, an append-only audit trail, and reporting. Built in gated phases; every phase report lists the commands run, their results, and what was not verified ([docs/reports/](docs/reports/)).

### Added

- **Sign-in and identity** (Phases 3a, 3b): email and password sign-in with rate limiting, one-time password-setup links, seven roles with permissions defined in code, administration of users, roles, and departments. No admin can change their own account; the last admin cannot be removed.
- **Suppliers** (Phase 4): register, search, maker-checker review, block and unblock, deactivate and reactivate, duplicate detection.
- **Organization settings and approval policies** (Phase 5a): name, time zone, a currency that locks with the first requisition, versioned approval policies with an editor.
- **Requisitions and approvals** (Phases 5a, 5b): requisitions with server-computed totals; multi-step approval routes frozen at submission; an approval inbox; approve, reject, or return; rounds, withdrawal, cancel, close. Nobody approves their own requisition or two steps of a round.
- **RFQs, quotations, and award** (Phases 6a, 6b): RFQs from approved requisitions, quotations per invited supplier, a server-computed comparison, awards with justification rules.
- **Purchase orders** (Phase 7): direct or from an award, tax per line, approval by threshold and price variance, issue, cancel, close, a print view.
- **Goods receipts** (Phase 8): post receipts against issued orders with an over-receipt tolerance; reversals; the order's status follows what was received.
- **Audit trail and reporting** (Phase 9): document history on every document, audit search for auditors and admins, six live reports (spend by supplier and department, cycle time, approval aging, open orders, potential split purchases) with formula-safe CSV export.
- **Operations** (Phase 10): a standalone server build without configuration inside it; `docs/deployment.md` and `docs/operations.md`; hash-chained audit export and verification (`audit:export`, `audit:verify`); per-table checksums for restore checks (`db:checksums`); purging old idempotency keys (`maintenance:purge-idempotency`).

### Security

- Authorization on the server for every operation, checked by a matrix test of 77 operations against every role; strict input validation; database roles with least privilege; database triggers as a second line for separation of duties and document integrity; an audit trail no application role can change.
- Threat model reviewed against the code for this release ([docs/threat-model.md](docs/threat-model.md), [docs/reports/phase-10.md](docs/reports/phase-10.md)).

### Known limitations

- No email: password-setup links are shown to the admin, who passes them on.
- No two-factor authentication and no PostgreSQL row-level security (deferred, see the Phase 10 report).
- English user interface; one currency per installation; no attachments, invoices, or budgets.
- Continuous integration is defined but has never run: the repository has no remote yet.
