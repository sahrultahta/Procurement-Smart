-- Phase 8: runtime grants (ADR 0013) and database backstops for goods receipts (SQLSTATE PFG01),
-- and the purchase-order guards opened for receipts (PFC01). The application decides; these
-- triggers refuse what it must never write, for every role: the goods-receipt state machine
-- (docs/state-machines.md §6), SOD-04, frozen posted and cancelled receipts, reversals that mirror
-- the receipt they undo, received quantities that move only with posted receipts (GR-I1), and
-- receipt-driven PO statuses that follow the received quantities (PO-T06). "Today" depends on the
-- application clock, so the application checks that goods are not received in the future.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON goods_receipts TO procureflow_app;
--> statement-breakpoint
-- Lines are only added (to drafts): a draft is never edited, it is cancelled and recorded again.
GRANT SELECT, INSERT ON goods_receipt_lines TO procureflow_app;
--> statement-breakpoint
-- GR-I1: what the posted goods receipts of a purchase order line add up to, reversals subtracted.
CREATE FUNCTION goods_receipts_received_quantity(line_id uuid) RETURNS numeric
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(sum(CASE g.kind WHEN 'receipt' THEN l.quantity ELSE -l.quantity END), 0)
  FROM goods_receipt_lines l JOIN goods_receipts g ON g.id = l.goods_receipt_id
  WHERE l.purchase_order_line_id = line_id AND g.status = 'posted'
$$;
--> statement-breakpoint
-- PO-T06: every line received in full → received; anything received → partially received;
-- nothing → issued.
CREATE FUNCTION purchase_orders_receipt_status(order_id uuid) RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT CASE
    WHEN count(*) > 0 AND bool_and(received_qty >= quantity) THEN 'received'
    WHEN bool_or(received_qty > 0) THEN 'partially_received'
    ELSE 'issued'
  END
  FROM purchase_order_lines WHERE purchase_order_id = order_id
