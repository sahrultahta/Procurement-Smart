-- ADR 0009: audit_events is append-only for every role, and ADR 0013: runtime grants.
-- Runs as the schema owner (procureflow_owner). The runtime role must already exist;
-- roles are cluster-level and are created by bootstrap, not by migrations (ADR 0013).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procureflow_app') THEN
    RAISE EXCEPTION 'Role procureflow_app does not exist. Create it first: "npm run db:local -- ensure-app-role" (local) or "npm run db:app-role" (other environments).';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION audit_events_reject_modification() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Custom SQLSTATE so tests and the command runner can tell this apart from a privilege error.
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP USING ERRCODE = 'PFA01';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_modification();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_modification();
--> statement-breakpoint
-- Runtime role: least privilege. Audit rows can be written and read, never changed.
GRANT SELECT, INSERT ON audit_events TO procureflow_app;
--> statement-breakpoint
-- Counters are incremented in place by allocateDocumentNumber (upsert).
GRANT SELECT, INSERT, UPDATE ON document_sequences TO procureflow_app;
