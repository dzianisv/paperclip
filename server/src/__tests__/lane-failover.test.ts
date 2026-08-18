import { describe, expect, it } from "vitest";
import {
  computeLaneFailoverExhaustedDelayMs,
  isLaneFailoverExhausted,
  LANE_FAILOVER_EXHAUSTED_MAX_DELAY_MS,
  readFailoverModels,
  resolveLaneFailoverModel,
} from "../services/lane-failover.ts";

const CHAIN = {
  model: "anthropic/claude-opus-5",
  failoverModels: ["github-copilot/claude-sonnet-5", "google/gemini-3.7-flash"],
};

describe("lane failover chain", () => {
  it("walks the chain in order, one model per retry attempt", () => {
    expect(resolveLaneFailoverModel(CHAIN, 1)).toBe("github-copilot/claude-sonnet-5");
    expect(resolveLaneFailoverModel(CHAIN, 2)).toBe("google/gemini-3.7-flash");
  });

  it("returns null past the end of the chain rather than looping on a dead lane", () => {
    expect(resolveLaneFailoverModel(CHAIN, 3)).toBeNull();
    expect(isLaneFailoverExhausted(CHAIN, 3)).toBe(true);
  });

  it("treats an agent with no chain as 'no failover', not as exhausted", () => {
    // Distinction matters: no chain must keep upstream's wait-for-reset
    // behaviour, not switch to the capped exponential path.
    expect(resolveLaneFailoverModel({ model: "x" }, 1)).toBeNull();
    expect(isLaneFailoverExhausted({ model: "x" }, 1)).toBe(false);
  });

  it("degrades to no-failover on a malformed config instead of throwing", () => {
    expect(readFailoverModels(null)).toEqual([]);
    expect(readFailoverModels({ failoverModels: "not-an-array" })).toEqual([]);
    expect(readFailoverModels({ failoverModels: [1, "", "  ", "ok"] })).toEqual(["ok"]);
    expect(resolveLaneFailoverModel({ failoverModels: [42] }, 1)).toBeNull();
  });

  it("rejects non-positive attempts", () => {
    expect(resolveLaneFailoverModel(CHAIN, 0)).toBeNull();
    expect(resolveLaneFailoverModel(CHAIN, -1)).toBeNull();
  });
});

describe("exhausted-lane backoff", () => {
  it("doubles each attempt: 1m, 2m, 4m, 8m, 16m", () => {
    expect(computeLaneFailoverExhaustedDelayMs(1)).toBe(60_000);
    expect(computeLaneFailoverExhaustedDelayMs(2)).toBe(2 * 60_000);
    expect(computeLaneFailoverExhaustedDelayMs(3)).toBe(4 * 60_000);
    expect(computeLaneFailoverExhaustedDelayMs(4)).toBe(8 * 60_000);
    expect(computeLaneFailoverExhaustedDelayMs(5)).toBe(16 * 60_000);
  });

  it("caps at 30m and never exceeds it, however many attempts", () => {
    expect(computeLaneFailoverExhaustedDelayMs(6)).toBe(LANE_FAILOVER_EXHAUSTED_MAX_DELAY_MS);
    for (const attempt of [7, 12, 50, 1000, Number.MAX_SAFE_INTEGER]) {
      expect(computeLaneFailoverExhaustedDelayMs(attempt)).toBe(LANE_FAILOVER_EXHAUSTED_MAX_DELAY_MS);
    }
  });

  it("never returns a non-positive or NaN delay", () => {
    for (const attempt of [0, -5, 1.5, Number.NaN]) {
      const delay = computeLaneFailoverExhaustedDelayMs(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(LANE_FAILOVER_EXHAUSTED_MAX_DELAY_MS);
    }
  });
});
