-- AGE-1298: bound heartbeat_runs.result_json growth at the database layer.
--
-- Before this trigger, result_json accumulated the full buffered stdout/stderr
-- of every heartbeat run (see server/src/adapters/process/execute.ts's
-- adapterResult.resultJson). That is a duplicate of bytes already durably
-- captured by log_store/log_ref/log_bytes/log_sha256 (the filesystem run log)
-- and by the bounded stdout_excerpt/stderr_excerpt columns. It accounted for
-- ~2.7GB of live heartbeat_runs bloat (toast table pg_toast_16537) before this
-- fix, and was the direct cause of a repeated ENOSPC outage.
--
-- A JS-level guard exists in server/src/services/heartbeat.ts
-- (boundTerminalResultJsonForPersistence, wired into setRunStatus and
-- setRunStatusFromLive) for the two chokepoints almost every write goes
-- through. This trigger is the authoritative, code-path-independent
-- enforcement: it fires on every INSERT/UPDATE of heartbeat_runs regardless of
-- which of the ~26 call sites in that file (or any future one) performed the
-- write, so a missed call site can never reintroduce the bloat.
--
-- Scope, deliberately narrow:
--   - Only fires when NEW.status is a terminal status (succeeded, failed,
--     cancelled, interrupted). queued/running rows are never touched -- the
--     WHEN clause below is the enforcement point for that constraint.
--   - Only strips the "stdout"/"stderr" keys. Every other field (summary,
--     errorFamily, stopReason, usage, timeouts, configFreshness, etc.) is
--     preserved untouched.
--   - Idempotent: a row with no stdout/stderr keys already present is left
--     alone (WHEN clause short-circuits), so re-running any UPDATE over
--     already-compacted rows is a no-op.
CREATE OR REPLACE FUNCTION "bound_heartbeat_run_result_json"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	NEW."result_json" := (NEW."result_json" - 'stdout' - 'stderr')
		|| jsonb_build_object(
			'resultJsonStdoutStderrDroppedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'resultJsonStdoutStderrDroppedReason', 'duplicate_of_log_store; full output in log_ref, bounded excerpt in stdout_excerpt/stderr_excerpt'
		);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_bound_terminal_result_json" ON "heartbeat_runs";
--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_bound_terminal_result_json"
BEFORE INSERT OR UPDATE ON "heartbeat_runs"
FOR EACH ROW
WHEN (
	NEW."status" IN ('succeeded', 'failed', 'cancelled', 'interrupted')
	AND NEW."result_json" IS NOT NULL
	AND (NEW."result_json" ? 'stdout' OR NEW."result_json" ? 'stderr')
)
EXECUTE FUNCTION "bound_heartbeat_run_result_json"();
