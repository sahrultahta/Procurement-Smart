# ADR 0001: Clean-room repository, separate from any employer code

- Status: Accepted
- Date: 2026-10-18

## Context

ProcureFlow is meant to be open source. The author's other working folder holds an internal General Affairs application. Its source and git history contain organization-specific data: spreadsheet identifiers, a configured PIN, internal division names, and personal names in demo data. If ProcureFlow lived in that repository, or copied code or data from it, publishing ProcureFlow would publish that material.

## Decision

- ProcureFlow lives in its own repository (`Documents/ProcureFlow`) with a fresh git history.
- No code, data, configuration, screenshots, or documents are copied from the internal application or any employer system. General procurement knowledge (what a requisition or a goods receipt is) is public domain knowledge and is fine to use.
- All seed and test data is fictional. Email addresses use the reserved `example.com` / `example.org` domains (RFC 2606). Company names are invented and generic.
- No secrets are committed. `.env*` files are gitignored except `.env.example`, which holds placeholders only.

## Alternatives considered

- **Subfolder of the existing repo.** Rejected: the existing history would ship alongside it.
- **Copy and generalize the internal app's purchase-request module.** Rejected: it is employer code, and it is Google Apps Script, which shares no runtime with the target stack anyway.

## Consequences

- Contributors can audit the whole history safely.
- Domain behavior is specified from scratch in `docs/`, which is extra work up front.

## Verification

- Every phase report includes a secret and confidential-data scan of the diff (Phase 1 adds `gitleaks` to CI and to a local script).
- Seed data review is part of the Phase 3 acceptance criteria.
