# State machines

Every transition below is validated **on the server**, inside the command's transaction, **after** the document row is locked (ADR 0008). Any transition not listed is rejected with `INVALID_TRANSITION`. Each machine is implemented once in `modules/<m>/domain/` as a pure transition table and tested exhaustively: every (state, command) pair is either listed here or must be rejected.

Notation: **Actor** is the permission plus any resource rule. **Guards** must all hold. **Effects** happen atomically with the transition, and every transition writes an audit event named after its command.

---

## 1. Purchase requisition (PR) (implemented in Phases 5a and 5b)

```mermaid
stateDiagram-v2
  [*] --> draft: create
  draft --> pending_approval: submit
  returned --> pending_approval: submit (new round)
  pending_approval --> approved: last step approved
  pending_approval --> rejected: any step rejected
  pending_approval --> returned: any step returned
  draft --> cancelled: cancel
  returned --> cancelled: cancel
  pending_approval --> cancelled: cancel (withdraw)
  approved --> cancelled: cancel (nothing ordered)
  approved --> closed: close
  rejected --> [*]
  cancelled --> [*]
  closed --> [*]
```

| ID | From → To | Command | Actor | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| PR-T01 | ∅ → draft | `requisition.create` | `requisition.create` | Actor profile active with a department. 1 to 200 lines. | Number allocated (`PR-YYYY-NNNNNN`). Line and document totals computed server-side. `currency_code` = org currency. |
| PR-T02 | draft → draft, returned → returned | `requisition.update` | owner (requester) | `expectedVersion` matches | Replace header and lines, recompute totals, `version+1`. Audit records changed fields. |
| PR-T03 | draft / returned → pending_approval | `requisition.submit` | owner | ≥1 line. `estimated_total` > 0. `needed_by` ≥ today (org timezone). Active approval policy resolves **≥1 step** (otherwise `BUSINESS_RULE: NO_APPROVAL_ROUTE`; a PR is **never auto-approved**). | New `approval_request` (round = previous + 1) with a step snapshot. Step 1 is `pending`, the rest `waiting`. Lines become read-only. |
| PR-T04 | pending_approval → approved | (system, from AP-T02) | | Final step approved | `approved_at` set |
| PR-T05 | pending_approval → rejected | (system, from AP-T03) | | | Terminal |
| PR-T06 | pending_approval → returned | (system, from AP-T04) | | | Editable again by the owner. The approver's comment is shown. |
| PR-T07 | draft / returned → cancelled | `requisition.cancel` | owner | | `cancel_reason` optional |
| PR-T08 | pending_approval → cancelled | `requisition.cancel` | owner | reason required | Live approval request and its open steps become `cancelled` |
| PR-T09 | approved → cancelled | `requisition.cancel` | owner or `po.create` holder | reason required. **Every line has `ordered_qty = 0`.** | Terminal |
| PR-T10 | approved → closed | `requisition.close` | `po.create` holder | reason required | Remaining unordered quantity can no longer be ordered. Terminal. There is no automatic close in v1; the UI shows ordering progress instead. |

Invariant PR-I1: `0 ≤ ordered_qty ≤ quantity` per line (DB CHECK). Ordered quantity changes only through PO commands.

Implementation (Phase 5a): the pure table is `modules/requisitions/domain/requisition.ts`, all 49 (status, command) pairs tested in `tests/unit/requisition-domain.test.ts`. The year in `PR-YYYY-NNNNNN` is the current year in the org time zone. A trigger keeps lines read-only outside `draft` and `returned` (T-02).

