# User stories

Personas map to roles in ADR 0006. A person may hold several roles. Story IDs are referenced from `PLAN.md` acceptance criteria and from test names (e.g. `it('US-PR-03 ...')`).

Personas (fictional): **Rina** (requester, Operations), **Bayu** (approver, Operations head), **Sari** (finance), **Dewi** (buyer), **Agus** (receiver, warehouse), **Lena** (auditor), **Tomas** (admin).

## Identity and administration

**US-ID-01 Sign in.** As any user, I sign in with email and password so I can reach my work.
- Given an active account, a correct password lands me on my home page, and the session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- A wrong password shows a generic "invalid email or password" message. No account enumeration.
- After repeated failures from the same client, further attempts are rate-limited (`429`) for a cooling-off period.
- There is no public sign-up page or endpoint. Calls to the sign-up endpoint are rejected.

**US-ID-02 Sign out.** Signing out invalidates the session on the server, so a copied cookie stops working.

**US-ID-03 Deactivation takes effect immediately.** When Tomas deactivates Agus, Agus's next request is rejected (redirect to sign-in or `UNAUTHENTICATED`) and all his sessions are revoked.

**US-AD-01 Create users.** Tomas creates a user with display name, department, and roles, and gets a one-time password-setup link to pass on out of band. The link expires after 24 h and works once.
- If the link is lost or expires before the user sets a password, Tomas issues a new one, and older links stop working. Once the user has set a password, no new link can be issued (`PASSWORD_ALREADY_SET`), so an admin cannot take over an account in use. (Implemented in Phase 3b.)
- Tomas can correct the display name and home department later (`admin.user.update`). The email cannot change.

**US-AD-02 Grant and revoke roles.** Tomas grants or revokes roles (with department scope for approvers and requesters). Every change is audited.
- Tomas cannot change his **own** roles or deactivate himself (`SELF_ADMINISTRATION`).
- The last active admin cannot be removed (`LAST_ADMIN`).

