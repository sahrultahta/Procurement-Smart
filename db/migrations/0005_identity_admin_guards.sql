ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_not_self_deactivated" CHECK ("user_profiles"."deactivated_by_user_id" IS NULL OR "user_profiles"."deactivated_by_user_id" <> "user_profiles"."user_id");--> statement-breakpoint
-- Role assignments are history: a row is written once and may later be revoked
-- exactly once. Nothing else about it can change, even through the runtime role.
CREATE FUNCTION role_assignments_allow_revocation_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'role_assignments: a revoked assignment cannot change' USING ERRCODE = 'PFR01';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.department_id IS DISTINCT FROM OLD.department_id
    OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
    OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'role_assignments: only revocation may change an assignment' USING ERRCODE = 'PFR01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER role_assignments_revocation_only
  BEFORE UPDATE ON role_assignments
  FOR EACH ROW EXECUTE FUNCTION role_assignments_allow_revocation_only();
