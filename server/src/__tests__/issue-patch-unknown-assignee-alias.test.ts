import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { updateIssueSchema } from "@paperclipai/shared";
import { z } from "zod";
import { errorHandler } from "../middleware/error-handler.js";
import { validateIssueMutationBody } from "../middleware/validate.js";

// Regression for the silent-assignment defect: PATCH /api/issues/:id with
// `assigneeId` (or `agentId`) returned HTTP 200 while the assignment was
// dropped, because the update schema used Zod's default strip semantics and
// this model stores agent assignment in `assigneeAgentId`.

const ISSUE_ASSIGNEE_ALIAS_HINTS: Record<string, string> = {
  assigneeId: "Unrecognized key \"assigneeId\". Use \"assigneeAgentId\" to assign an agent or \"assigneeUserId\" to assign a person.",
  agentId: "Unrecognized key \"agentId\". Use \"assigneeAgentId\" to assign an agent.",
  assignee_id: "Unrecognized key \"assignee_id\". Use \"assigneeAgentId\" to assign an agent or \"assigneeUserId\" to assign a person.",
  assignee_agent_id: "Unrecognized key \"assignee_agent_id\". Use \"assigneeAgentId\".",
  assignee: "Unrecognized key \"assignee\". Use \"assigneeAgentId\" to assign an agent or \"assigneeUserId\" to assign a person.",
};

// Mirrors the route-level schema in routes/issues.ts.
const updateIssueRouteStrictSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
}).strict();

const updateIssueRouteSchema = z.unknown().superRefine((value, ctx) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [alias, message] of Object.entries(ISSUE_ASSIGNEE_ALIAS_HINTS)) {
    if (Object.hasOwn(value as Record<string, unknown>, alias)) {
      ctx.addIssue({ code: "custom", path: [alias], message });
    }
  }
}).pipe(updateIssueRouteStrictSchema);

function buildApp() {
  const handler = vi.fn((req: express.Request, res: express.Response) => {
    res.status(200).json({ ok: true, body: req.body });
  });
  const app = express();
  app.use(express.json());
  app.patch("/issues/:id", validateIssueMutationBody(updateIssueRouteSchema), handler);
  app.use(errorHandler);
  return { app, handler };
}

const AGENT_ID = "1e20bf06-4885-4263-bc6f-46d786fe49a3";

describe("PATCH /issues/:id assignee field contract", () => {
  it("rejects assigneeId instead of silently dropping the assignment", async () => {
    const { app, handler } = buildApp();
    const res = await request(app)
      .patch("/issues/abc")
      .send({ assigneeId: AGENT_ID, status: "todo" });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("assigneeAgentId");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects other assignment aliases and unknown keys", async () => {
    for (const alias of ["agentId", "assignee_id", "assignee_agent_id", "assignee", "totallyBogusField"]) {
      const { app, handler } = buildApp();
      const res = await request(app).patch("/issues/abc").send({ [alias]: AGENT_ID });
      expect(res.status, `${alias} must be rejected`).toBe(400);
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("still accepts the canonical assigneeAgentId field", async () => {
    const { app, handler } = buildApp();
    const res = await request(app)
      .patch("/issues/abc")
      .send({ assigneeAgentId: AGENT_ID, status: "todo" });

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
    expect(res.body.body.assigneeAgentId).toBe(AGENT_ID);
  });

  it("keeps the route wired to the strict schema", () => {
    const source = readFileSync(new URL("../routes/issues.ts", import.meta.url), "utf8");
    expect(source).toContain("updateIssueRouteStrictSchema");
    expect(source).toContain("ISSUE_ASSIGNEE_ALIAS_HINTS");
    expect(source).toMatch(/router\.patch\("\/issues\/:id", validateIssueMutationBody\(updateIssueRouteSchema\)/);
  });
});