$$;
--> statement-breakpoint
-- A goods receipt is created as a draft for an issued or partially received order (a reversal:
-- for a posted receipt of an order that is not closed or cancelled), on or after the day the
-- order was issued, never by the order's creator (SOD-04). A draft is posted (by anyone but the
-- order's creator) or cancelled (by its creator); after that it never changes. A reversal has
-- exactly the lines of the receipt it reverses.
CREATE FUNCTION goods_receipts_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  po purchase_orders%ROWTYPE;
  original goods_receipts%ROWTYPE;
  issued_on date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'goods_receipts: goods receipts are cancelled or reversed, never deleted' USING ERRCODE = 'PFG01';
  END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = NEW.purchase_order_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'goods_receipts: a goods receipt starts as a draft' USING ERRCODE = 'PFG01';
    END IF;
    IF NEW.created_by_user_id = po.created_by_user_id THEN
      RAISE EXCEPTION 'goods_receipts: the creator of a purchase order cannot receive against it (SOD-04)' USING ERRCODE = 'PFG01';
    END IF;
    SELECT (po.issued_at AT TIME ZONE timezone)::date INTO issued_on FROM org_settings WHERE id = 1;
    IF issued_on IS NULL OR NEW.received_on < issued_on THEN
      RAISE EXCEPTION 'goods_receipts: goods are received on or after the day the purchase order was issued' USING ERRCODE = 'PFG01';
    END IF;
    IF NEW.kind = 'receipt' THEN
      IF po.status NOT IN ('issued', 'partially_received') THEN
        RAISE EXCEPTION 'goods_receipts: only an issued or partially received purchase order takes receipts' USING ERRCODE = 'PFG01';
      END IF;
    ELSE
      SELECT * INTO original FROM goods_receipts WHERE id = NEW.reverses_goods_receipt_id;
      IF original.kind IS DISTINCT FROM 'receipt' OR original.status IS DISTINCT FROM 'posted' OR original.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id THEN
        RAISE EXCEPTION 'goods_receipts: a reversal undoes a posted receipt of the same purchase order' USING ERRCODE = 'PFG01';
      END IF;
      IF po.status NOT IN ('issued', 'partially_received', 'received') THEN
        RAISE EXCEPTION 'goods_receipts: a receipt of a closed or cancelled purchase order cannot be reversed' USING ERRCODE = 'PFG01';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'goods_receipts: a posted or cancelled goods receipt never changes' USING ERRCODE = 'PFG01';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.reverses_goods_receipt_id IS DISTINCT FROM OLD.reverses_goods_receipt_id
    OR NEW.received_on IS DISTINCT FROM OLD.received_on
    OR NEW.delivery_note_ref IS DISTINCT FROM OLD.delivery_note_ref
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'goods_receipts: a draft is posted or cancelled, never edited' USING ERRCODE = 'PFG01';
  END IF;
  IF NEW.status = 'cancelled' THEN
    IF NEW.cancelled_by_user_id IS DISTINCT FROM NEW.created_by_user_id THEN
      RAISE EXCEPTION 'goods_receipts: only the user who recorded a draft cancels it' USING ERRCODE = 'PFG01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'posted' THEN
    RAISE EXCEPTION 'goods_receipts: a draft is posted or cancelled, never edited' USING ERRCODE = 'PFG01';
  END IF;
  IF NEW.posted_by_user_id = po.created_by_user_id THEN
    RAISE EXCEPTION 'goods_receipts: the creator of a purchase order cannot receive against it (SOD-04)' USING ERRCODE = 'PFG01';
  END IF;
  IF NOT EXISTS (SELECT FROM goods_receipt_lines WHERE goods_receipt_id = NEW.id) THEN
    RAISE EXCEPTION 'goods_receipts: a goods receipt has at least one line' USING ERRCODE = 'PFG01';
  END IF;
  IF NEW.kind = 'receipt' THEN
    IF po.status NOT IN ('issued', 'partially_received') THEN
      RAISE EXCEPTION 'goods_receipts: only an issued or partially received purchase order takes receipts' USING ERRCODE = 'PFG01';
    END IF;
  ELSE
    IF po.status NOT IN ('issued', 'partially_received', 'received') THEN
      RAISE EXCEPTION 'goods_receipts: a receipt of a closed or cancelled purchase order cannot be reversed' USING ERRCODE = 'PFG01';
    END IF;
    IF EXISTS (
      (SELECT purchase_order_line_id, quantity FROM goods_receipt_lines WHERE goods_receipt_id = NEW.id
       EXCEPT SELECT purchase_order_line_id, quantity FROM goods_receipt_lines WHERE goods_receipt_id = NEW.reverses_goods_receipt_id)
      UNION ALL
      (SELECT purchase_order_line_id, quantity FROM goods_receipt_lines WHERE goods_receipt_id = NEW.reverses_goods_receipt_id
       EXCEPT SELECT purchase_order_line_id, quantity FROM goods_receipt_lines WHERE goods_receipt_id = NEW.id)
    ) THEN
      RAISE EXCEPTION 'goods_receipts: a reversal has exactly the lines of the receipt it reverses' USING ERRCODE = 'PFG01';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER goods_receipts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_guard();
--> statement-breakpoint
-- Lines are added to drafts only, each for a line of the receipt's own purchase order.
CREATE FUNCTION goods_receipt_lines_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent goods_receipts%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'goods_receipt_lines: lines are added to a draft, never changed or deleted' USING ERRCODE = 'PFG01';
  END IF;
  SELECT * INTO parent FROM goods_receipts WHERE id = NEW.goods_receipt_id;
  IF parent.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'goods_receipt_lines: lines are added only while the goods receipt is a draft' USING ERRCODE = 'PFG01';
  END IF;
  IF (SELECT purchase_order_id FROM purchase_order_lines WHERE id = NEW.purchase_order_line_id) IS DISTINCT FROM parent.purchase_order_id THEN
    RAISE EXCEPTION 'goods_receipt_lines: the line belongs to another purchase order' USING ERRCODE = 'PFG01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER goods_receipt_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_guard();
