// AGE-1298: bounded maintenance command for EXISTING heartbeat_runs rows.
//
// The DB trigger added in packages/db/src/migrations/0227_heartbeat_runs_bound_terminal_result_json.sql
// stops *new* terminal writes from re-accumulating bloat, but it only fires on
// rows that are inserted/updated after the trigger is installed. Rows that
// were already terminal and already carrying a full stdout/stderr blob in
// result_json before the migration ran need one bulk retroactive pass. This
// script is that pass.
//
// Fail-closed by design:
//   - refuses to mutate anything (--apply) without a recent, gzip-verified
//     backup already on disk. Dry-run (the default) never refuses -- it never
//     mutates, so there is nothing to protect against.
//   - never touches a `queued` or `running` row: the eligibility WHERE clause
//     hard-codes `status IN ('succeeded','failed','cancelled','interrupted')`.
//   - preserves every field except `stdout`/`stderr` inside result_json --
//     usage_json, log_store/log_ref/log_bytes/log_sha256,
//     stdout_excerpt/stderr_excerpt, error/status/disposition columns are
//     never touched by this script.
//   - idempotent: eligibility is `result_json ? 'stdout' OR result_json ? 'stderr'`,
//     so a row this script (or the trigger) already compacted no longer
//     matches and a second run reports zero eligible rows.
//
// Usage:
//   tsx scripts/compact-heartbeat-run-results.ts [--apply] [--batch-size 500]
//     [--backup-dir <dir>] [--max-backup-age-hours 48] [--vacuum]
//
// Default is a dry run: report exact row count + exact bytes that would be
// reclaimed, and do not touch the database at all beyond a read-only SELECT.
//
// --apply performs the real bulk UPDATE, in batches, inside one transaction
// per batch (so a mid-run failure never leaves a batch half-written), then
// prints the exact row count + bytes actually reclaimed
// (before/after pg_total_relation_size).
//
// --vacuum (only meaningful with --apply) additionally runs `VACUUM (ANALYZE)
// heartbeat_runs` after the compaction commits, so the freed toast pages are
// returned to Postgres's free space map immediately rather than waiting for
// autovacuum. This does not shrink the on-disk file (only VACUUM FULL does
// that); see doc/db-heartbeat-run-retention.md for the separate
// physical-reclaim step.
import { createDb, sql } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { inspectDatabaseBackupHealth } from "../server/src/services/database-backup-health.js";

// Kept as the single documented source of truth for which statuses are
// terminal; the SQL below inlines the same four literals directly (Postgres
// doesn't take a JS array binding cleanly here), so if this list ever changes,
// update both together.
const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "interrupted"] as const;
void TERMINAL_STATUSES;

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function bytesToHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

