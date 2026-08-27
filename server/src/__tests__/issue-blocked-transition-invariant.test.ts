import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-transition invariant tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A blocked issue must name what will wake it: either an unresolved blocker edge, or an
 * unblockDescriptor naming the owner and the action. Without one of those,
 * deliverAgentUnblockNotification() no-ops and blockerAttention (derived at read time)
 * resolves the terminal blocker to the issue's own id — a "phantom" that sleeps forever.
 *
 * Measured on the AGE board before this invariant existed: 17 of 20 blocked issues were
 * phantoms.
 */
describeEmbeddedPostgres("blocked transition invariant", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-transition-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Company BTI",
      issuePrefix: "BTI",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BTI Agent",
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    status: string;
    assigneeAgentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: `Issue ${input.identifier}`,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: "manual",
      originFingerprint: "default",
    });
    return id;
  }

  it("rejects a blocked transition with neither a blocker edge nor an unblockDescriptor", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertIssue({
      companyId,
      identifier: "BTI-1",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    await expect(
      svc.update(issueId, { status: "blocked" }),
    ).rejects.toThrow(/unblockDescriptor/i);

    const [row] = await db.select().from(issues);
    expect(row.status).toBe("in_progress");
  });

  it("allows a blocked transition when an unblockDescriptor names the owner and action", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertIssue({
      companyId,
      identifier: "BTI-2",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    const updated = await svc.update(issueId, {
      status: "blocked",
      unblockDescriptor: {
        owner: { agentId },
        action: "Wake when the upstream provider restores the API.",
      },
    });

    expect(updated.status).toBe("blocked");
    expect(updated.blockedTransitionAt).toBeTruthy();
  });

  it("allows a blocked transition when an unresolved blocker edge exists", async () => {
    const { companyId, agentId } = await seed();
    const blockerId = await insertIssue({
      companyId,
      identifier: "BTI-3",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const issueId = await insertIssue({
      companyId,
      identifier: "BTI-4",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const updated = await svc.update(issueId, { status: "blocked" });
    expect(updated.status).toBe("blocked");
  });
});
