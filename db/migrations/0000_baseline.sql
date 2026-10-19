-- Phase 1 baseline: intentionally creates no objects.
-- It establishes the migration journal so the pipeline (generate -> review -> apply)
-- is exercised from the start. Phase 2 adds database roles, document sequences,
-- and the append-only audit trail.
SELECT 1;