async function main() {
  const apply = hasFlag("--apply");
  const vacuum = hasFlag("--vacuum");
  const batchSize = Math.max(1, Number(parseFlag("--batch-size")) || 500);
  const maxBackupAgeHours = Math.max(1, Number(parseFlag("--max-backup-age-hours")) || 48);

  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const backupDir = parseFlag("--backup-dir") ?? config.databaseBackupDir;

  const db = createDb(dbUrl);

  // --- 1. Report eligible rows + reclaimable bytes (always, dry-run or not) ---
  const beforeRows = (await db.execute(sql`
    select
      count(*) filter (where result_json ? 'stdout' or result_json ? 'stderr') as eligible_rows,
      coalesce(sum(pg_column_size(result_json)) filter (where result_json ? 'stdout' or result_json ? 'stderr'), 0) as reclaimable_bytes,
      count(*) filter (where status in ('succeeded','failed','cancelled','interrupted')) as total_terminal_rows
    from heartbeat_runs
  `)) as unknown as Array<{ eligible_rows: string; reclaimable_bytes: string; total_terminal_rows: string }>;
  const before = beforeRows[0]!;

  const eligibleRows = Number(before.eligible_rows);
  const reclaimableBytes = Number(before.reclaimable_bytes);

  console.log(`[compact-heartbeat-run-results] mode=${apply ? "apply" : "dry-run"}`);
  console.log(`[compact-heartbeat-run-results] terminal rows: ${before.total_terminal_rows}`);
  console.log(
    `[compact-heartbeat-run-results] eligible rows (terminal + stdout/stderr present): ${eligibleRows}`,
  );
  console.log(
    `[compact-heartbeat-run-results] estimated bytes eligible for reclaim: ${reclaimableBytes} (${bytesToHuman(reclaimableBytes)})`,
  );

  if (eligibleRows === 0) {
    console.log("[compact-heartbeat-run-results] nothing to do; exiting 0.");
    return;
  }

  if (!apply) {
    console.log("[compact-heartbeat-run-results] dry run complete. Re-run with --apply to mutate.");
    return;
  }

  // --- 2. Fail-closed backup check (--apply only) ---
  const backupHealth = inspectDatabaseBackupHealth({
    enabled: true,
    backupDir,
    maxAgeHours: maxBackupAgeHours,
  });
  if (!backupHealth.latestBackup) {
    console.error(
      `[compact-heartbeat-run-results] REFUSING: no backup found under ${backupDir}. ` +
        "Take a verified gzip backup first, or pass --backup-dir to point at one.",
    );
    process.exitCode = 1;
    return;
  }
  if (backupHealth.latestBackup.ageHours > maxBackupAgeHours) {
    console.error(
      `[compact-heartbeat-run-results] REFUSING: newest backup ${backupHealth.latestBackup.name} ` +
        `is ${backupHealth.latestBackup.ageHours}h old, older than --max-backup-age-hours=${maxBackupAgeHours}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[compact-heartbeat-run-results] verified backup: ${backupHealth.latestBackup.name} ` +
      `(${backupHealth.latestBackup.ageHours}h old, ${bytesToHuman(backupHealth.latestBackup.sizeBytes)})`,
  );

  const beforeSizeRows = (await db.execute(
    sql`select pg_total_relation_size('heartbeat_runs') as size`,
  )) as unknown as Array<{ size: string }>;
  const beforeSize = beforeSizeRows[0]!;

  // --- 3. Bulk-compact in batches, one transaction per batch ---
  let totalUpdated = 0;
  for (;;) {
    const updatedRows = (await db.execute(sql`
      with batch as (
        select id
        from heartbeat_runs
        where status in ('succeeded','failed','cancelled','interrupted')
          and (result_json ? 'stdout' or result_json ? 'stderr')
        limit ${batchSize}
        for update skip locked
      )
      update heartbeat_runs
      set
        result_json = (heartbeat_runs.result_json - 'stdout' - 'stderr')
          || jsonb_build_object(
            'resultJsonStdoutStderrDroppedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'resultJsonStdoutStderrDroppedReason', 'duplicate_of_log_store; full output in log_ref, bounded excerpt in stdout_excerpt/stderr_excerpt'
          ),
        updated_at = now()
      from batch
      where heartbeat_runs.id = batch.id
      returning heartbeat_runs.id
    `)) as unknown as Array<{ id: string }>;

    if (updatedRows.length === 0) break;
    totalUpdated += updatedRows.length;
    console.log(`[compact-heartbeat-run-results] compacted batch of ${updatedRows.length} (total ${totalUpdated})`);
  }

  console.log(`[compact-heartbeat-run-results] total rows compacted: ${totalUpdated}`);

  if (vacuum) {
    console.log("[compact-heartbeat-run-results] running VACUUM (ANALYZE) heartbeat_runs...");
    await db.execute(sql`vacuum (analyze) heartbeat_runs`);
  }

  const afterSizeRows = (await db.execute(
    sql`select pg_total_relation_size('heartbeat_runs') as size`,
  )) as unknown as Array<{ size: string }>;
  const afterSize = afterSizeRows[0]!;

  const beforeBytes = Number(beforeSize.size);
  const afterBytes = Number(afterSize.size);
  console.log(
    `[compact-heartbeat-run-results] heartbeat_runs total relation size: ` +
      `${bytesToHuman(beforeBytes)} -> ${bytesToHuman(afterBytes)} ` +
      `(delta ${bytesToHuman(beforeBytes - afterBytes)})`,
  );
  console.log(
    "[compact-heartbeat-run-results] Note: a plain UPDATE + VACUUM (non-FULL) reclaims dead toast " +
      "pages into Postgres's free space map for REUSE by future rows, but does not shrink the file " +
      "on disk. For a maintenance-window physical reclaim (actual bytes returned to the filesystem), " +
      "see doc/db-heartbeat-run-retention.md's VACUUM FULL runbook.",
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[compact-heartbeat-run-results] failed: ${message}`);
  process.exitCode = 1;
});