--> statement-breakpoint
-- Checked at commit: a reversal is posted in the transaction that records it, and once a goods
-- receipt is posted, each of its lines' received quantity is what the posted receipts add up to
-- (GR-I1). With the purchase-order line guard, received quantities and documents move together.
CREATE FUNCTION goods_receipts_settled_check() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  gr goods_receipts%ROWTYPE;
  mismatched integer;
BEGIN
  SELECT * INTO gr FROM goods_receipts WHERE id = NEW.id;
  IF gr.kind = 'reversal' AND gr.status <> 'posted' THEN
    RAISE EXCEPTION 'goods_receipts: a reversal is posted in the transaction that records it' USING ERRCODE = 'PFG01';
  END IF;
  IF gr.status = 'posted' THEN
    SELECT pl.line_no INTO mismatched FROM purchase_order_lines pl
      WHERE pl.id IN (SELECT purchase_order_line_id FROM goods_receipt_lines WHERE goods_receipt_id = gr.id)
        AND pl.received_qty IS DISTINCT FROM goods_receipts_received_quantity(pl.id)
      LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'goods_receipts: the received quantity of purchase order line % does not match its posted goods receipts (GR-I1)', mismatched USING ERRCODE = 'PFG01';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER goods_receipts_settled
  AFTER INSERT OR UPDATE ON goods_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_settled_check();
