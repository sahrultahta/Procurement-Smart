-- ADR 0013: explicit grants for the runtime role. No DELETE: suppliers are
-- deactivated, never removed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON suppliers TO procureflow_app;
--> statement-breakpoint
-- A supplier's code and creator are fixed for life: SOD-03 depends on who created it.
CREATE FUNCTION suppliers_keep_code_and_creator() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'suppliers: id, code, creator, and creation time cannot change' USING ERRCODE = 'PFS01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER suppliers_fixed_identity_columns
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION suppliers_keep_code_and_creator();
