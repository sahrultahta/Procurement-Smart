-- ADR 0013: explicit per-table grants for the runtime role. No DELETE on users,
-- accounts, profiles, departments, or role assignments: users are deactivated and
-- roles are revoked by UPDATE, never removed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
-- Better Auth tables.
GRANT SELECT, INSERT, UPDATE ON users TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON accounts TO procureflow_app;
--> statement-breakpoint
-- Sign-out and session revocation delete session rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO procureflow_app;
--> statement-breakpoint
-- One-time tokens are deleted when used or expired.
GRANT SELECT, INSERT, UPDATE, DELETE ON verifications TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO procureflow_app;
--> statement-breakpoint
-- ProcureFlow identity tables.
GRANT SELECT, INSERT, UPDATE ON departments TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON user_profiles TO procureflow_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON role_assignments TO procureflow_app;
