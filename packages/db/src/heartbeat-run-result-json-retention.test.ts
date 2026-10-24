import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

// AGE-1298: heartbeat_runs.result_json accumulated the full buffered
// stdout/stderr of every run, duplicating bytes already durable in
// log_store/log_ref/log_bytes/log_sha256 and the bounded excerpt columns.
// This is the integration proof (real Postgres, not a unit mock) for the
// authoritative enforcement point: the DB trigger installed in migration
// 0227_heartbeat_runs_bound_terminal_result_json.sql.

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-result-json-retention-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function seedCompanyAndAgent(sql: ReturnType<typeof postgres>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await sql`
    INSERT INTO "companies" ("id", "name", "issue_prefix")
    VALUES (${companyId}, ${`Company ${companyId}`}, 'RET')
  `;
  await sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
    VALUES (${agentId}, ${companyId}, 'Retention Agent', 'engineer', 'process', '{}'::jsonb)
  `;
  return { companyId, agentId };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat_runs retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat_runs.result_json bounded terminal retention trigger", () => {
  it(
    "strips stdout/stderr on INSERT with a terminal status, keeps every other field",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const { companyId, agentId } = await seedCompanyAndAgent(sql);
        const runId = randomUUID();
        await sql`
          INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "result_json")
          VALUES (
            ${runId}, ${companyId}, ${agentId}, 'succeeded',
            ${sql.json({
              stdout: "x".repeat(5000),
              stderr: "y".repeat(5000),
              summary: "did the work",
              usage: { totalTokens: 123 },
              stopReason: "completed",
            })}
          )
        `;

        const rows = await sql<{ result_json: Record<string, unknown> }[]>`
          SELECT "result_json" FROM "heartbeat_runs" WHERE "id" = ${runId}
        `;
        const resultJson = rows[0]!.result_json;

        expect(resultJson.stdout).toBeUndefined();
        expect(resultJson.stderr).toBeUndefined();
        expect(resultJson.summary).toBe("did the work");
        expect(resultJson.usage).toEqual({ totalTokens: 123 });
        expect(resultJson.stopReason).toBe("completed");
        expect(typeof resultJson.resultJsonStdoutStderrDroppedAt).toBe("string");
        expect(resultJson.resultJsonStdoutStderrDroppedReason).toBe(
          "duplicate_of_log_store; full output in log_ref, bounded excerpt in stdout_excerpt/stderr_excerpt",
        );
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "does not touch result_json for queued or running rows",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const { companyId, agentId } = await seedCompanyAndAgent(sql);

        for (const status of ["queued", "running"]) {
          const runId = randomUUID();
          await sql`
            INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "result_json")
            VALUES (
              ${runId}, ${companyId}, ${agentId}, ${status},
              ${sql.json({ stdout: "still buffering", stderr: "still buffering" })}
            )
          `;
          const rows = await sql<{ result_json: Record<string, unknown> }[]>`
            SELECT "result_json" FROM "heartbeat_runs" WHERE "id" = ${runId}
          `;
          expect(rows[0]!.result_json.stdout).toBe("still buffering");
          expect(rows[0]!.result_json.stderr).toBe("still buffering");
        }
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "fires on UPDATE transition into a terminal status, and is idempotent on a second no-op update",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const { companyId, agentId } = await seedCompanyAndAgent(sql);
        const runId = randomUUID();
        await sql`
          INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "result_json")
          VALUES (${runId}, ${companyId}, ${agentId}, 'running', ${sql.json({ stdout: "partial" })})
        `;

        await sql`
          UPDATE "heartbeat_runs"
          SET "status" = 'failed', "result_json" = ${sql.json({ stdout: "full output", stderr: "boom", error: "adapter_failed" })}
          WHERE "id" = ${runId}
        `;

        let rows = await sql<{ result_json: Record<string, unknown> }[]>`
          SELECT "result_json" FROM "heartbeat_runs" WHERE "id" = ${runId}
        `;
        expect(rows[0]!.result_json.stdout).toBeUndefined();
        expect(rows[0]!.result_json.error).toBe("adapter_failed");
        const firstDroppedAt = rows[0]!.result_json.resultJsonStdoutStderrDroppedAt;

        // Idempotent: re-running an UPDATE with the same terminal status and an
        // already-compacted result_json must not touch resultJsonStdoutStderrDroppedAt
        // again (the WHEN clause short-circuits because stdout/stderr keys are gone).
        await sql`
          UPDATE "heartbeat_runs"
          SET "status" = 'failed'
          WHERE "id" = ${runId}
        `;
        rows = await sql<{ result_json: Record<string, unknown> }[]>`
          SELECT "result_json" FROM "heartbeat_runs" WHERE "id" = ${runId}
        `;
        expect(rows[0]!.result_json.resultJsonStdoutStderrDroppedAt).toBe(firstDroppedAt);
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "the maintenance query's eligibility predicate matches only rows the trigger has not already compacted",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const { companyId, agentId } = await seedCompanyAndAgent(sql);

        // Pre-trigger-era row: simulate by disabling the trigger for one insert,
        // the way an already-terminal row from before this migration would look.
        await sql`ALTER TABLE "heartbeat_runs" DISABLE TRIGGER "heartbeat_runs_bound_terminal_result_json"`;
        const legacyRunId = randomUUID();
        await sql`
          INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "result_json")
          VALUES (${legacyRunId}, ${companyId}, ${agentId}, 'succeeded', ${sql.json({ stdout: "legacy blob", stderr: "legacy blob" })})
        `;
        await sql`ALTER TABLE "heartbeat_runs" ENABLE TRIGGER "heartbeat_runs_bound_terminal_result_json"`;

        const compactedRunId = randomUUID();
        await sql`
          INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "result_json")
          VALUES (${compactedRunId}, ${companyId}, ${agentId}, 'succeeded', ${sql.json({ summary: "ok" })})
        `;

        const eligible = await sql<{ id: string }[]>`
          SELECT "id" FROM "heartbeat_runs"
          WHERE "result_json" ? 'stdout' OR "result_json" ? 'stderr'
        `;
        expect(eligible.map((row) => row.id)).toEqual([legacyRunId]);
      } finally {
        await sql.end();
      }
    },
    20_000,
  );
});
