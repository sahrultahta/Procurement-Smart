## Phase 9 report: audit trail UI and reporting

- Date: 2026-10-28
- Base commit: `8f898ba` (Phase 8). Phase 9 is committed as a single commit on top of it (2026-10-28, after maintainer approval), together with this report. Not pushed: there is no remote.
- Machine: Windows 10 Enterprise 19045, Node 24.21.0, npm 11.19.0, local PostgreSQL 18.6, Microsoft Edge (Playwright `msedge` channel)
- Maintainer instructions (2026-10-27): "Kita lanjut ke phase selanjutnya ya ?" — inspect and plan; (2026-10-28) "Lanjutkan coba ke phase 9", taken as approval of the plan and its decisions 1 to 9 as presented. No file changed before that. Standing instruction: no commit without the maintainer's permission.

Status vocabulary: **Implemented**, **Tested**, **Verified** (run here, output observed). Nothing is **Deployed**.

### Plan and acceptance criteria

Phase 9 delivers PLAN.md P9-AC1 to AC6. They are broken down as follows (each row says which PLAN criterion it covers).

| ID | Acceptance criterion | Covers | Verified by |
| --- | --- | --- | --- |
| P9-AC1 | Audit search for `audit.read` only: filters by record type and id, person, action, org date range; cursor paging newest first without gaps or repeats; before/after per field, reason, request id, IP, user agent | P9-AC1 | integration + E2E |
| P9-AC2 | Document history on requisition, RFQ (with its quotations), PO, goods receipt, and supplier pages, inside each get query: visible to whoever can read the document, `NOT_FOUND` otherwise; no request id, IP, or user agent | P9-AC1 | integration + E2E |
| P9-AC3 | Spend by supplier and by department, issued and received basis, match hand-computed fixtures exactly (string-equal decimals), org time zone dates | P9-AC2 | integration |
| P9-AC4 | Requisition cycle time (median, p90, count, department filter), approval aging, open purchase orders match hand-computed fixtures | P9-AC2 | integration |
| P9-AC5 | Potential split purchases: finds the split against each threshold, no false positive in the control cases | P9-AC6 | unit + integration + E2E |
| P9-AC6 | `asOf` on every report; empty ranges give empty results and an explicit empty state; a grep test finds no literal metric in report components | P9-AC3, AC4 | unit + integration + E2E |
| P9-AC7 | CSV: formula-injection protection (`=`, `+`, `-`, `@`, TAB, CR), quoting, BOM, the report's permission and parameters | P9-AC5 | unit + integration + E2E |
| P9-AC8 | Access: the operation matrix with the new operations; DTO allowlists | P9-AC1, AC5 | integration |
| P9-AC9 | E2E: Sari reads spend and downloads the CSV; Lena searches the audit trail and finds the seeded split; Rina sees her requisition's history and neither menu; report and audit pages have one h1 and labeled controls; no CSP violations | P9-AC1, AC3, AC5, AC6 | E2E |
| P9-AC10 | Definition of done (PLAN.md) and this report | all | commands below |

### Decisions taken within the plan (approved with the plan, 2026-10-28)

1. **Amounts include tax**, computed per line with the order's rounding (ADR 0007).
2. **Issued basis:** an order's full total on the org date it was issued, including orders closed short; cancelled orders never count.
3. **Received basis:** each posted receipt line at the order line's price plus tax, on the receipt's date; a reversal counts negative on its own date (Phase 8 decision 5); received quantities above the ordered quantity count.
4. **Cycle time:** from the first submission to the final approval, for requisitions approved in the range.
5. **Potential split purchases:** orders approved or later (not cancelled), grouped by requisition requester and supplier within `windowDays`; two thresholds from the settings in force: the PO approval threshold against totals with tax, the RFQ threshold against subtotals without tax. The report says which one a group reaches.
6. **Document history is embedded** in each document's get query (like approval history) instead of a separate `audit.entityHistory`; the API contract is updated.
7. **`audit.search` lives in the reporting module**, reading a view of the audit events with the actor's name.
8. **IP address and user agent appear only in audit search.**
9. **CSV:** UTF-8 with BOM, comma separators, `.` decimals without thousands separators, ISO dates.