Implementation (Phase 5b), where the table above left room:
- PR-T03 guards fail as `BUSINESS_RULE` `ZERO_TOTAL` (no lines, or a total of 0), `NEEDED_BY_IN_PAST` (before today in the org time zone; today itself is fine), and `NO_APPROVAL_ROUTE` (no active policy; publishing requires any-department rules covering every amount from 0, so a published policy always has a route). The route is resolved from the stored total and department.
- PR-T04 to T06 run inside `approval.decide`: the requisitions module implements the approvals port (`modules/requisitions/application/approval-document.ts`), registered in `src/server/approvals.ts`. Each writes `requisition.approved`, `.rejected`, or `.returned` (the approver's comment as the reason).
- PR-T07 to T09 are one command, `requisition.cancel` (permission `requisition.create` **or** `po.create`). The requester may cancel in every state that allows it; a `po.create` holder who is not the requester only when `approved` (otherwise `FORBIDDEN`). A reason is required when withdrawing or after approval (`VALIDATION_FAILED` on `reason`). PR-T09 with any ordered quantity is `ALREADY_ORDERED`.
- PR-T10 `requisition.close` needs `po.create` and a reason (1 to 500 characters).
- `current_approval_request_id` always points at the latest round; `submitted_at` is the latest submission. CHECKs keep these consistent with the status (for example, no `approved` without `approved_at`, no `closed` without its close fields).

---

## 2. Approval request and steps (shared by PR and PO; implemented in Phase 5b)

One **approval request** per submission round. Its **steps** are a snapshot taken at submit time from the active approval policy, matched by document type, department, and amount. Later policy changes never affect an in-flight request.

```mermaid
stateDiagram-v2
  state "Step" as S {
    [*] --> waiting
    waiting --> pending: previous step approved
    [*] --> pending: first step
    pending --> approved: decide(approve)
    pending --> rejected: decide(reject)
    pending --> returned: decide(return)
    waiting --> cancelled: request ends early
    pending --> cancelled: document withdrawn
  }
```

| ID | Transition | Command | Actor | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| AP-T01 | create request + steps | (inside PR-T03 / PO-T03) | | Policy resolves ≥1 step | Request `pending`, step 1 `pending` |
| AP-T02 | step pending → approved | `approval.decide` `{decision: 'approve'}` | `approval.decide` and holds the step's `required_role` within the step's scope | Request `pending`, step `pending`, `expectedVersion` matches. **SOD-01**: actor ≠ request `submitted_by`. **SOD-02**: actor has not decided another step in this request. **SOD-06** for POs. | Next step → `pending`. If it was the last step: request → `approved`, document → `approved`. |
| AP-T03 | step pending → rejected | `approval.decide` `{decision: 'reject', comment}` | same | same + comment 1 to 2000 chars | Remaining steps → `cancelled`. Request → `rejected`. Document → PR `rejected` / PO `rejected`. |
| AP-T04 | step pending → returned | `approval.decide` `{decision: 'return', comment}` | same | same + comment | Remaining steps → `cancelled`. Request → `returned`. Document → PR `returned` / PO `draft`. |
| AP-T05 | request → cancelled | (inside PR-T08 / PO-T08) | | | Open steps → `cancelled` |

Eligibility of a step: a user is eligible if they hold an **active** assignment of `required_role` whose scope is the document's department or org-wide (`scope_mode = document_department`), or an org-wide assignment (`scope_mode = organization`), and SoD does not exclude them. If no user is eligible, the step stays pending and shows up in the approval-aging report. Approvals are never skipped automatically.

Invariants: AP-I1 at most one `pending` request per document (partial unique index). AP-I2 at most one decision per step (decided fields set once, from `pending` only). AP-I3 SOD-01 is also enforced by a DB trigger. AP-I4 SOD-02 is also enforced by a unique index on `(approval_request_id, decided_by_user_id)`.

Implementation (Phase 5b):
- The pure tables are in `modules/approvals/domain/approval.ts`: steps (6 statuses × 5 events: activate, approve, reject, return, cancel) and requests (5 statuses × 4 events), all pairs tested in `tests/unit/approval-domain.test.ts`.
- A step snapshot stores `required_role` and `scope_department_id`: the document's department for `document_department` steps, NULL for `organization` steps. An org-wide assignment of the role qualifies for any step of that role; a department assignment only for a step scoped to that department. Finance is always org-wide.
- `approval.decide` locks the document first, then the request (ADR 0008 C8, the same order as submit and withdraw), and checks in this order: the caller can see the document (else `NOT_FOUND`, like a missing request), the request is pending and the step is pending (`INVALID_TRANSITION`, "already decided" or "not open yet"), the request version (`CONFLICT`), SOD-01 (`SELF_APPROVAL`), SOD-02 (`DUPLICATE_APPROVER`), then role and scope read fresh from the database (`NOT_ELIGIBLE_APPROVER`; a role revoked after sign-in no longer counts).
- A comment is optional to approve and required to reject or return (1 to 2000 characters, `VALIDATION_FAILED` on `comment`).
- Every request change bumps its `version`. Steps record `activated_at` when they open (the inbox sorts by it). Audit: `approval.requested` (route and amount), `approval.decided`, `approval.cancelled`, all on entity type `approval_request`.
- `awarded_by_user_id` (SOD-06) exists and the trigger checks it. Since Phase 7 a purchase order's round sets it to the buyer who awarded the order's quotation; it is NULL for requisitions and direct orders.

---

## 3. Supplier (implemented in Phase 4)

```mermaid
stateDiagram-v2
  [*] --> pending_review: create
  pending_review --> active: review(approve)
  pending_review --> inactive: review(reject)
  active --> pending_review: identity fields changed
  active --> blocked: block
  blocked --> pending_review: unblock
  active --> inactive: deactivate
  inactive --> pending_review: reactivate
```

| ID | Transition | Command | Actor | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| SUP-T01 | ∅ → pending_review | `supplier.create` | `supplier.manage` | `normalized_name` unique among non-inactive suppliers. `tax_id` unique when present. | Code `SUP-NNNNNN` |
| SUP-T02 | edit contact fields (any non-terminal state) | `supplier.update` | `supplier.manage` | version | State unchanged |
| SUP-T03 | active → pending_review | `supplier.update` that changes `legal_name` or `tax_id` | `supplier.manage` | version | `identity_changed_by` = actor. Re-review required. |
| SUP-T04 | pending_review → active | `supplier.review` `{decision:'approve'}` | `supplier.review` | **SOD-03**: actor ≠ `created_by` and ≠ `identity_changed_by` | `reviewed_by`, `reviewed_at` |
| SUP-T05 | pending_review → inactive | `supplier.review` `{decision:'reject', note}` | `supplier.review` | SOD-03 | |
| SUP-T06 | active → blocked | `supplier.block` | `supplier.block` (procurement or finance; ADR 0006 amendment) | reason | |
| SUP-T07 | blocked → pending_review | `supplier.unblock` | `supplier.review` | reason | Needs a fresh review (SUP-T04) |
| SUP-T08 | active → inactive | `supplier.deactivate` | `supplier.manage` | reason | |
| SUP-T09 | inactive → pending_review | `supplier.reactivate` | `supplier.manage` | uniqueness re-checked | |

Implementation notes (Phase 4), recorded where the table above left room:
- The pure table is `modules/suppliers/domain/supplier.ts`; all 32 (status, command) pairs are tested in `tests/unit/supplier-domain.test.ts`.
- "Non-terminal" in SUP-T02 means `pending_review`, `active`, and `blocked`. An inactive supplier cannot be edited; reactivate it first.
- An identity change (any edit of `legal_name` or `tax_id` **as typed**, even case only) on `pending_review` or `blocked` keeps the status, but sets `identity_changed_by` and clears the review, so the next approval needs someone else (SOD-03).
- Reject (SUP-T05) needs a note, which becomes `status_reason`. Block, unblock, and deactivate need a reason.
- Unblock (SUP-T07) and reactivate (SUP-T09) clear the old review. A CHECK guarantees that an active supplier always has a reviewer, and that the reviewer is neither the creator nor the last identity changer.
- Duplicate keys (maintainer decision 2026-10-22): names compare after Unicode normalization, lowercasing, and turning every run of punctuation or whitespace into one space (`PT. Maju-Jaya` = `pt maju jaya`); legal suffixes still count. Tax IDs compare as letters and digits only. Names must be unique among non-inactive suppliers, tax IDs among all suppliers.

Rule SUP-R1: only `active` suppliers can be invited to RFQs, quoted, put on new POs, or have a PO **issued** to them. Receipts against already-issued POs are still allowed whatever the supplier's status, because the goods physically arrived.

---

## 4. Request for quotation (RFQ) and quotation (RFQ lifecycle implemented in Phase 6a; quotations and award in 6b)

```mermaid
stateDiagram-v2
  [*] --> draft: create
  draft --> issued: issue
  issued --> closed: close
  closed --> awarded: award
  draft --> cancelled: cancel
  issued --> cancelled: cancel
  closed --> cancelled: cancel
```

| ID | Transition | Command | Actor | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| RFQ-T01 | ∅ → draft | `rfq.create` | `rfq.manage` | PR `approved`. Selected lines have remaining qty (`quantity − ordered_qty`) > 0. RFQ line qty ≤ remaining. | Number `RFQ-YYYY-NNNNNN` |
| RFQ-T02 | draft → draft | `rfq.update` (lines, due date, invited suppliers) | `rfq.manage` | invited suppliers `active` | |
| RFQ-T03 | draft → issued | `rfq.issue` | `rfq.manage` | ≥1 invited supplier. `response_due_at` in the future. | v1 sends nothing to suppliers; the buyer contacts them out of band. |
| RFQ-T04 | issued → closed | `rfq.close` | `rfq.manage` | | No more quotations |
| RFQ-T05 | closed → awarded | `quotation.award` | `quotation.award` | Chosen quotation `submitted`, `valid_until` ≥ today, supplier `active`. If PR `estimated_total` ≥ `rfq_required_above` and fewer than `min_quotes` quotations were submitted, a justification is required. If the chosen quotation is not the lowest total among valid submitted quotations, a justification is required. | Chosen → `awarded`, other submitted → `not_awarded`. `awarded_by` recorded (for SOD-06). |
| RFQ-T06 | draft / issued / closed → cancelled | `rfq.cancel` | `rfq.manage` | reason | Open quotations stay as recorded |

Implementation (Phase 6a), where the table above left room:
- The pure table is `modules/sourcing/domain/rfq.ts`; all 25 (status, command) pairs are tested in `tests/unit/rfq-domain.test.ts`. The award command (RFQ-T05) is implemented in Phase 6b (below).
- RFQ-T01 and T02 guards fail as `REQUISITION_NOT_APPROVED`, `QUANTITY_EXCEEDS_REMAINING` (with `details: [{lineNo, remaining}]`), `LINE_ALREADY_IN_RFQ`, and `SUPPLIER_NOT_ACTIVE`. A requisition line can be on only one RFQ that is not cancelled (maintainer decision 2026-10-25); cancelling an RFQ frees its lines. Descriptions and units are copied from the requisition lines.
- RFQ-T03 also re-checks that the requisition is still approved and that every invited supplier is still active; it fails as `NO_SUPPLIERS_INVITED` or `RESPONSE_DUE_IN_PAST` (the due time must be later than now). The due time is entered as a local time in the org time zone; a time skipped by a daylight-saving change is refused.
- RFQ-T06 needs a reason (1 to 500 characters). Every transition is audited (`rfq.created`, `.updated`, `.issued`, `.closed`, `.cancelled`).
- Lock order (ADR 0008 C8): create, update, and issue lock the requisition row, then the RFQ.

Quotation (recorded by the buyer; suppliers have no login in v1):

| ID | Transition | Command | Guards |
| --- | --- | --- | --- |
| QUO-T01 | ∅ → draft | `quotation.record` | RFQ `issued`, supplier invited and `active`, no other non-withdrawn quotation from that supplier on this RFQ |
| QUO-T02 | draft → draft | `quotation.update` | Lines cover every RFQ line exactly once, quantity equals RFQ quantity. Totals computed server-side. |
| QUO-T03 | draft → submitted | `quotation.submit` | RFQ `issued`, `valid_until` ≥ today |
| QUO-T04 | submitted → withdrawn | `quotation.withdraw` | RFQ not `awarded`. Reason required. |
| QUO-T05 | submitted → awarded / not_awarded | (system, RFQ-T05) | |

Implementation (Phase 6b), where the tables above left room:
- The pure table is `modules/sourcing/domain/quotation.ts`: 5 statuses × 5 commands (`update`, `submit`, `withdraw`, and the system's `award` and `award_other`), all 25 pairs tested in `tests/unit/quotation-domain.test.ts`.
- **Amendment (maintainer decision 2026-10-25): a draft can be discarded.** `quotation.withdraw` on a draft (draft → withdrawn) discards it while the RFQ is issued, with a reason, as for QUO-T04.
- **QUO-T01** fails as `SUPPLIER_NOT_INVITED`, `SUPPLIER_NOT_ACTIVE`, or `SUPPLIER_ALREADY_QUOTED`, and as `INVALID_TRANSITION` unless the RFQ is issued. The guards of QUO-T02 apply to recording too: every RFQ line is priced exactly once (`VALIDATION_FAILED`), quantities come from the RFQ, and totals are computed by the server at the requisition's currency scale, in the requisition's currency.
- **QUO-T02 and T03 also need the RFQ issued.** QUO-T03 needs `valid_until` ≥ today in the organization's time zone (`QUOTATION_EXPIRED`) and the supplier still active (`SUPPLIER_NOT_ACTIVE`).
- **Late quotations (maintainer decision 2026-10-25):** after `response_due_at` a quotation is still recorded and submitted while the RFQ is issued, and is flagged late (`submitted_at` > `response_due_at`, both kept; `submitted_at` comes from the application clock). The comparison and the audit event show it.
- **QUO-T04** works until the award: while the RFQ is issued or closed. Afterwards the supplier may record a new quotation while the RFQ is issued.
- **RFQ-T04 amendment (maintainer decision 2026-10-25): closing discards the drafts** nobody submitted (audited `quotation.withdrawn`, reason "Not submitted before the RFQ was closed"); the close form warns first. **RFQ-T06:** quotations of a cancelled RFQ stay as recorded and can no longer change.
- **Valid quotation (maintainer decision 2026-10-25):** submitted (or already awarded or not awarded), `valid_until` ≥ today (org time zone), supplier active. Only valid quotations count towards `min_quotes` and the lowest total; RFQ-T05's "fewer than `min_quotes` quotations were submitted" therefore counts valid ones. A tie makes each tied quotation the lowest.
- **RFQ-T05** checks, in this order: RFQ closed (`INVALID_TRANSITION`), version, requisition still approved (`REQUISITION_NOT_APPROVED`), the quotation is on this RFQ (`NOT_FOUND`) and submitted (`INVALID_TRANSITION`), `QUOTATION_EXPIRED`, `SUPPLIER_NOT_ACTIVE`, then the justification: `MIN_QUOTES_JUSTIFICATION_REQUIRED` when the minimum applies (requisition `estimated_total` ≥ `rfq_required_above` and fewer valid quotations than `min_quotes`), otherwise `NON_LOWEST_JUSTIFICATION_REQUIRED`; `details.reasons` lists both when both apply, and one text (1 to 2000 characters) covers both. The RFQ stores who awarded it (SOD-06 in Phase 7), when, the justification, and the rule as it stood (threshold, minimum, valid count, and both flags), so a later settings change does not rewrite it. Audited `rfq.awarded` (the justification is the reason), `quotation.awarded`, `quotation.notAwarded`.
- **Lock order (ADR 0008 C8):** the award locks the requisition, the RFQ, then all its quotations; recording, editing, submitting, withdrawing, and closing lock the RFQ, then the quotation(s).

---

## 5. Purchase order (PO)

```mermaid
stateDiagram-v2
  [*] --> draft: create
  draft --> pending_approval: submit (approval required)
  draft --> approved: submit (no approval required)
  pending_approval --> approved: approval complete
  pending_approval --> draft: returned
  pending_approval --> rejected: rejected
  approved --> issued: issue
  issued --> partially_received: receipt posted
  partially_received --> received: all lines fully received
  partially_received --> issued: receipt reversed to zero
  received --> partially_received: receipt reversed
  issued --> closed: close
  partially_received --> closed: close (short-close)
  received --> closed: close
  draft --> cancelled: cancel
  pending_approval --> cancelled: cancel
  approved --> cancelled: cancel
  issued --> cancelled: cancel (no receipts)
```

| ID | Transition | Command | Actor | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| PO-T01 | ∅ → draft | `po.create` | `po.create` | Supplier `active`. Every line references a PR line whose PR is `approved`. **RFQ rule:** if the PR's `estimated_total` ≥ `rfq_required_above`, the PO must reference an `awarded` quotation for those lines (`BUSINESS_RULE: RFQ_REQUIRED`). | **Reserve quantity** per line with C2: `ordered_qty += qty` only if it stays ≤ `quantity`, otherwise `BUSINESS_RULE: OVER_ORDER`. Totals computed. Number `PO-YYYY-NNNNNN`. |
| PO-T02 | draft → draft | `po.update` (lines, terms, tax rates) | creator or `po.create` | version | Re-reserve the quantity deltas with C2 (release decreases, reserve increases). Recompute totals. |
| PO-T03 | draft → pending_approval / approved | `po.submit` | `po.create` | ≥1 line. Approval is **required** if any of: `total` ≥ `po_approval_threshold`; any line's `unit_price` exceeds its PR line `estimated_unit_price` by more than `po_price_tolerance_pct`; PO total exceeds the referenced PR lines' approved estimate by more than the tolerance. | If required: approval request (AP-T01) with policy `purchase_order`, reasons stored. Otherwise → `approved`, audited with reason `BELOW_THRESHOLD`. |
| PO-T04 | pending_approval → approved / draft / rejected | (system, AP-T02/03/04) | | | **Rejected is terminal and releases every line's reserved quantity.** |
| PO-T05 | approved → issued | `po.issue` | `po.create` | Supplier `active` | `max_receivable_qty = floor3(quantity × (1 + over_receipt_tolerance_pct/100))` snapshot per line. PO becomes immutable. |
| PO-T06 | issued ⇄ partially_received ⇄ received | (system, GR-T02 / GR-T04) | | | Status derived: all lines `received_qty ≥ quantity` → `received`; any > 0 → `partially_received`; otherwise `issued`. |
| PO-T07 | issued / partially_received / received → closed | `po.close` | `po.create` | reason required unless `received` | Release `max(0, quantity − received_qty)` back to each PR line's `ordered_qty`. No further receipts. |
| PO-T08 | draft / pending_approval / approved → cancelled | `po.cancel` | `po.create` | reason | Release all reserved quantity. Cancel the live approval request. |
| PO-T09 | issued → cancelled | `po.cancel` | `po.create` | reason. **No posted receipts** (every `received_qty = 0`). | Release all reserved quantity |

Invariants: PO-I1 for every PR line, `ordered_qty` = Σ `quantity` of its PO lines on POs in `draft`, `pending_approval`, `approved`, `issued`, `partially_received`, or `received`, plus Σ `min(quantity, received_qty)` of its PO lines on `closed` POs. Cancelled and rejected POs contribute nothing. A test helper checks this after every concurrency test. PO-I2 totals equal the recomputation from lines. PO-I3 an issued PO's lines are never modified except `received_qty`.

There are no change orders after issue in v1. To change an issued PO: cancel it (if nothing has been received) and create a new one.

Implementation (Phase 7), where the table above left room (maintainer instruction 2026-10-26 to implement without a separate plan stop; decisions listed in docs/reports/phase-7.md):
- The pure table is `modules/purchasing/domain/purchase-order.ts`: 9 statuses × 9 commands (`update`, `submit` for "approval required", `auto_approve` for "not required", `approve`, `return`, `reject`, `issue`, `close`, `cancel`), all 81 pairs tested in `tests/unit/purchase-order-domain.test.ts`. PO-T06 is `receiptStatus(lines)`, applied after every posted goods receipt and reversal (Phase 8, below).
- **One requisition per PO** (`requisition_id`); the PO's department is the requisition's. A requisition can have several POs.
- **PO-T01:** the requisition must be `approved` (`REQUISITION_NOT_APPROVED`) and the supplier `active`. Descriptions and units come from the requisition lines. With `quotationId`: the quotation must be awarded (`QUOTATION_NOT_AWARDED`) and valid today in the org time zone (`QUOTATION_EXPIRED`), from the PO's supplier, for its requisition; every line is one of its lines at its price (a client price is ignored), for no more than it quoted (`QUANTITY_EXCEEDS_QUOTED`). `RFQ_REQUIRED` when the requisition's estimated total ≥ `rfq_required_above` and there is no quotation, checked at create **and again at submit**. Reservation: the requisition row is locked, each line's change is checked against what is left (`OVER_ORDER`, `details: [{ lineNo, remaining }]`), then applied with C2.
- **PO-T02 / T03:** only the PO's **creator** edits and submits it (`FORBIDDEN` for other buyers), so SOD-01 (the submitter never decides) covers the creator. Edits re-reserve the quantity changes (more, less, a line added or removed). Submit also refuses a blocked supplier (`SUPPLIER_NOT_ACTIVE`) and an expected delivery date before today (`DELIVERY_DATE_IN_PAST`).
- **The approval rule (PO-T03):** reasons `AMOUNT_THRESHOLD` (total with tax ≥ `po_approval_threshold`), `NO_THRESHOLD` (no threshold: every PO needs approval), `PRICE_VARIANCE` (a unit price > the requisition line's estimate × (1 + tolerance/100)), `TOTAL_VARIANCE` (subtotal > Σ round(quantity × estimate) × (1 + tolerance/100); the estimate excludes tax like the PR). No reason: the PO is `approved` at once, audited with reason `BELOW_THRESHOLD`. Otherwise an approval round on the active `purchase_order` policy by the PO's department and total (`NO_APPROVAL_ROUTE` without one), with `awarded_by_user_id` = the buyer who awarded the quotation (SOD-06). The reasons, threshold, and tolerance are stored on the PO; the database recomputes the reasons and compares the rule with the settings.
- **PO-T04:** approve → `approved` (`approved_at`); return → `draft` (editable; resubmitting opens a new round); reject → `rejected`, releasing every reserved quantity. Audit `po.approved`, `po.returned`, `po.rejected` (the comment as the reason).
- **PO-T05:** any buyer; the supplier must be active; `receipt_tolerance_pct` = `over_receipt_tolerance_pct` now, and each line's `max_receivable_qty` = floor3(quantity × (1 + tolerance/100)). The setting moved from Phase 8 to Phase 7 for this.
- **PO-T07 to T09:** any buyer. Cancel needs a reason (1 to 500); from `pending_approval` it withdraws the round (AP-T05); from `issued` only while nothing was received (`RECEIPTS_EXIST`). Close needs a reason unless `received` and releases max(0, quantity − received) per line. Audit `po.cancelled` / `po.closed` with what was released.

Implementation (Phase 8, goods receipts):
- **PO-T06:** after a posted receipt or reversal, the order's status is re-derived from its lines (every line received in full → `received`; anything received → `partially_received`; nothing → `issued`), in either direction, including `received → issued` when one reversal takes everything back. Every posting and reversal also changes the order's version, so a buyer who closes or cancels from an older page gets `CONFLICT`. A status change is audited on the order (`po.receiptStatusChanged`, with the goods receipt's number).
- **RECEIPTS_EXIST:** an order with anything received is `partially_received` or `received`; cancelling it answers `RECEIPTS_EXIST` (close it instead) before the transition check. Once every receipt is reversed, the order is `issued` again and can be cancelled.
- The database derives the same status: between `issued`, `partially_received`, and `received` an order may only take the status its lines give, and at commit an issued order's status must match its lines.

---

## 6. Goods receipt (GR)

```mermaid
stateDiagram-v2
  [*] --> draft: create
  draft --> posted: post
  draft --> cancelled: cancel
  posted --> posted: reversed (by a separate reversal GR)
```

| ID | Transition | Command | Actor | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| GR-T01 | ∅ → draft | `receipt.create` | `receipt.create` | PO `issued` or `partially_received`. **SOD-04**: actor ≠ PO creator. Lines reference this PO's lines, qty > 0. `received_on` ≤ today and ≥ PO `issued_at` date. | Number `GR-YYYY-NNNNNN` |
| GR-T02 | draft → posted | `receipt.post` | `receipt.create`, SOD-04 | PO (locked) still `issued` / `partially_received`. For **each** line, C2: `received_qty += qty` only if it stays ≤ `max_receivable_qty`. **Any failure rolls back the whole receipt** with `BUSINESS_RULE: OVER_RECEIPT` naming the line(s). | PO status re-derived (PO-T06). Posted receipts are immutable. |
| GR-T03 | draft → cancelled | `receipt.cancel` | creator | | |
| GR-T04 | posted receipt → reversal GR (posted) | `receipt.reverse` | `receipt.create`, SOD-04 | Original `kind=receipt`, `posted`, not already reversed. PO not `closed` / `cancelled`. Reason required. | New GR `kind=reversal` with the same lines. C2: `received_qty −= qty` with `≥ 0`. PO status re-derived. |

Invariants: GR-I1 `po_lines.received_qty` = sum of posted receipt quantities − sum of posted reversal quantities for that line (test helper). GR-I2 `0 ≤ received_qty ≤ max_receivable_qty` (DB CHECK). GR-I3 a receipt is reversed at most once (unique `reverses_goods_receipt_id`).

Implementation (Phase 8, 2026-10-27; decisions in docs/reports/phase-8.md, accepted by the maintainer before implementation):
- The pure table is `modules/receiving/domain/goods-receipt.ts`: 2 kinds × 3 statuses × 3 commands (`post`, `cancel`, `reverse`), all 18 triples tested in `tests/unit/goods-receipt-domain.test.ts`. A reversal is recorded as a draft and posted in the same command, so it is never cancelled or reversed; the database refuses to commit a reversal that is not posted.
- **GR-T01:** an order a receiver cannot read (not issued yet, or cancelled) is `NOT_FOUND`; an issued order that no longer takes receipts (`received`, `closed`) is `PO_NOT_RECEIVABLE`. SOD-04 (`ORDER_RECEIVE_CONFLICT`) is checked first. `received_on`: not after today (org time zone) and not before the day the order was issued (`VALIDATION_FAILED` on `receivedOn`). Each line once, from this order, quantity > 0 with up to 3 decimals; a delivery note reference (up to 100), notes (up to 1000), and a note per line (up to 500) are optional. `OVER_RECEIPT` is checked already here, against what each line can take now (decision 2); posting checks again. Drafts are never edited (decision 1): no update command exists.
- **GR-T02:** the order is locked first, then the receipt. `OVER_RECEIPT` names every line that is over, with what it can still take (`details: [{ lineNo, remaining }]`), and nothing is received. The receipt becomes `posted` before the quantities move (the database compares the two), then each line moves with C2 in ascending id order, then PO-T06.
- **GR-T03:** only the user who recorded the draft (`FORBIDDEN` otherwise); the reason is optional. A draft of an order that was closed or cancelled meanwhile cannot be posted (`PO_NOT_RECEIVABLE`), only cancelled (decision 4).
- **GR-T04:** `ALREADY_REVERSED` names the earlier reversal; `PO_CLOSED` for a closed order. The reversal copies the receipt's lines, is dated the org day it is recorded (decision 5), carries the reason, and is audited as `receipt.reversalPosted` on the reversal and `receipt.reversed` on the receipt, which itself never changes.

---

## 7. User account (implemented in Phase 3b)

```mermaid
stateDiagram-v2
  [*] --> active: admin.user.create (no password yet)
  active --> deactivated: admin.user.deactivate
  deactivated --> active: admin.user.reactivate
```

The stored status has two values, `active` and `deactivated` (`user_profiles.status`). "Pending setup" is not a status: it is an active user without a password (no credential account), shown as a badge. With two states the transitions are checked directly in the commands (`application/admin-users.ts`) rather than in a domain table. All four (state, command) pairs are tested in `tests/integration/admin.test.ts`.

| ID | Transition | Command | Actor | Guards | Effects |
| --- | --- | --- | --- | --- | --- |
| USR-T01 | ∅ → active | `admin.user.create` | `admin.users` (+ `admin.roles` for initial roles) | Email unique. Departments active. Scope rules. | Profile, roles, audit. Then a one-time setup link. |
| USR-T02 | active → deactivated | `admin.user.deactivate` | `admin.users`, **SOD-05** (not self) | version, reason, `LAST_ADMIN` under the admin-set lock | All sessions and unused setup links deleted in the same transaction. Sign-in refused from then on. |
| USR-T03 | deactivated → active | `admin.user.reactivate` | `admin.users`, SOD-05 | version | Signs in again with the existing password. Roles are as they were. |
| USR-T04 | active, no password → same (new link) | `admin.user.issueSetupLink` | `admin.users`, SOD-05 | no password set yet (`PASSWORD_ALREADY_SET`) | Earlier unused links deleted |

`deactivated` + `admin.user.deactivate` and `active` + `admin.user.reactivate` → `INVALID_TRANSITION`. `deactivated` + `admin.user.issueSetupLink` or `admin.role.grant` → `BUSINESS_RULE: USER_DEACTIVATED`.
