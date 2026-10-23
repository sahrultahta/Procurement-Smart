-- Phase 5a: default settings row, runtime grants (ADR 0013), and database backstops.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
-- The one settings row. Neutral defaults; an admin sets the real values before the first requisition.
INSERT INTO org_settings (id, org_name, timezone, currency_code, currency_scale)
VALUES (1, 'My organization', 'UTC', 'USD', 2)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
GRANT SELECT, UPDATE ON org_settings TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_policies TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON approval_policy_rules TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON approval_policy_steps TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON purchase_requisitions TO procureflow_app;
--> statement-breakpoint
-- DELETE only because draft lines are replaced on edit; a trigger below limits it to drafts.
GRANT SELECT, INSERT, UPDATE, DELETE ON requisition_lines TO procureflow_app;
--> statement-breakpoint
-- Once the first monetary document exists, the currency is fixed, and so is the lock itself.
CREATE FUNCTION org_settings_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'org_settings: the row id cannot change' USING ERRCODE = 'PFO01';
  END IF;
  IF OLD.currency_locked_at IS NOT NULL AND (
    NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.currency_scale IS DISTINCT FROM OLD.currency_scale
    OR NEW.currency_locked_at IS DISTINCT FROM OLD.currency_locked_at
  ) THEN
    RAISE EXCEPTION 'org_settings: the currency is locked because monetary documents exist' USING ERRCODE = 'PFO01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER org_settings_currency_lock
  BEFORE UPDATE ON org_settings
  FOR EACH ROW EXECUTE FUNCTION org_settings_guard();
--> statement-breakpoint
-- A published policy never changes; the only update is being superseded, once.
CREATE FUNCTION approval_policies_supersede_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (OLD.is_active AND NOT NEW.is_active AND NEW.superseded_at IS NOT NULL)
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.version_no IS DISTINCT FROM OLD.version_no
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'approval_policies: a published policy can only be superseded' USING ERRCODE = 'PFP01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_policies_immutable
  BEFORE UPDATE OR DELETE ON approval_policies
  FOR EACH ROW EXECUTE FUNCTION approval_policies_supersede_only();
--> statement-breakpoint
-- Rules and steps can be added only in the transaction that created their policy
-- (now() is the transaction start time, the policy's created_at default). Never changed or removed.
CREATE FUNCTION approval_policy_rules_sealed() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT'
    OR (SELECT created_at FROM approval_policies WHERE id = NEW.policy_id) IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'approval_policy_rules: rules belong to a published policy and cannot change' USING ERRCODE = 'PFP01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_policy_rules_sealed
  BEFORE INSERT OR UPDATE OR DELETE ON approval_policy_rules
  FOR EACH ROW EXECUTE FUNCTION approval_policy_rules_sealed();
--> statement-breakpoint
CREATE FUNCTION approval_policy_steps_sealed() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT'
    OR (SELECT p.created_at FROM approval_policy_rules r JOIN approval_policies p ON p.id = r.policy_id WHERE r.id = NEW.rule_id)
      IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'approval_policy_steps: steps belong to a published policy and cannot change' USING ERRCODE = 'PFP01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_policy_steps_sealed
  BEFORE INSERT OR UPDATE OR DELETE ON approval_policy_steps
  FOR EACH ROW EXECUTE FUNCTION approval_policy_steps_sealed();
--> statement-breakpoint
-- A requisition's number, owner, department, and currency are fixed at creation.
CREATE FUNCTION purchase_requisitions_fixed_columns() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
    OR NEW.department_id IS DISTINCT FROM OLD.department_id
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.currency_scale IS DISTINCT FROM OLD.currency_scale
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'purchase_requisitions: number, requester, department, currency, and creation time cannot change' USING ERRCODE = 'PFQ01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER purchase_requisitions_fixed_columns
  BEFORE UPDATE ON purchase_requisitions
  FOR EACH ROW EXECUTE FUNCTION purchase_requisitions_fixed_columns();
--> statement-breakpoint
-- Threat T-02: lines are editable only while the requisition is a draft or returned.
-- Ordered quantities (Phase 7) are the one thing that may change afterwards.
CREATE FUNCTION requisition_lines_editable_only_in_draft() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM purchase_requisitions
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.requisition_id ELSE NEW.requisition_id END;
  IF TG_OP = 'UPDATE'
    AND NEW.id = OLD.id AND NEW.requisition_id = OLD.requisition_id AND NEW.line_no = OLD.line_no
    AND NEW.description = OLD.description AND NEW.quantity = OLD.quantity AND NEW.uom = OLD.uom
    AND NEW.estimated_unit_price = OLD.estimated_unit_price AND NEW.line_total = OLD.line_total THEN
    RETURN NEW;
  END IF;
  IF parent_status IS DISTINCT FROM 'draft' AND parent_status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'requisition_lines: lines can change only while the requisition is a draft or returned' USING ERRCODE = 'PFQ01';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER requisition_lines_editable_only_in_draft
  BEFORE INSERT OR UPDATE OR DELETE ON requisition_lines
  FOR EACH ROW EXECUTE FUNCTION requisition_lines_editable_only_in_draft();