Choices made while implementing, inside the approved plan (for the maintainer's review):

- **`asOf` is the application clock** at the moment the report is read, not the database `now()` the contract first named, so tests can fix it; the figures come from one read-only transaction at that moment.
- **New query `audit.filterOptions`** (`audit.read`): the record types and the people the audit search can filter by.
- **Amount cells in CSV are written as numbers** when they are plain decimals, a minus sign included (a reversal's `-303.03` is not turned into text); every text cell, and any amount that is not a plain decimal, gets the apostrophe rule. The contract's wording ("cells starting with `-`") applied to all cells would have turned every negative amount into text.
- **Split windows:** a window starts at an order and takes the orders approved up to `windowDays` later. A window that reaches the threshold is reported and the next one starts after it; otherwise the next window starts at the following order. Orders from an RFQ award are left out of the RFQ check (they went through an RFQ), not out of the approval check. Each threshold is skipped when it is not set.
- **What a document's history holds:** its own events; for an RFQ also its quotations' events. Approval decisions stay in the approval history card. At most the 500 oldest events.
- **Ranges** are inclusive org dates, at most 3,660 days; the screens default to 1 January of the current year until today.
- **CSV layout:** the open-orders file has one row per order line, the split file one row per order of a group; every file ends with an `As of` column.
- **Totals are grouped per currency**, though one installation has one currency (it locks with the first requisition).

### What Phase 9 adds (all implemented, tested, verified locally)

| Area | Where |
| --- | --- |
| Views `report_org_settings`, `report_audit_events`, `report_users`, `report_spend_issued`, `report_spend_received`, `report_requisition_cycle`, `report_pending_approval_steps`, `report_open_order_lines`, `report_split_candidates`; SELECT for the app role | `db/migrations/0020_reporting_views.sql` (hand-written) |
| Reporting module: view reads; audit search and its filter options; the six reports; CSV export; CSV writer, percentile, split grouping | `src/modules/reporting/**` |
| Document history (`findEntityHistory`, oldest first, names through the caller's lookup) and its read by entity | `src/modules/audit/application/entity-history.ts`, `src/modules/audit/infrastructure/audit-repository.ts` |
| `history` on `requisition.get`, `rfq.get`, `po.get`, `receipt.get`, `supplier.get` | the five query files |
| Screens: **Audit** (filters, events with expandable details), **Reports** (index and six report pages with filters, `asOf`, empty states, **Download CSV**), `GET /reports/export/<report>`, a **History** card on five detail pages, navigation, home page text | `src/app/(app)/audit/**`, `src/app/(app)/reports/**`, `src/app/(app)/_components/document-history.tsx`, the five detail pages, `layout.tsx`, `page.tsx` |
| Seed: *Toner cartridges for Operations* (195.00 before tax), a second small order from the same supplier for Rina, approved: with *Printer supplies* (418.00) it is the split-purchase demo | `scripts/seed.ts` |

### Commands run (exact) and results

One full run of `scratchpad/verify9/run.sh` from `npm ci` (2026-10-28), with `NEXT_TELEMETRY_DISABLED=1`, after the mutation checks; before it, each new test file ran on its own while it was written, and the whole suite and the E2E suite once.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run db:local -- start` | 0 | the local PostgreSQL was not running; started before the first migration |
| `npx drizzle-kit generate --custom --name=reporting_views` | 0 | `0020`: 9 views and their SELECT grant (hand-written; no table changes) |
| `git diff --stat HEAD -- package.json package-lock.json` | 0 | empty: **no dependency changes** |
| `npm ci` | 0 | 597 packages from the lockfile |
| `npm run db:migrate` | 0 | 0020 applied to the development database |
| `npm run lint` | 0 | no findings (the first draft used `sql.raw` for view and column names; the ADR 0004 lint rule refused it, and static `sql` fragments replaced it) |
| `npm run typecheck` | 0 | no errors |
| `npm run test:unit` | 0 | 19 files, **729 passed** (was 705: 24 reporting cases) |
| `npm run test:integration` | 0 | 28 files, **400 passed** (was 367: 24 report and audit tests, 9 matrix operations; the RFQ award test also checks the history) |
| `npx vitest run --coverage` | 0 | **1129 passed**; domain/application scope **2120/2131 lines (99.48 %)**; every reporting domain and application file and `entity-history.ts` at 100 % of lines; `report-views.ts` (infrastructure, outside the scope) 88.9 % |
| `rm -rf .next && npm run build` | 0 | **0 warnings**; new routes `/audit`, `/reports`, six report pages, `/reports/export/[report]` |
| `npx playwright test` (twice, back to back) | 0 / 0 | **46 passed** both times (42 earlier + 4 new) |
| `npm run seed` (development database) | 0, 0 | the first run created the toner requisition and its order (approved on submit); the run in the verification created nothing (idempotent) |
| `npm audit --omit=dev --audit-level=high` | 0 | nothing at high or above; it lists the same 4 moderate findings as `npm audit` |
| `npm audit` | 1 | the same **4 moderate** findings as in Phases 7 and 8 (esbuild through drizzle-kit, development only); no high or critical; no change |
| `node scratchpad/worktree-secret-scan.mjs` | 0 | 18 secrets × 425 committable files, **0 hits** |
| `node scratchpad/doc-links.mjs` | 0 | 59 relative links in 37 files, **0 broken** |
| `node scratchpad/mut/run9.mjs` | 0 | **36 of 38 killed** on the first run; M16 and M17 survived, the tests were strengthened, and `run9.mjs M16` / `M17` then killed them (table below); every file's checksum matched the original after the run |

### Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| P9-AC1 audit search | **PASS** | By record (an order's three events newest first, with Dewi's name and roles, the IP address and user agent she issued from, a request id, and `status: approved → issued`); by person (only Agus's events); by action (`receipt.reversed` with its reason); by org date (`from` and `to` inclusive, a 2025 range empty); paging by 4 equals the full list, no gaps or repeats; 7 bad filters `VALIDATION_FAILED`; filter options list people and record types; requester, approver, procurement, receiver, and finance `FORBIDDEN`; allowlisted fields. E2E: Lena filters by type and action, opens an event's details (IP address, user agent), and sees the empty message |
| P9-AC2 document history | **PASS** | Requisition (created, submitted, returned, submitted, approved, oldest first, names), order (no IP or user agent in it), goods receipt (with the reversal's reason), supplier, RFQ (its own and its quotations' events, in order, all of the quotations' events); allowlisted fields; Tia gets `NOT_FOUND` for Rina's requisition, Rina `FORBIDDEN` for a receipt. E2E: Rina sees her requisition's history without IP |
| P9-AC3 spend | **PASS** | Issued by supplier 856.05 (2 orders) and 330.94 (2: a short-closed order at its full total), total 1186.99, the cancelled order nowhere; March only 856.05 (an order issued 18:30 UTC on 31 March is 1 April in Jakarta, and shows on 1 April); by department 1076.05 and 110.94. Received by supplier 592.56 and 165.94 (total 758.50), by department 647.56 and 110.94, the reversal alone −303.03 on 5 April, 1–4 April 303.03 and 110.94; the view's rows for one order 37.00, 202.02, 303.03, −303.03, 353.54 (35.035 → 35.04); a draft and a cancelled receipt in the range count nowhere |
| P9-AC4 cycle, aging, open orders | **PASS** | March: 6 requisitions, median 21.00 h, p90 41.00 h (a returned requisition counted from round 1: 34 h); Operations 30.00 / 33.20; Administration 5.33 / 39.47; February 12.50 / 21.70. Aging at 10 April 12:00 UTC: 9 and 2 whole days, `olderThanDays` 3 leaves one, 10 none. Open orders: a partly received order with an over-received line (outstanding 0, 0.00) and 2 cables (74.00), an issued order (240.00), total 314.00; the supplier filter; allowlisted fields |
| P9-AC5 split purchases | **PASS** | Rina's three orders from one supplier reach the approval threshold (616.05 + 240.00 + 333.00 = 1189.05 ≥ 1000) and two of them the RFQ threshold (subtotals 240.00 + 300.00 = 540.00 ≥ 500; the third, 555.00, is not below it); controls never appear (another requester, another supplier, a cancelled order that with a 99.95 order would reach 500); 5-day and 10-day windows; an unset threshold is skipped. Unit: the edges (at the threshold, a lone order, requesters, suppliers, currencies apart, RFQ-awarded orders, sliding windows). E2E: Lena finds the seeded pair |
| P9-AC6 asOf, empty, no literals | **PASS** | Every report's `asOf` is the runner's clock (fixed at 10 April 12:00 UTC, and within a minute of now without it); a 2020 range gives empty rows, totals, groups, and `null` median and p90; E2E: the spend page shows the empty-state text and no table; a unit test scans the report components for decimals, currency amounts, percentages, and thousands separators: none |
| P9-AC7 CSV | **PASS** | Unit: each of `=`, `+`, `-`, `@`, TAB, CR gets the apostrophe; quoting of commas, quotes, line breaks; amount cells only as plain decimals (`1e5`, `-1+1`, `=1` become safe text); BOM and CRLF; headers protected. Integration: the spend CSV exactly, `-303.03` as a number, `'=2+3 desk lamps` in the open-orders file, every report exports, an empty one is the header only; unknown report, extra or bad parameters, bad numbers `VALIDATION_FAILED`. E2E: Sari downloads the file (name, BOM, header, a row); Rina gets 403 |
| P9-AC8 access | **PASS** | Reports and the export for procurement, finance, and the auditor only; audit search and options for the auditor and admin only; the operation matrix with 9 new operations (77 in all); allowlisted fields for every report, row, group, event, and history entry |
| P9-AC9 E2E | **PASS** | `tests/e2e/reports.spec.ts` (4 tests): Sari's spend, CSV, empty state, the other four reports, no **Audit** menu; Lena's audit search and the seeded split; one h1 and only labeled controls on all eight new pages; Rina's history, no menus, "Access denied" pages, 403 on export; no CSP violations |
| P9-AC10 definition of done | **PASS**, except `gitleaks`, `actionlint`, and CI (**BLOCKED**) | the tables above |

### Mutation checks

Each change was applied alone (one changed two places), the named tests ran, and the files were restored (checked by content after each, and by checksum after the run).

| ID | Mutation | Result |
| --- | --- | --- |
| M1 | CSV text is not neutralized | killed |
| M2 | CSV amount cells are not checked | killed |
| M3 | CSV without the byte-order mark | killed |
| M4 | an order exactly at the threshold counts in a split | killed |
| M5 | a split must exceed the threshold, not reach it | killed |
| M6 | RFQ-awarded orders count against the RFQ threshold | killed |
| M7 | the split window is one day longer | killed |
| M8 | a short window is skipped instead of sliding | killed |
| M9 | splits mix requesters | killed |
| M10 | percentile without interpolation | killed |
| M11 | hours rounded down | killed |
| M12 | a reversal counts positive in received spend | killed |
| M13 | issued spend counts cancelled orders | killed |
| M14 | issued spend dated in UTC | killed |
| M15 | received spend: tax not rounded per line | killed |
| M16 | received spend: line value not rounded | **survived the first run**, killed after adding a check (see Failures) |
| M17 | received spend counts drafts and cancelled receipts | **survived the first run**, killed after adding a case (see Failures) |
| M18 | cycle time from the latest round | killed |
| M19 | open orders: over-received lines go negative | killed |
| M20 | open orders leave out partly received orders | killed |
| M21 | split candidates include cancelled orders | killed |
| M22 | aging ignores `olderThanDays` | killed |
| M23 | aging rounds days up | killed |
| M24 | the spend range's last day left out | killed |
| M25 | cycle-time department filter ignored | killed |
| M26 | open-orders supplier filter ignored | killed |
| M27 | audit search ignores the person filter | killed |
| M28 | audit search `to` date exclusive | killed |
| M29 | audit search cursor repeats an event | killed |
| M30 | audit search oldest first | killed |
| M31 | audit search open to `report.view` | killed |
| M32 | export open to requesters | killed |
| M33 | export does not convert number parameters | killed |
| M34 | a range ending before it starts accepted | killed |
| M35 | document history newest first | killed |
| M36 | RFQ history without its quotations | killed |
| M37 | the split report ignores the RFQ threshold setting | killed |
| M38 | spend totals not summed | killed |

### Failures and fixes during the phase

1. **`sql.raw` refused by lint:** the first version chose the view and column names for spend with `sql.raw`; the ADR 0004 rule rejects it. They are now static `sql` fragments (no input reaches them either way).
2. **Wrong guesses in my tests (no code change):** the supplier review is audited as `supplier.reviewed`, not `supplier.approved`; an award records the quotations before `rfq.awarded`, not after.
3. **Three earlier E2E tests failed** after the History card was added, because a text locator now matched two places (the card repeats the reason, the requisition number, and a reviewer's name). Each locator now names the element it meant (an exact text, the number's span, the review line); what they check is unchanged.
4. **M16 and M17 survived:** the report rounds its totals at the end, which hid a line value that was not rounded, and the fixture had no draft or cancelled receipt in the range. The test now reads the view's rows for one order (each at the currency scale) and the fixture has a draft and a cancelled receipt dated inside the range; both are killed. A first version of the new check sorted the text form of the amounts ("202.02" before "37.00") and failed without any mutation; fixed before the kills were counted.
5. **A control case made stronger before the mutation run:** the cancelled order was raised from 300.00 to 450.00, so that with a 99.95 order of the same requester and supplier it would reach the RFQ threshold if cancelled orders counted (M21 is killed by it); the audit date filter is also tested with `from` and `to` on the same day.
6. **Tooling:** two shell commands with nested quotes failed before running, and one `sed` dropped a backslash from a test regex (caught by reading the result); the changes went through patch scripts or the editor instead. Every command used absolute paths; nothing was written outside the project and the scratchpad.

### Files changed

- New: `src/modules/reporting/**`; `src/modules/audit/application/entity-history.ts`; `src/app/(app)/audit/page.tsx`, `src/app/(app)/reports/**`, `src/app/(app)/_components/document-history.tsx`; `db/migrations/0020_reporting_views.sql` and its snapshot; `tests/unit/reporting.test.ts`, `tests/integration/reports.test.ts`, `tests/e2e/reports.spec.ts`; this report.
- Changed: `src/modules/audit/{index.ts,infrastructure/audit-repository.ts}`; the get queries of requisitions, sourcing (RFQs), purchasing, receiving, and suppliers; the five detail pages; `src/app/(app)/layout.tsx`, `src/app/(app)/page.tsx`; `scripts/seed.ts`; migration journal; tests `permission-matrix` (9 operations), `quotations` (RFQ history), and three E2E specs whose text locators now also matched the history card (`quotations`, `requisitions`, `suppliers`); docs `PLAN`, `api-contracts`, `architecture`, `schema`, `threat-model`, `user-stories`, ADR 0009, `README`.

### Dependency changes

None.

### Known limitations / not verified

- Reports are computed when opened, with no caching; on a large installation they are bounded only by the 15-second statement timeout and the 10-year range cap. No index was added for them.
- Audit search matches an action exactly (no prefix search) and pages 50 events at a time; there is no CSV export of the audit trail (Phase 10 has the optional hash-chained export).
- Split detection finds orders of one requester and supplier; a split across requesters or suppliers, or wider than the window, is not found. Requisitions are not grouped: only orders carry a supplier.
- Exports are not audited; anyone with `report.view` can export what they can see.
- Time-shifted fixtures: the integration tests move timestamps back with the guard triggers off for one transaction (as the owner); the commands that made the rows ran normally.
- `gitleaks` and `actionlint` are not installed here, and CI has not run (no remote).
- **Not verified:** a person looking at the new screens (the E2E tests check text, roles, labels, status codes, downloads, and behavior, not layout); browsers other than Microsoft Edge; screen readers; opening the CSV in a spreadsheet program.

### Threat-model updates

`docs/threat-model.md` "Phase 9 status": T-06 and AB-10 marked verified; E-03, I-01 (history), I-02 (reports), E-01, R-01; residual risks (no limits on report load, exports not audited, split detection's scope).

### Next steps

- Done (2026-10-28): the maintainer asked to commit Phase 9 as one commit, without pushing.
- Maintainer review of the choices made inside the plan (above); any change is a follow-up commit.
- Phase 10: hardening, deployment documentation, release v0.1.0.
