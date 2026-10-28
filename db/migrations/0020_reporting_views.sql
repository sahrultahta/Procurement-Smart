-- Phase 9: the reporting module's contract (docs/architecture.md). Reporting reads only these
-- views, never the tables behind them, and never writes. Dates are org dates (org_settings.timezone).
-- Money is rounded per line as ADR 0007 does it: round(qty × price, scale) plus
-- round(that × tax rate / 100, scale), half up (round() on a non-negative numeric).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
-- The organization settings reports need: time zone and the two thresholds (decision 5).
CREATE VIEW report_org_settings AS
SELECT s.timezone, s.currency_code, s.currency_scale, s.rfq_required_above, s.po_approval_threshold
FROM org_settings s;
--> statement-breakpoint
-- Audit search (decision 7): every event with the actor's display name. NULL actor: the system.
CREATE VIEW report_audit_events AS
SELECT e.id, e.occurred_at, e.actor_user_id, u.name AS actor_name, e.actor_roles, e.action, e.entity_type, e.entity_id,
  e.changes, e.reason, e.request_id, host(e.ip) AS ip, e.user_agent
FROM audit_events e
LEFT JOIN users u ON u.id::text = e.actor_user_id;
--> statement-breakpoint
-- The people audit search can filter by.
CREATE VIEW report_users AS
SELECT u.id, u.name FROM users u;
--> statement-breakpoint
-- Spend, issued basis (decision 2): each issued order's full total on its issue date. Orders closed
-- short keep their full total; cancelled orders do not count.
CREATE VIEW report_spend_issued AS
SELECT po.id AS purchase_order_id, po.number, po.supplier_id, sup.code AS supplier_code, sup.legal_name AS supplier_name,
  po.department_id, d.code AS department_code, d.name AS department_name, po.currency_code, po.currency_scale,
  (po.issued_at AT TIME ZONE s.timezone)::date AS spend_on, po.total AS amount
FROM purchase_orders po
JOIN suppliers sup ON sup.id = po.supplier_id
JOIN departments d ON d.id = po.department_id
CROSS JOIN org_settings s
WHERE po.issued_at IS NOT NULL AND po.status <> 'cancelled';
--> statement-breakpoint
-- Spend, received basis (decision 3): each posted receipt line at the order line's price plus tax, on
-- the receipt's date. A reversal counts negative on its own date. Over-receipts count as received.
CREATE VIEW report_spend_received AS
SELECT gr.id AS goods_receipt_id, gr.number AS goods_receipt_number, po.id AS purchase_order_id, po.number,
  po.supplier_id, sup.code AS supplier_code, sup.legal_name AS supplier_name,
  po.department_id, d.code AS department_code, d.name AS department_name, po.currency_code, po.currency_scale,
  gr.received_on AS spend_on,
  CASE gr.kind WHEN 'reversal' THEN -1 ELSE 1 END * (v.subtotal + round(v.subtotal * pol.tax_rate_pct / 100, po.currency_scale)) AS amount
FROM goods_receipt_lines grl
JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id
JOIN purchase_order_lines pol ON pol.id = grl.purchase_order_line_id
JOIN purchase_orders po ON po.id = pol.purchase_order_id
JOIN suppliers sup ON sup.id = po.supplier_id
JOIN departments d ON d.id = po.department_id
CROSS JOIN LATERAL (SELECT round(grl.quantity * pol.unit_price, po.currency_scale) AS subtotal) v
WHERE gr.status = 'posted';
--> statement-breakpoint
-- Requisition cycle time (decision 4): from the first submission (round 1 of its approval) to the
-- final approval, for every requisition that was approved.
CREATE VIEW report_requisition_cycle AS
SELECT pr.id AS requisition_id, pr.number, pr.department_id, d.code AS department_code, d.name AS department_name,
  first_round.submitted_at, pr.approved_at, (pr.approved_at AT TIME ZONE s.timezone)::date AS approved_on,
  EXTRACT(EPOCH FROM pr.approved_at - first_round.submitted_at) AS cycle_seconds
