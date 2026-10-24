import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// AGE-1298: functional (real subprocess + real Postgres) proof for
// scripts/compact-heartbeat-run-results.ts -- the bulk retroactive
// maintenance command for rows that were already terminal (and already
// carrying a full stdout/stderr blob) before the 0227 trigger migration
// existed. Covers: dry-run never mutates, --apply refuses without a fresh
// backup, --apply compacts and is idempotent (second dry run reports zero
// eligible rows), and running/queued rows are left untouched.

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(new URL("../../../", import.meta.url).pathname);
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/compact-heartbeat-run-results.ts");

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-compact-heartbeat-runs-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

function makeBackupDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-compact-backup-"));
  cleanups.push(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeFreshBackupFile(backupDir: string) {
  fs.writeFileSync(path.join(backupDir, "paperclip-20260823T000000Z.sql.gz"), "not a real backup, just needs to exist and be recent");
}

async function seedRun(
  sql: ReturnType<typeof postgres>,
  companyId: string,
  agentId: string,
  status: string,
  resultJson: Record<string, unknown>,
): Promise<string> {
  const runId = randomUUID();
  await sql`
    ALTER TABLE "heartbeat_runs" DISABLE TRIGGER "heartbeat_runs_bound_terminal_result_json"
  `;
  await sql`
    INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "result_json")
    VALUES (${runId}, ${companyId}, ${agentId}, ${status}, ${sql.json(resultJson)})
  `;
  await sql`
    ALTER TABLE "heartbeat_runs" ENABLE TRIGGER "heartbeat_runs_bound_terminal_result_json"
  `;
  return runId;
}

async function runScript(
  connectionString: string,
  backupDir: string,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  // tsx's CLI opens a control IPC socket under TMPDIR; some sandboxed run
  // environments set a TMPDIR path long enough to blow the ~104-char unix
  // socket path limit (EINVAL). Use a short scratch dir for the subprocess
  // only -- this does not touch the outer test process's own TMPDIR.
  const shortTmpDir = fs.mkdtempSync("/tmp/pc-tsx-");
  cleanups.push(async () => {
    fs.rmSync(shortTmpDir, { recursive: true, force: true });
  });
  const tsxBin = path.join(REPO_ROOT, "node_modules/.bin/tsx");
  try {
    const { stdout, stderr } = await execFileAsync(
      tsxBin,
      [SCRIPT_PATH, "--backup-dir", backupDir, ...extraArgs],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: connectionString, TMPDIR: shortTmpDir },
        timeout: 30_000,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: execError.stdout ?? "", stderr: execError.stderr ?? "", code: execError.code ?? 1 };
  }
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping compact-heartbeat-run-results functional tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("scripts/compact-heartbeat-run-results.ts", () => {
  it(
    "dry run reports eligible rows without mutating anything",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = makeBackupDir();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const companyId = randomUUID();
        const agentId = randomUUID();
        await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Co', 'CO')`;
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
          VALUES (${agentId}, ${companyId}, 'A', 'engineer', 'process', '{}'::jsonb)
        `;
        const legacyRunId = await seedRun(sql, companyId, agentId, "succeeded", {
          stdout: "legacy",
          stderr: "legacy",
        });

        const result = await runScript(connectionString, backupDir);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("mode=dry-run");
        expect(result.stdout).toContain("eligible rows (terminal + stdout/stderr present): 1");

        const rows = await sql<{ result_json: Record<string, unknown> }[]>`
          SELECT "result_json" FROM "heartbeat_runs" WHERE "id" = ${legacyRunId}
        `;
        expect(rows[0]!.result_json.stdout).toBe("legacy");
      } finally {
        await sql.end();
      }
    },
    45_000,
  );

  it(
    "--apply refuses without a fresh backup on disk",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = makeBackupDir(); // empty: no backup file written
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const companyId = randomUUID();
        const agentId = randomUUID();
        await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Co', 'CO')`;
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
          VALUES (${agentId}, ${companyId}, 'A', 'engineer', 'process', '{}'::jsonb)
        `;
        const legacyRunId = await seedRun(sql, companyId, agentId, "succeeded", {
          stdout: "legacy",
          stderr: "legacy",
        });

        const result = await runScript(connectionString, backupDir, ["--apply"]);
        expect(result.code).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("REFUSING");

        const rows = await sql<{ result_json: Record<string, unknown> }[]>`
          SELECT "result_json" FROM "heartbeat_runs" WHERE "id" = ${legacyRunId}
        `;
        expect(rows[0]!.result_json.stdout).toBe("legacy");
      } finally {
        await sql.end();
      }
    },
    45_000,
  );

  it(
    "--apply compacts eligible rows with a fresh backup present, leaves queued/running untouched, and a second dry run reports zero",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = makeBackupDir();
      writeFreshBackupFile(backupDir);
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const companyId = randomUUID();
        const agentId = randomUUID();
        await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Co', 'CO')`;
        await sql`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
          VALUES (${agentId}, ${companyId}, 'A', 'engineer', 'process', '{}'::jsonb)
        `;
        const legacyRunId = await seedRun(sql, companyId, agentId, "succeeded", {
          stdout: "legacy blob",
          stderr: "legacy blob",
          usage: { totalTokens: 42 },
        });
        const runningRunId = await seedRun(sql, companyId, agentId, "running", {
          stdout: "still buffering",
        });

        const applyResult = await runScript(connectionString, backupDir, ["--apply", "--vacuum"]);
        expect(applyResult.code).toBe(0);
        expect(applyResult.stdout).toContain("verified backup:");
        expect(applyResult.stdout).toContain("total rows compacted: 1");

        const compacted = await sql<{ result_json: Record<string, unknown> }[]>`
          SELECT "result_json" FROM "heartbeat_runs" WHERE "id" = ${legacyRunId}
        `;
        expect(compacted[0]!.result_json.stdout).toBeUndefined();
        expect(compacted[0]!.result_json.stderr).toBeUndefined();
        expect(compacted[0]!.result_json.usage).toEqual({ totalTokens: 42 });

        const running = await sql<{ result_json: Record<string, unknown> }[]>`
          SELECT "result_json" FROM "heartbeat_runs" WHERE "id" = ${runningRunId}
        `;
        expect(running[0]!.result_json.stdout).toBe("still buffering");

        const secondDryRun = await runScript(connectionString, backupDir);
        expect(secondDryRun.code).toBe(0);
        expect(secondDryRun.stdout).toContain("eligible rows (terminal + stdout/stderr present): 0");
        expect(secondDryRun.stdout).toContain("nothing to do; exiting 0");
      } finally {
        await sql.end();
      }
    },
    60_000,
  );
});