--> statement-breakpoint
-- Purchase orders (0017), opened for goods receipts: between issued, partially received, and
-- received an order moves as its received quantities say (PO-T06), including updates that keep
-- the status (each posting changes the order's version).
CREATE OR REPLACE FUNCTION purchase_orders_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requisition purchase_requisitions%ROWTYPE;
  chosen quotations%ROWTYPE;
  approval_round approval_requests%ROWTYPE;
  settings org_settings%ROWTYPE;
  computed text[];
  estimate numeric;
BEGIN
  SELECT * INTO settings FROM org_settings WHERE id = 1;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'purchase_orders: purchase orders are cancelled, never deleted' USING ERRCODE = 'PFC01';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'purchase_orders: a purchase order starts as a draft' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.submitted_at IS NOT NULL OR NEW.current_approval_request_id IS NOT NULL OR cardinality(NEW.approval_reasons) > 0 OR NEW.approval_threshold IS NOT NULL THEN
      RAISE EXCEPTION 'purchase_orders: a new purchase order has not been submitted' USING ERRCODE = 'PFC01';
    END IF;
    SELECT * INTO requisition FROM purchase_requisitions WHERE id = NEW.requisition_id;
    IF requisition.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'purchase_orders: the requisition is not approved' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.department_id IS DISTINCT FROM requisition.department_id
      OR NEW.currency_code IS DISTINCT FROM requisition.currency_code
      OR NEW.currency_scale IS DISTINCT FROM requisition.currency_scale THEN
      RAISE EXCEPTION 'purchase_orders: department and currency are the requisition''s' USING ERRCODE = 'PFC01';
    END IF;
    IF (SELECT status FROM suppliers WHERE id = NEW.supplier_id) IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'purchase_orders: the supplier is not active' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.quotation_id IS NOT NULL THEN
      SELECT * INTO chosen FROM quotations WHERE id = NEW.quotation_id;
      IF chosen.status IS DISTINCT FROM 'awarded'
        OR chosen.supplier_id IS DISTINCT FROM NEW.supplier_id
        OR (SELECT requisition_id FROM rfqs WHERE id = chosen.rfq_id) IS DISTINCT FROM NEW.requisition_id THEN
        RAISE EXCEPTION 'purchase_orders: the quotation must be an awarded quotation of this supplier for this requisition' USING ERRCODE = 'PFC01';
      END IF;
    ELSIF settings.rfq_required_above IS NOT NULL AND requisition.estimated_total >= settings.rfq_required_above THEN
      RAISE EXCEPTION 'purchase_orders: at or above the RFQ threshold, a purchase order comes from an awarded quotation' USING ERRCODE = 'PFC01';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.requisition_id IS DISTINCT FROM OLD.requisition_id
    OR NEW.department_id IS DISTINCT FROM OLD.department_id
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.quotation_id IS DISTINCT FROM OLD.quotation_id
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.currency_scale IS DISTINCT FROM OLD.currency_scale
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'purchase_orders: number, requisition, department, supplier, quotation, currency, creator, and creation time cannot change' USING ERRCODE = 'PFC01';
  END IF;
  -- Between issued, partially received, and received the received quantities decide (PO-T06).
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft', 'pending_approval', 'approved', 'cancelled'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'draft', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('issued', 'cancelled'))
    OR (OLD.status IN ('issued', 'partially_received', 'received') AND NEW.status IN ('issued', 'partially_received', 'received'))
    OR (OLD.status = 'issued' AND NEW.status IN ('closed', 'cancelled'))
    OR (OLD.status IN ('partially_received', 'received') AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'purchase_orders: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'PFC01';
  END IF;
  IF OLD.status IN ('issued', 'partially_received', 'received') AND NEW.status IN ('issued', 'partially_received', 'received')
    AND NEW.status IS DISTINCT FROM purchase_orders_receipt_status(NEW.id) THEN
    RAISE EXCEPTION 'purchase_orders: with what was received, the purchase order is %, not %', purchase_orders_receipt_status(NEW.id), NEW.status USING ERRCODE = 'PFC01';
  END IF;
  IF NOT (OLD.status = 'draft' AND NEW.status = 'draft') AND (
    NEW.payment_terms IS DISTINCT FROM OLD.payment_terms
    OR NEW.delivery_address IS DISTINCT FROM OLD.delivery_address
    OR NEW.expected_delivery_date IS DISTINCT FROM OLD.expected_delivery_date
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
    OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
    OR NEW.total IS DISTINCT FROM OLD.total
  ) THEN
    RAISE EXCEPTION 'purchase_orders: terms and totals change only while the purchase order is a draft' USING ERRCODE = 'PFC01';
  END IF;

  -- Submitting (PO-T03): the creator submits, the supplier is active, and the stored reasons are
  -- exactly what the stored threshold and tolerance give for these lines.
  IF OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'approved') THEN
    IF NEW.submitted_by_user_id IS DISTINCT FROM NEW.created_by_user_id THEN
      RAISE EXCEPTION 'purchase_orders: only the creator submits a purchase order' USING ERRCODE = 'PFC01';
    END IF;
    IF (SELECT status FROM suppliers WHERE id = NEW.supplier_id) IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'purchase_orders: the supplier is not active' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.quotation_id IS NULL AND settings.rfq_required_above IS NOT NULL
      AND (SELECT estimated_total FROM purchase_requisitions WHERE id = NEW.requisition_id) >= settings.rfq_required_above THEN
      RAISE EXCEPTION 'purchase_orders: at or above the RFQ threshold, a purchase order comes from an awarded quotation' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.approval_threshold IS DISTINCT FROM settings.po_approval_threshold OR NEW.price_tolerance_pct IS DISTINCT FROM settings.po_price_tolerance_pct THEN
      RAISE EXCEPTION 'purchase_orders: the stored approval rule must be the one in the settings' USING ERRCODE = 'PFC01';
    END IF;
    computed := ARRAY[]::text[];
    IF NEW.approval_threshold IS NULL THEN
      computed := computed || 'NO_THRESHOLD'::text;
    ELSIF NEW.total >= NEW.approval_threshold THEN
      computed := computed || 'AMOUNT_THRESHOLD'::text;
    END IF;
    IF EXISTS (
      SELECT FROM purchase_order_lines l JOIN requisition_lines r ON r.id = l.requisition_line_id
      WHERE l.purchase_order_id = NEW.id AND l.unit_price > r.estimated_unit_price * (1 + NEW.price_tolerance_pct / 100)
    ) THEN
      computed := computed || 'PRICE_VARIANCE'::text;
    END IF;
    SELECT coalesce(sum(round(l.quantity * r.estimated_unit_price, NEW.currency_scale)), 0) INTO estimate
      FROM purchase_order_lines l JOIN requisition_lines r ON r.id = l.requisition_line_id
      WHERE l.purchase_order_id = NEW.id;
    IF NEW.subtotal > estimate * (1 + NEW.price_tolerance_pct / 100) THEN
      computed := computed || 'TOTAL_VARIANCE'::text;
    END IF;
    IF NOT (NEW.approval_reasons @> computed AND NEW.approval_reasons <@ computed) THEN
      RAISE EXCEPTION 'purchase_orders: the approval reasons do not match the stored rule' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.status = 'approved' AND cardinality(computed) > 0 THEN
      RAISE EXCEPTION 'purchase_orders: a purchase order that needs approval cannot be approved on submit' USING ERRCODE = 'PFC01';
    END IF;
  ELSIF NEW.approval_reasons IS DISTINCT FROM OLD.approval_reasons
    OR NEW.approval_threshold IS DISTINCT FROM OLD.approval_threshold
    OR NEW.price_tolerance_pct IS DISTINCT FROM OLD.price_tolerance_pct
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id THEN
    RAISE EXCEPTION 'purchase_orders: the submission changes only when the purchase order is submitted' USING ERRCODE = 'PFC01';
  END IF;

  -- The approval round (AP-T01): a pending round of this order, submitted by its creator, naming
  -- the buyer who awarded its quotation (SOD-06), for its total and department.
  IF OLD.status = 'draft' AND NEW.status = 'pending_approval' THEN
    SELECT * INTO approval_round FROM approval_requests WHERE id = NEW.current_approval_request_id;
    IF approval_round.document_type IS DISTINCT FROM 'purchase_order' OR approval_round.document_id IS DISTINCT FROM NEW.id OR approval_round.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'purchase_orders: the approval round must be a pending round of this purchase order' USING ERRCODE = 'PFC01';
    END IF;
    IF approval_round.submitted_by_user_id IS DISTINCT FROM NEW.created_by_user_id
      OR approval_round.awarded_by_user_id IS DISTINCT FROM (SELECT r.awarded_by_user_id FROM quotations q JOIN rfqs r ON r.id = q.rfq_id WHERE q.id = NEW.quotation_id) THEN
      RAISE EXCEPTION 'purchase_orders: the approval round must exclude the creator and the buyer who awarded the quotation' USING ERRCODE = 'PFC01';
    END IF;
    IF approval_round.amount_snapshot IS DISTINCT FROM NEW.total OR approval_round.department_id IS DISTINCT FROM NEW.department_id THEN
      RAISE EXCEPTION 'purchase_orders: the approval round must be for this total and department' USING ERRCODE = 'PFC01';
    END IF;
  ELSIF NEW.current_approval_request_id IS DISTINCT FROM OLD.current_approval_request_id THEN
    RAISE EXCEPTION 'purchase_orders: the approval round changes only when the purchase order is submitted' USING ERRCODE = 'PFC01';
  END IF;
  -- PO-T04 and withdrawal: the order follows how its round ended.
  IF OLD.status = 'pending_approval' AND NEW.status <> 'pending_approval'
    AND (SELECT status FROM approval_requests WHERE id = NEW.current_approval_request_id) IS DISTINCT FROM
      (CASE NEW.status WHEN 'approved' THEN 'approved' WHEN 'draft' THEN 'returned' WHEN 'rejected' THEN 'rejected' ELSE 'cancelled' END) THEN
    RAISE EXCEPTION 'purchase_orders: a purchase order waiting for approval follows its approval round' USING ERRCODE = 'PFC01';
  END IF;
  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at AND NOT (OLD.status IN ('draft', 'pending_approval') AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'purchase_orders: the approval time is set once, when the purchase order is approved' USING ERRCODE = 'PFC01';
  END IF;

  -- Issuing (PO-T05): the supplier is still active; the issue fields are set once.
  IF OLD.status = 'approved' AND NEW.status = 'issued' THEN
    IF (SELECT status FROM suppliers WHERE id = NEW.supplier_id) IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'purchase_orders: the supplier is not active' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.receipt_tolerance_pct IS DISTINCT FROM settings.over_receipt_tolerance_pct THEN
      RAISE EXCEPTION 'purchase_orders: the receipt tolerance must be the one in the settings' USING ERRCODE = 'PFC01';
    END IF;
  ELSIF NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.issued_by_user_id IS DISTINCT FROM OLD.issued_by_user_id
    OR NEW.receipt_tolerance_pct IS DISTINCT FROM OLD.receipt_tolerance_pct THEN
    RAISE EXCEPTION 'purchase_orders: the issue changes only when the purchase order is issued' USING ERRCODE = 'PFC01';
  END IF;
  -- PO-T09: an issued order is cancelled only while nothing was received.
  IF OLD.status = 'issued' AND NEW.status = 'cancelled'
    AND EXISTS (SELECT FROM purchase_order_lines WHERE purchase_order_id = NEW.id AND received_qty <> 0) THEN
    RAISE EXCEPTION 'purchase_orders: a purchase order with receipts cannot be cancelled' USING ERRCODE = 'PFC01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- After issue, a line changes only to fix its receivable quantity (once, at issue) or to take the
-- received quantity its posted goods receipts add up to (GR-I1): the receipts are posted first,
-- in the same transaction.
CREATE OR REPLACE FUNCTION purchase_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent purchase_orders%ROWTYPE;
  source requisition_lines%ROWTYPE;
  quoted quotation_lines%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM purchase_orders WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_order_id ELSE NEW.purchase_order_id END;
  IF TG_OP = 'UPDATE'
    AND ROW(NEW.id, NEW.purchase_order_id, NEW.line_no, NEW.requisition_line_id, NEW.quotation_line_id, NEW.description, NEW.uom, NEW.quantity,
            NEW.unit_price, NEW.tax_rate_pct, NEW.line_subtotal, NEW.line_tax, NEW.line_total)
      IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.purchase_order_id, OLD.line_no, OLD.requisition_line_id, OLD.quotation_line_id, OLD.description, OLD.uom, OLD.quantity,
            OLD.unit_price, OLD.tax_rate_pct, OLD.line_subtotal, OLD.line_tax, OLD.line_total)
    AND parent.status IS DISTINCT FROM 'draft' THEN
    IF NEW.received_qty = OLD.received_qty AND OLD.max_receivable_qty IS NULL AND parent.status = 'issued'
      AND NEW.max_receivable_qty = floor(NEW.quantity * (1 + parent.receipt_tolerance_pct / 100) * 1000) / 1000 THEN
      RETURN NEW;
    END IF;
    IF NEW.max_receivable_qty IS NOT DISTINCT FROM OLD.max_receivable_qty AND NEW.received_qty <> OLD.received_qty
      AND parent.status IN ('issued', 'partially_received', 'received')
      AND NEW.received_qty = goods_receipts_received_quantity(NEW.id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'purchase_order_lines: after issue, only the receivable quantity (once, at issue) and the received quantity (with posted goods receipts) change' USING ERRCODE = 'PFC01';
  END IF;
  IF parent.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'purchase_order_lines: lines change only while the purchase order is a draft' USING ERRCODE = 'PFC01';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id THEN
    RAISE EXCEPTION 'purchase_order_lines: a line cannot move to another purchase order' USING ERRCODE = 'PFC01';
  END IF;
  IF (SELECT status FROM purchase_requisitions WHERE id = parent.requisition_id) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'purchase_order_lines: the requisition is no longer approved' USING ERRCODE = 'PFC01';
  END IF;
  IF NEW.received_qty <> 0 OR NEW.max_receivable_qty IS NOT NULL THEN
    RAISE EXCEPTION 'purchase_order_lines: a draft line has nothing received and no receivable quantity' USING ERRCODE = 'PFC01';
  END IF;
  SELECT * INTO source FROM requisition_lines WHERE id = NEW.requisition_line_id;
  IF source.requisition_id IS DISTINCT FROM parent.requisition_id THEN
    RAISE EXCEPTION 'purchase_order_lines: the line belongs to another requisition' USING ERRCODE = 'PFC01';
  END IF;
  IF NEW.description IS DISTINCT FROM source.description OR NEW.uom IS DISTINCT FROM source.uom THEN
    RAISE EXCEPTION 'purchase_order_lines: description and unit come from the requisition line' USING ERRCODE = 'PFC01';
  END IF;
  IF parent.quotation_id IS NULL THEN
    IF NEW.quotation_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'purchase_order_lines: a purchase order without a quotation has no quotation lines' USING ERRCODE = 'PFC01';
    END IF;
  ELSE
    SELECT * INTO quoted FROM quotation_lines WHERE id = NEW.quotation_line_id;
    IF quoted.quotation_id IS DISTINCT FROM parent.quotation_id
      OR (SELECT requisition_line_id FROM rfq_lines WHERE id = quoted.rfq_line_id) IS DISTINCT FROM NEW.requisition_line_id THEN
      RAISE EXCEPTION 'purchase_order_lines: the line must be the quotation''s line for the same requisition line' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.unit_price IS DISTINCT FROM quoted.unit_price THEN
      RAISE EXCEPTION 'purchase_order_lines: the unit price comes from the quotation' USING ERRCODE = 'PFC01';
    END IF;
    IF NEW.quantity > quoted.quantity THEN
      RAISE EXCEPTION 'purchase_order_lines: the quantity is more than the quotation covers' USING ERRCODE = 'PFC01';
    END IF;
  END IF;
  IF NEW.line_subtotal IS DISTINCT FROM round(NEW.quantity * NEW.unit_price, parent.currency_scale)
    OR NEW.line_tax IS DISTINCT FROM round(NEW.line_subtotal * NEW.tax_rate_pct / 100, parent.currency_scale) THEN
    RAISE EXCEPTION 'purchase_order_lines: subtotal and tax are round(quantity × unit price) and round(subtotal × rate / 100) at the currency scale' USING ERRCODE = 'PFC01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- At commit, also: an issued order's status is what its received quantities say (PO-T06).
CREATE OR REPLACE FUNCTION purchase_orders_totals_check() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
  po purchase_orders%ROWTYPE;
  sum_subtotal numeric;
  sum_tax numeric;
  sum_total numeric;
  line_count integer;
BEGIN
  IF TG_TABLE_NAME = 'purchase_orders' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.purchase_order_id;
  ELSE
    target := NEW.purchase_order_id;
  END IF;
  SELECT * INTO po FROM purchase_orders WHERE id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*), coalesce(sum(line_subtotal), 0), coalesce(sum(line_tax), 0), coalesce(sum(line_total), 0)
    INTO line_count, sum_subtotal, sum_tax, sum_total
    FROM purchase_order_lines WHERE purchase_order_id = po.id;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'purchase_orders: a purchase order has at least one line' USING ERRCODE = 'PFC01';
  END IF;
  IF po.subtotal IS DISTINCT FROM sum_subtotal OR po.tax_total IS DISTINCT FROM sum_tax OR po.total IS DISTINCT FROM sum_total THEN
    RAISE EXCEPTION 'purchase_orders: the totals are the sums of the line amounts' USING ERRCODE = 'PFC01';
  END IF;
  IF po.status IN ('issued', 'partially_received', 'received', 'closed')
    AND EXISTS (SELECT FROM purchase_order_lines WHERE purchase_order_id = po.id AND max_receivable_qty IS NULL) THEN
    RAISE EXCEPTION 'purchase_orders: every line of an issued purchase order has its receivable quantity' USING ERRCODE = 'PFC01';
  END IF;
  IF po.status IN ('issued', 'partially_received', 'received') AND po.status IS DISTINCT FROM purchase_orders_receipt_status(po.id) THEN
    RAISE EXCEPTION 'purchase_orders: an issued purchase order''s status follows its received quantities (PO-T06)' USING ERRCODE = 'PFC01';
  END IF;
  RETURN NULL;
END
$$;