FROM purchase_requisitions pr
JOIN departments d ON d.id = pr.department_id
JOIN LATERAL (
  SELECT min(ar.created_at) AS submitted_at FROM approval_requests ar
  WHERE ar.document_type = 'requisition' AND ar.document_id = pr.id
) first_round ON first_round.submitted_at IS NOT NULL
CROSS JOIN org_settings s
WHERE pr.approved_at IS NOT NULL;
--> statement-breakpoint
-- Approval aging: every step open for a decision, with what it is about.
CREATE VIEW report_pending_approval_steps AS
SELECT st.id AS step_id, ar.id AS approval_request_id, ar.document_type, ar.document_id, ar.document_number, ar.document_title,
  ar.amount_snapshot, ar.currency_code, ar.currency_scale, ar.department_id, d.code AS department_code, d.name AS department_name,
  st.step_no, st.required_role, st.activated_at
FROM approval_steps st
JOIN approval_requests ar ON ar.id = st.approval_request_id
JOIN departments d ON d.id = ar.department_id
WHERE st.status = 'pending';
--> statement-breakpoint
-- Open purchase orders: every line of an order that still takes receipts, with what is outstanding
-- (never negative: over-received lines are not outstanding).
CREATE VIEW report_open_order_lines AS
SELECT po.id AS purchase_order_id, po.number, po.status, po.supplier_id, sup.code AS supplier_code, sup.legal_name AS supplier_name,
  po.department_id, d.code AS department_code, d.name AS department_name, po.currency_code, po.currency_scale,
  (po.issued_at AT TIME ZONE s.timezone)::date AS issued_on, po.expected_delivery_date,
  pol.id AS line_id, pol.line_no, pol.description, pol.uom, pol.quantity, pol.received_qty, o.outstanding_qty,
  v.subtotal + round(v.subtotal * pol.tax_rate_pct / 100, po.currency_scale) AS outstanding_amount
FROM purchase_orders po
JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
JOIN suppliers sup ON sup.id = po.supplier_id
JOIN departments d ON d.id = po.department_id
CROSS JOIN org_settings s
CROSS JOIN LATERAL (SELECT greatest(pol.quantity - pol.received_qty, 0) AS outstanding_qty) o
CROSS JOIN LATERAL (SELECT round(o.outstanding_qty * pol.unit_price, po.currency_scale) AS subtotal) v
WHERE po.status IN ('issued', 'partially_received');
--> statement-breakpoint
-- Potential split purchases (decision 5): every order that was approved and not cancelled, with its
-- requisition's requester, its subtotal (RFQ threshold), and its total (approval threshold).
CREATE VIEW report_split_candidates AS
SELECT po.id AS purchase_order_id, po.number, po.status, po.quotation_id IS NOT NULL AS from_quotation,
  pr.id AS requisition_id, pr.number AS requisition_number, pr.requester_user_id, u.name AS requester_name,
  po.supplier_id, sup.code AS supplier_code, sup.legal_name AS supplier_name, po.currency_code, po.currency_scale,
  po.subtotal, po.total, (po.approved_at AT TIME ZONE s.timezone)::date AS approved_on
FROM purchase_orders po
JOIN purchase_requisitions pr ON pr.id = po.requisition_id
JOIN users u ON u.id = pr.requester_user_id
JOIN suppliers sup ON sup.id = po.supplier_id
CROSS JOIN org_settings s
WHERE po.approved_at IS NOT NULL AND po.status IN ('approved', 'issued', 'partially_received', 'received', 'closed');
--> statement-breakpoint
-- Runtime role: read the views, nothing else is new (ADR 0013).
GRANT SELECT ON report_org_settings, report_audit_events, report_users, report_spend_issued, report_spend_received,
  report_requisition_cycle, report_pending_approval_steps, report_open_order_lines, report_split_candidates TO procureflow_app;
