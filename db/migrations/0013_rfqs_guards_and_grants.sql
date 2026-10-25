-- Phase 6a: runtime grants (ADR 0013) and database backstops for RFQs (SQLSTATE PFB01).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON rfqs TO procureflow_app;
--> statement-breakpoint
-- DELETE only because draft lines and invitations are replaced on edit; the triggers below
-- limit every change to drafts.
GRANT SELECT, INSERT, UPDATE, DELETE ON rfq_lines TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON rfq_suppliers TO procureflow_app;
--> statement-breakpoint
-- An RFQ starts as a draft of an approved requisition, keeps its identity, and moves only along
-- docs/state-machines.md §4. Title and due date change only while it is a draft.
CREATE FUNCTION rfqs_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
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
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rfqs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rfqs
  FOR EACH ROW EXECUTE FUNCTION rfqs_guard();
--> statement-breakpoint
-- Lines change only in drafts. Each one is a line of the RFQ's own requisition, copies its
-- description and unit, asks for no more than what is left to order, and is on no other RFQ
-- that is not cancelled (maintainer decision 2026-10-25).
CREATE FUNCTION rfq_lines_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent rfqs%ROWTYPE;
  source requisition_lines%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM rfqs WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.rfq_id ELSE NEW.rfq_id END;
  IF parent.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'rfq_lines: lines can change only while the RFQ is a draft' USING ERRCODE = 'PFB01';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.rfq_id IS DISTINCT FROM OLD.rfq_id THEN
    RAISE EXCEPTION 'rfq_lines: a line cannot move to another RFQ' USING ERRCODE = 'PFB01';
  END IF;
  SELECT * INTO source FROM requisition_lines WHERE id = NEW.requisition_line_id;
  IF source.requisition_id IS DISTINCT FROM parent.requisition_id THEN
    RAISE EXCEPTION 'rfq_lines: the line belongs to another requisition' USING ERRCODE = 'PFB01';
  END IF;
  IF NEW.description IS DISTINCT FROM source.description OR NEW.uom IS DISTINCT FROM source.uom THEN
    RAISE EXCEPTION 'rfq_lines: description and unit come from the requisition line' USING ERRCODE = 'PFB01';
  END IF;
  IF NEW.quantity > source.quantity - source.ordered_qty THEN
    RAISE EXCEPTION 'rfq_lines: more than the quantity left to order' USING ERRCODE = 'PFB01';
  END IF;
  IF EXISTS (
    SELECT FROM rfq_lines l JOIN rfqs r ON r.id = l.rfq_id
    WHERE l.requisition_line_id = NEW.requisition_line_id AND l.rfq_id <> NEW.rfq_id AND r.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'rfq_lines: the requisition line is already on another RFQ' USING ERRCODE = 'PFB01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rfq_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rfq_lines
  FOR EACH ROW EXECUTE FUNCTION rfq_lines_guard();
--> statement-breakpoint
-- Invitations change only in drafts, and only active suppliers are invited (SUP-R1).
CREATE FUNCTION rfq_suppliers_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (SELECT status FROM rfqs WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.rfq_id ELSE NEW.rfq_id END) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'rfq_suppliers: invitations can change only while the RFQ is a draft' USING ERRCODE = 'PFB01';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'rfq_suppliers: invitations are replaced, not edited' USING ERRCODE = 'PFB01';
  END IF;
  IF (SELECT status FROM suppliers WHERE id = NEW.supplier_id) IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'rfq_suppliers: only active suppliers can be invited' USING ERRCODE = 'PFB01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rfq_suppliers_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rfq_suppliers
  FOR EACH ROW EXECUTE FUNCTION rfq_suppliers_guard();
