-- Phase 7: runtime grants (ADR 0013) and database backstops for purchase orders (SQLSTATE PFC01).
-- The application decides; these triggers refuse what it must never write, for every role:
-- the state machine (docs/state-machines.md §5), frozen identity and issued content, prices from
-- the awarded quotation, ADR 0007 amounts, RFQ_REQUIRED, the approval rule and the receipt
-- tolerance as the settings say (the commands hold a shared lock on them), the reasons
-- recomputed from the lines, SOD-01 / SOD-06 on the approval round, and PO-I1 at commit.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON purchase_orders TO procureflow_app;
--> statement-breakpoint
-- DELETE only because draft lines are replaced on edit; the trigger below limits it to drafts.
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_lines TO procureflow_app;
--> statement-breakpoint
-- A purchase order is created as a draft of an approved requisition, for an active supplier, in
-- the requisition's department and currency, from an awarded quotation of that supplier and
-- requisition if it has one. It keeps its identity and moves only along PO-T01 to T09.
CREATE FUNCTION purchase_orders_guard() RETURNS trigger
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
  -- Receipt-driven statuses (PO-T06) arrive with goods receipts in Phase 8.
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft', 'pending_approval', 'approved', 'cancelled'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'draft', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('issued', 'cancelled'))
    OR (OLD.status = 'issued' AND NEW.status IN ('closed', 'cancelled'))
    OR (OLD.status IN ('partially_received', 'received') AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'purchase_orders: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'PFC01';
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
CREATE TRIGGER purchase_orders_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard();
--> statement-breakpoint
-- Lines change only in drafts of a still-approved requisition. Each one orders a line of the
-- PO's requisition with its description and unit; with a quotation, at the quoted price and for
-- no more than the quoted quantity; amounts per ADR 0007 (round() on numeric rounds half away
-- from zero, which is half-up for amounts >= 0). Once issued, the only change is fixing
-- max_receivable_qty, once, at floor3(quantity × (1 + receipt tolerance / 100)).
CREATE FUNCTION purchase_order_lines_guard() RETURNS trigger
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
            NEW.unit_price, NEW.tax_rate_pct, NEW.line_subtotal, NEW.line_tax, NEW.line_total, NEW.received_qty)
      IS NOT DISTINCT FROM
        ROW(OLD.id, OLD.purchase_order_id, OLD.line_no, OLD.requisition_line_id, OLD.quotation_line_id, OLD.description, OLD.uom, OLD.quantity,
            OLD.unit_price, OLD.tax_rate_pct, OLD.line_subtotal, OLD.line_tax, OLD.line_total, OLD.received_qty)
    AND parent.status IS DISTINCT FROM 'draft' THEN
    IF OLD.max_receivable_qty IS NULL AND parent.status = 'issued'
      AND NEW.max_receivable_qty = floor(NEW.quantity * (1 + parent.receipt_tolerance_pct / 100) * 1000) / 1000 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'purchase_order_lines: the receivable quantity is fixed once, when the purchase order is issued' USING ERRCODE = 'PFC01';
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
CREATE TRIGGER purchase_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();
--> statement-breakpoint
-- Checked at commit, once the header and its lines are both written (PO-I2): at least one line,
-- totals that are the sums of the line amounts, and a receivable quantity on every line of an
-- issued order.
CREATE FUNCTION purchase_orders_totals_check() RETURNS trigger
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
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER purchase_orders_totals
  AFTER INSERT OR UPDATE ON purchase_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_totals_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER purchase_order_lines_totals
  AFTER INSERT OR UPDATE OR DELETE ON purchase_order_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_totals_check();
--> statement-breakpoint
-- PO-I1, checked at commit for every requisition line a transaction touched: its ordered
-- quantity is the sum of its PO lines on orders that are not cancelled or rejected, counting a
-- closed order's line only up to what was received.
CREATE FUNCTION purchase_orders_ordered_quantity_check() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  line_ids uuid[];
  mismatched integer;
BEGIN
  IF TG_TABLE_NAME = 'requisition_lines' THEN
    line_ids := ARRAY[NEW.id];
  ELSIF TG_TABLE_NAME = 'purchase_order_lines' THEN
    line_ids := CASE TG_OP
      WHEN 'DELETE' THEN ARRAY[OLD.requisition_line_id]
      WHEN 'UPDATE' THEN ARRAY[OLD.requisition_line_id, NEW.requisition_line_id]
      ELSE ARRAY[NEW.requisition_line_id]
    END;
  ELSE
    line_ids := ARRAY(SELECT requisition_line_id FROM purchase_order_lines WHERE purchase_order_id = NEW.id);
  END IF;
  SELECT r.line_no INTO mismatched FROM requisition_lines r
    WHERE r.id = ANY (line_ids)
      AND r.ordered_qty IS DISTINCT FROM (
        SELECT coalesce(sum(CASE WHEN po.status = 'closed' THEN least(l.quantity, l.received_qty) ELSE l.quantity END), 0)
        FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
        WHERE l.requisition_line_id = r.id AND po.status NOT IN ('cancelled', 'rejected')
      )
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'purchase_orders: the ordered quantity of requisition line % does not match its purchase orders (PO-I1)', mismatched USING ERRCODE = 'PFC01';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER requisition_lines_ordered_quantity
  AFTER UPDATE OF ordered_qty ON requisition_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_ordered_quantity_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER purchase_order_lines_ordered_quantity
  AFTER INSERT OR UPDATE OR DELETE ON purchase_order_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_ordered_quantity_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER purchase_orders_ordered_quantity
  AFTER UPDATE OF status ON purchase_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_ordered_quantity_check();
