-- Phase 5b: runtime grants (ADR 0013) and database backstops for approvals (ADR 0006 §4.5).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
-- No DELETE: approval history is never removed.
GRANT SELECT, INSERT, UPDATE ON approval_requests TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_steps TO procureflow_app;
--> statement-breakpoint
-- A request keeps what was submitted (the snapshot) forever, and changes only while pending.
CREATE FUNCTION approval_requests_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval_requests: approval history cannot be deleted' USING ERRCODE = 'PFD01';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval_requests: a completed request cannot change' USING ERRCODE = 'PFD01';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.round IS DISTINCT FROM OLD.round
    OR NEW.document_number IS DISTINCT FROM OLD.document_number
    OR NEW.document_title IS DISTINCT FROM OLD.document_title
    OR NEW.amount_snapshot IS DISTINCT FROM OLD.amount_snapshot
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.currency_scale IS DISTINCT FROM OLD.currency_scale
    OR NEW.department_id IS DISTINCT FROM OLD.department_id
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.policy_version_no IS DISTINCT FROM OLD.policy_version_no
    OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id
    OR NEW.awarded_by_user_id IS DISTINCT FROM OLD.awarded_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'approval_requests: the submitted snapshot cannot change' USING ERRCODE = 'PFD01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_requests_guard
  BEFORE UPDATE OR DELETE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_guard();
--> statement-breakpoint
-- Steps are created with their request (same transaction) and then only move forward:
-- waiting → pending | cancelled, pending → approved | rejected | returned | cancelled (AP-I2).
CREATE FUNCTION approval_steps_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval_steps: approval history cannot be deleted' USING ERRCODE = 'PFD01';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('waiting', 'pending')
      OR (SELECT created_at FROM approval_requests WHERE id = NEW.approval_request_id) IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'approval_steps: steps are created only with their request' USING ERRCODE = 'PFD01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
    OR NEW.step_no IS DISTINCT FROM OLD.step_no
    OR NEW.required_role IS DISTINCT FROM OLD.required_role
    OR NEW.scope_department_id IS DISTINCT FROM OLD.scope_department_id THEN
    RAISE EXCEPTION 'approval_steps: the route snapshot cannot change' USING ERRCODE = 'PFD01';
  END IF;
  IF NOT (
    (OLD.status = 'waiting' AND NEW.status IN ('pending', 'cancelled'))
    OR (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'returned', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'approval_steps: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'PFD01';
  END IF;
  IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'approval_steps: the activation time cannot change' USING ERRCODE = 'PFD01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_steps_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_steps
  FOR EACH ROW EXECUTE FUNCTION approval_steps_guard();
--> statement-breakpoint
-- SOD-01 / SOD-06, defense in depth: the submitter (or, for purchase orders, the buyer who
-- awarded the quotation) never decides a step, whatever the application does.
CREATE FUNCTION approval_steps_no_self_approval() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.decided_by_user_id IS NOT NULL AND EXISTS (
    SELECT FROM approval_requests r
    WHERE r.id = NEW.approval_request_id
      AND NEW.decided_by_user_id IN (r.submitted_by_user_id, r.awarded_by_user_id)
  ) THEN
    RAISE EXCEPTION 'approval_steps: the submitter cannot decide their own approval' USING ERRCODE = 'PFD01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_steps_no_self_approval
  BEFORE INSERT OR UPDATE ON approval_steps
  FOR EACH ROW EXECUTE FUNCTION approval_steps_no_self_approval();
