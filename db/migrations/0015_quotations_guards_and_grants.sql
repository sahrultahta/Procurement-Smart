-- Phase 6b: runtime grants (ADR 0013) and database backstops for quotations (SQLSTATE PFB02) and
-- the award (rfqs_guard, PFB01). Expiry and "lowest valid price" depend on the application clock
-- and the org time zone, so the application checks them; the database checks everything else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON quotations TO procureflow_app;
--> statement-breakpoint
-- DELETE only because draft lines are replaced on edit; the trigger below limits it to drafts.
GRANT SELECT, INSERT, UPDATE, DELETE ON quotation_lines TO procureflow_app;
--> statement-breakpoint
-- As in 0013, plus: closing leaves no draft quotation behind, and an award names a submitted
-- quotation of this RFQ from an active supplier, on a requisition still approved, with a
-- "fewer than the minimum" flag that matches the rule it stored.
CREATE OR REPLACE FUNCTION rfqs_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  chosen quotations%ROWTYPE;
  requisition purchase_requisitions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rfqs: RFQs are cancelled, never deleted' USING ERRCODE = 'PFB01';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'rfqs: an RFQ starts as a draft' USING ERRCODE = 'PFB01';
    END IF;
    IF (SELECT status FROM purchase_requisitions WHERE id = NEW.requisition_id) IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'rfqs: the requisition is not approved' USING ERRCODE = 'PFB01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.requisition_id IS DISTINCT FROM OLD.requisition_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'rfqs: number, requisition, creator, and creation time cannot change' USING ERRCODE = 'PFB01';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft', 'issued', 'cancelled'))
    OR (OLD.status = 'issued' AND NEW.status IN ('closed', 'cancelled'))
    OR (OLD.status = 'closed' AND NEW.status IN ('awarded', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'rfqs: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'PFB01';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.response_due_at IS DISTINCT FROM OLD.response_due_at) THEN
    RAISE EXCEPTION 'rfqs: title and due date change only while the RFQ is a draft' USING ERRCODE = 'PFB01';
  END IF;
  IF NEW.status = 'issued' AND OLD.status = 'draft'
    AND (SELECT status FROM purchase_requisitions WHERE id = NEW.requisition_id) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'rfqs: the requisition is not approved' USING ERRCODE = 'PFB01';
  END IF;
  IF NEW.status = 'closed' AND OLD.status = 'issued'
    AND EXISTS (SELECT FROM quotations WHERE rfq_id = NEW.id AND status = 'draft') THEN
    RAISE EXCEPTION 'rfqs: discard the draft quotations before closing' USING ERRCODE = 'PFB01';
  END IF;
  IF NEW.status = 'awarded' THEN
    SELECT * INTO requisition FROM purchase_requisitions WHERE id = NEW.requisition_id;
    IF requisition.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'rfqs: the requisition is not approved' USING ERRCODE = 'PFB01';
    END IF;
    SELECT * INTO chosen FROM quotations WHERE id = NEW.awarded_quotation_id;
    IF chosen.rfq_id IS DISTINCT FROM NEW.id OR chosen.status IS DISTINCT FROM 'submitted' THEN
      RAISE EXCEPTION 'rfqs: the awarded quotation must be a submitted quotation of this RFQ' USING ERRCODE = 'PFB01';
    END IF;
    IF (SELECT status FROM suppliers WHERE id = chosen.supplier_id) IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'rfqs: the awarded supplier is not active' USING ERRCODE = 'PFB01';
    END IF;
    IF NEW.award_valid_quotes > (SELECT count(*) FROM quotations WHERE rfq_id = NEW.id AND status = 'submitted') THEN
      RAISE EXCEPTION 'rfqs: more valid quotations than were submitted' USING ERRCODE = 'PFB01';
    END IF;
    IF NEW.award_below_min_quotes IS DISTINCT FROM (
      NEW.award_rfq_required_above IS NOT NULL
      AND requisition.estimated_total >= NEW.award_rfq_required_above
      AND NEW.award_valid_quotes < NEW.award_min_quotes
    ) THEN
      RAISE EXCEPTION 'rfqs: the minimum-quotations flag does not match the stored rule' USING ERRCODE = 'PFB01';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A quotation is recorded as a draft, while the RFQ is issued, from an active supplier, in the
-- requisition's currency. It keeps its identity, moves only along docs/state-machines.md §4, and
-- its terms change only while it is a draft. Awarded and not awarded follow the RFQ's award.
CREATE FUNCTION quotations_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent rfqs%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quotations: quotations are withdrawn, never deleted' USING ERRCODE = 'PFB02';
  END IF;
  SELECT * INTO parent FROM rfqs WHERE id = NEW.rfq_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'quotations: a quotation starts as a draft' USING ERRCODE = 'PFB02';
    END IF;
    IF parent.status IS DISTINCT FROM 'issued' THEN
      RAISE EXCEPTION 'quotations: quotations are recorded only while the RFQ is issued' USING ERRCODE = 'PFB02';
    END IF;
    IF (SELECT status FROM suppliers WHERE id = NEW.supplier_id) IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'quotations: the supplier is not active' USING ERRCODE = 'PFB02';
    END IF;
    IF NEW.currency_code IS DISTINCT FROM (SELECT currency_code FROM purchase_requisitions WHERE id = parent.requisition_id) THEN
      RAISE EXCEPTION 'quotations: the currency is the requisition''s' USING ERRCODE = 'PFB02';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.rfq_id IS DISTINCT FROM OLD.rfq_id
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'quotations: RFQ, supplier, currency, recorder, and creation time cannot change' USING ERRCODE = 'PFB02';
  END IF;
  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft', 'submitted', 'withdrawn'))
    OR (OLD.status = 'submitted' AND NEW.status IN ('withdrawn', 'awarded', 'not_awarded'))
  ) THEN
    RAISE EXCEPTION 'quotations: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'PFB02';
  END IF;
  IF (OLD.status <> 'draft' OR NEW.status <> 'draft') AND (
    NEW.supplier_reference IS DISTINCT FROM OLD.supplier_reference
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.lead_time_days IS DISTINCT FROM OLD.lead_time_days
    OR NEW.total IS DISTINCT FROM OLD.total
  ) THEN
    RAISE EXCEPTION 'quotations: the terms change only while the quotation is a draft' USING ERRCODE = 'PFB02';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id) THEN
    RAISE EXCEPTION 'quotations: the submission cannot change' USING ERRCODE = 'PFB02';
  END IF;
  IF NEW.status IN ('draft', 'submitted') AND parent.status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'quotations: drafts change and are submitted only while the RFQ is issued' USING ERRCODE = 'PFB02';
  END IF;
  IF NEW.status = 'submitted' AND OLD.status = 'draft'
    AND (SELECT status FROM suppliers WHERE id = NEW.supplier_id) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'quotations: the supplier is not active' USING ERRCODE = 'PFB02';
  END IF;
  IF NEW.status = 'withdrawn' AND NOT (
    (OLD.status = 'draft' AND parent.status = 'issued')
    OR (OLD.status = 'submitted' AND parent.status IN ('issued', 'closed'))
  ) THEN
    RAISE EXCEPTION 'quotations: a % quotation cannot be withdrawn from a % RFQ', OLD.status, parent.status USING ERRCODE = 'PFB02';
  END IF;
  IF NEW.status = 'awarded' AND (parent.status IS DISTINCT FROM 'awarded' OR parent.awarded_quotation_id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'quotations: only the quotation the RFQ awarded is awarded' USING ERRCODE = 'PFB02';
  END IF;
  IF NEW.status = 'not_awarded' AND (parent.status IS DISTINCT FROM 'awarded' OR parent.awarded_quotation_id IS NOT DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'quotations: only the other quotations of an awarded RFQ are not awarded' USING ERRCODE = 'PFB02';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER quotations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotations_guard();
--> statement-breakpoint
-- Lines change only in drafts of an issued RFQ. Each one prices a line of the quotation's own
-- RFQ, for that line's quantity, and its total is round(quantity × unit price, currency scale)
-- (ADR 0007; round() on numeric rounds half away from zero, which is half-up for prices >= 0).
CREATE FUNCTION quotation_lines_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent quotations%ROWTYPE;
  source rfq_lines%ROWTYPE;
  scale smallint;
BEGIN
  SELECT * INTO parent FROM quotations WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quotation_id ELSE NEW.quotation_id END;
  IF parent.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'quotation_lines: lines change only while the quotation is a draft' USING ERRCODE = 'PFB02';
  END IF;
  IF (SELECT status FROM rfqs WHERE id = parent.rfq_id) IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION 'quotation_lines: lines change only while the RFQ is issued' USING ERRCODE = 'PFB02';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.quotation_id IS DISTINCT FROM OLD.quotation_id OR NEW.rfq_line_id IS DISTINCT FROM OLD.rfq_line_id) THEN
    RAISE EXCEPTION 'quotation_lines: a line cannot move to another quotation or RFQ line' USING ERRCODE = 'PFB02';
  END IF;
  SELECT * INTO source FROM rfq_lines WHERE id = NEW.rfq_line_id;
  IF source.rfq_id IS DISTINCT FROM parent.rfq_id THEN
    RAISE EXCEPTION 'quotation_lines: the line belongs to another RFQ' USING ERRCODE = 'PFB02';
  END IF;
  IF NEW.quantity IS DISTINCT FROM source.quantity THEN
    RAISE EXCEPTION 'quotation_lines: the quantity comes from the RFQ line' USING ERRCODE = 'PFB02';
  END IF;
  SELECT pr.currency_scale INTO scale FROM rfqs r JOIN purchase_requisitions pr ON pr.id = r.requisition_id WHERE r.id = parent.rfq_id;
  IF NEW.line_total IS DISTINCT FROM round(NEW.quantity * NEW.unit_price, scale) THEN
    RAISE EXCEPTION 'quotation_lines: the line total is round(quantity × unit price, currency scale)' USING ERRCODE = 'PFB02';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER quotation_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION quotation_lines_guard();
--> statement-breakpoint
-- Checked at commit, once the header and its lines are both written: a quotation prices every
-- RFQ line exactly once (lines are unique per RFQ line and belong to the RFQ, so equal counts
-- mean full coverage), and its total is the sum of the line totals.
CREATE FUNCTION quotations_totals_check() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
  q quotations%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'quotations' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.quotation_id;
  ELSE
    target := NEW.quotation_id;
  END IF;
  SELECT * INTO q FROM quotations WHERE id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM quotation_lines WHERE quotation_id = q.id) IS DISTINCT FROM (SELECT count(*) FROM rfq_lines WHERE rfq_id = q.rfq_id) THEN
    RAISE EXCEPTION 'quotations: a quotation prices every RFQ line exactly once' USING ERRCODE = 'PFB02';
  END IF;
  IF q.total IS DISTINCT FROM (SELECT coalesce(sum(line_total), 0) FROM quotation_lines WHERE quotation_id = q.id) THEN
    RAISE EXCEPTION 'quotations: the total is the sum of the line totals' USING ERRCODE = 'PFB02';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER quotations_totals
  AFTER INSERT OR UPDATE ON quotations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION quotations_totals_check();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER quotation_lines_totals
  AFTER INSERT OR UPDATE OR DELETE ON quotation_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION quotations_totals_check();