**US-AD-03 Configure approvals.** *(Implemented in Phase 5a, with an editor screen; "in-flight approvals keep their steps" is verified in 5b.)* Tomas publishes an approval policy: amount bands per department, each band an ordered list of steps (`approver` in the document's department, or `finance` org-wide).
- Overlapping bands or gaps from 0 upward are rejected.
- In-flight approvals keep the steps they were created with.

**US-AD-04 Org settings.** *(Org name, time zone, and currency with its lock: Phase 5a. Each other setting ships with the phase that uses it, Phases 6–8; see PLAN.md.)* Tomas sets org name, timezone, currency (locked once any monetary document exists), RFQ threshold, minimum quotes, PO approval threshold, price tolerance, and over-receipt tolerance.

## Suppliers

**US-SUP-01 Register a supplier.** Dewi registers a supplier (legal name, tax ID, contacts, address). It starts as `pending_review`.
- A duplicate normalized name (among non-inactive suppliers) or a duplicate tax ID is rejected. Names compare ignoring case, spacing, and punctuation ("PT. Maju-Jaya" = "pt maju jaya"); tax IDs ignore separators. (Implemented in Phase 4.)

**US-SUP-02 Review a supplier (maker-checker).** Sari activates or rejects a pending supplier.
- Dewi, who created it, cannot activate it, even if she also holds `finance` (`MAKER_CHECKER`).
- Changing the legal name or tax ID of an active supplier sends it back to `pending_review`.

**US-SUP-03 Block a supplier.** Dewi or Sari blocks a supplier with a reason (permission `supplier.block`). Only Sari (finance) unblocks it, and then it needs a fresh review. Blocked suppliers can't be invited, quoted, or ordered from, and an approved PO to them can't be issued. Receipts on already-issued POs still work.

## Purchase requisitions

**US-PR-01 Draft a requisition.** *(Phase 5a.)* Rina creates a PR with lines (description, quantity, unit, estimated unit price) and a needed-by date.
- The server computes line totals and the PR total. A total sent by the browser is rejected.
- The PR belongs to Rina's department, taken from her profile, not from the form.

**US-PR-02 Edit my draft.** *(Phase 5a for drafts, Phase 5b for returned requisitions.)* Rina edits her PR while it is `draft` or `returned`. If someone else changed it since she loaded it, she gets "this requisition changed, reload" (`CONFLICT`).

**US-PR-03 Submit for approval.** *(Phase 5b.)* Rina submits. The approval route is resolved from the active policy (department + total) and frozen.
- If no rule matches, submission fails with `NO_APPROVAL_ROUTE`. The PR is never auto-approved.
- After submission, the lines are read-only.

**US-PR-04 Withdraw or cancel.** *(Drafts: Phase 5a. Pending and approved: Phase 5b.)* Rina can cancel her PR while draft, returned, or pending (with a reason when pending), or when approved but nothing has been ordered yet.

**US-PR-05 See only what I'm allowed to.** *(Phase 5a.)* Rina sees only her own PRs. Bayu sees PRs of the departments he approves for. Dewi, Sari, and Lena see all. Opening another person's PR by URL returns "not found" for Rina.

## Approvals

**US-AP-01 Approval inbox.** *(Phase 5b.)* Bayu sees the steps he is eligible to decide right now. Steps he is barred from by SoD are not listed.

**US-AP-02 Decide.** *(Phase 5b.)* Bayu approves, rejects (comment required), or returns for changes (comment required).
- **Rina cannot approve her own PR**, even if she also holds `approver` for her department (`SELF_APPROVAL`, blocked in the app and by a DB trigger).
- One person cannot approve two steps of the same round (`DUPLICATE_APPROVER`).
- If Bayu and another approver click Approve on the same step at the same time, exactly one decision is recorded and the other person is told it was already decided.

**US-AP-03 Multi-step progression.** *(Phase 5b.)* After step 1 is approved, step 2 becomes pending for its eligible approvers. Approving the final step approves the document. Rejecting any step rejects it. Returning any step returns it to the requester, and resubmitting starts a new round from step 1.

**US-AP-04 Approval history.** *(Phase 5b.)* Anyone who can see the document sees its full approval history across rounds: who, when, decision, and comment.

## Sourcing

**US-SRC-01 Request quotations.** *(Phase 6a.)* Dewi creates an RFQ from approved PR lines with remaining quantity, invites active suppliers, sets a due date, and issues it.

**US-SRC-02 Record quotations.** Dewi records each supplier's quotation (unit price per line, validity, lead time). Suppliers have no login in v1.

**US-SRC-03 Compare and award.** Dewi sees a server-computed comparison (per-line prices, totals, lowest valid quote) and awards one quotation.
- If fewer than the minimum number of quotations were received for a PR above the RFQ threshold, or she picks a quote that isn't the lowest, she must write a justification, which is audited.
- Expired quotations (`valid_until` in the past) can't be awarded.

## Purchase orders

**US-PO-01 Create a PO.** Dewi creates a PO for an active supplier from approved PR lines, either from an awarded quotation (prices taken from it) or directly when the PR is below the RFQ threshold.
- She can't order more than the PR line's remaining quantity (`OVER_ORDER`), even if two buyers try at the same moment.
- Above the RFQ threshold, a PO without an awarded quotation is rejected (`RFQ_REQUIRED`).

**US-PO-02 PO approval when needed.** On submit, the PO goes to approval if it's at or above the PO threshold, or if its prices exceed the PR estimate by more than the tolerance. Otherwise it is approved automatically, and the reason is recorded in the audit trail.
- Dewi can't approve her own PO, and neither can the buyer who awarded its quotation.

**US-PO-03 Issue.** Dewi issues an approved PO. From then on its lines and prices can't change. The maximum receivable quantity per line is fixed at issue time.

**US-PO-04 Close or cancel.** Dewi cancels a PO that has no receipts (reserved PR quantity is released), or closes a PO with a reason (unreceived quantity is released back to the PR).

## Goods receipts

**US-GR-01 Receive goods.** Agus records a receipt against an issued PO: date, delivery-note reference, and quantity per line. Posting it updates the PO's received quantities and status.
- Agus can't receive more than ordered (plus configured tolerance). The whole receipt is rejected with the offending lines named (`OVER_RECEIPT`), including when two receipts are posted at the same moment.
- If Agus created the PO himself, he can't receive against it (`ORDER_RECEIVE_CONFLICT`).

**US-GR-02 Reverse a receipt.** Agus reverses a posted receipt with a reason. A reversal document is created, received quantities go down, and the original stays unchanged. A receipt can be reversed only once.

## Audit and reporting

**US-AU-01 Audit search.** Lena searches the audit trail by document, user, action, and date range, and sees before/after values for changed fields.

**US-AU-02 Audit cannot be altered.** No user, including admins, can edit or delete audit events through the application. Attempts at the database level by the app role fail.

**US-RP-01 Spend reports.** Sari views spend by supplier and by department for a date range, on an issued or received basis, and exports to CSV. Numbers match the underlying documents exactly. Each report shows when it was computed.

**US-RP-02 Process health.** Sari views PR cycle time (median and p90), approval aging, and open POs with outstanding quantities.

**US-RP-03 Fraud signals.** Lena views "potential split purchases": PRs or POs by the same requester and supplier within N days that are each below a threshold but exceed it together.

**US-RP-04 Honest empty states.** With no data in range, reports say so. They never show placeholder or sample numbers.

## Out of scope for v1 (explicit)

Supplier self-service portal; email or other notifications (in-app inbox only); invoices, three-way match, and payments; budgets and commitments; contracts and catalogs or punch-out; multi-currency and FX; attachments and file uploads; PO change orders after issue; approval delegation and out-of-office; SSO/OIDC; multi-tenant hosting; PDF generation (an HTML print view only). Each one needs its own story, threat-model update, and phase.
