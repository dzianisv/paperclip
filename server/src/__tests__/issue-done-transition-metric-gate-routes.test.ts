import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres done-transition metric gate route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("done transition outcome-metric gate (AGE-626)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof createApp>;
  let companyId!: string;

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: async () => {
        throw new Error("Unexpected storage.putFile call in metric gate route test");
      },
      getObject: async () => {
        throw new Error("Unexpected storage.getObject call in metric gate route test");
      },
      headObject: async () => ({ exists: false }),
      deleteObject: async () => undefined,
    };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-done-metric-gate-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    app = createApp(companyId);

    await db.insert(companies).values({
      id: companyId,
      name: "Metric gate tenant",
      issuePrefix: "MTG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssue(title: string, description = "Fixture issue body, no PR reference.") {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title,
        description,
        status: "in_progress",
        priority: "medium",
        assigneeUserId: "cloud-user-1",
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    return createRes.body.id as string;
  }

  it("refuses done on a quantity-target-titled issue with no pasted metric evidence", async () => {
    const issueId = await createIssue(`Reduce alert volume by 90% (${randomUUID()})`);

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("quantity/rate target");
    expect(res.body.error.toLowerCase()).toContain("measurement");
    expect(res.body.details).toMatchObject({
      code: "done_transition_metric_gate",
      reason: "missing_outcome_measurement",
    });
  });

  it("allows done on the same fixture once a before/after number is pasted in a comment", async () => {
    const issueId = await createIssue(`Reduce alert volume by 90% (${randomUUID()})`);
    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Verified post-deploy: alerts/day went from 365 (before) to 12 (after)." });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("allows done on the same fixture with an explicit N/A no-live-traffic note", async () => {
    const issueId = await createIssue(`Cut deploy error count in half (${randomUUID()})`);
    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "N/A -- no live traffic yet (Richard Hendricks, 2026-08-20)." });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("does not gate an issue whose title has no quantity-target pattern", async () => {
    const issueId = await createIssue("Document the alert dedup architecture");

    const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");
  });
});
