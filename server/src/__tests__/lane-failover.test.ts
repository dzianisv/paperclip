import { describe, expect, it } from "vitest";
import {
  computeLaneFailoverExhaustedDelayMs,
  isLaneFailoverExhausted,
  LANE_FAILOVER_ADAPTER_TYPE_KEY,
  LANE_FAILOVER_EXHAUSTED_MAX_DELAY_MS,
  readFallbackChain,
  resolveEffectiveAdapterType,
  resolveLaneFallback,
} from "../services/lane-failover.ts";

// Copilot and Google run on pi_local; Claude Max runs on claude_local. Crossing
// adapters is the case that matters: a model-only swap cannot reach the second
// subscription at all.
const CHAIN = {
  model: "anthropic/claude-opus-5",
  fallbackChain: [
    { model: "anthropic/claude-sonnet-5" },
    { adapterType: "pi_local", model: "github-copilot/claude-sonnet-5" },
    { adapterType: "claude_local", model: "claude-opus-5" },
  ],
};

const known = (t: string) => ["pi_local", "claude_local", "codex_local"].includes(t);

describe("fallback chain", () => {
  it("walks the chain in order, one lane per retry attempt", () => {
    expect(resolveLaneFallback(CHAIN, 1)).toEqual({ adapterType: null, model: "anthropic/claude-sonnet-5" });
    expect(resolveLaneFallback(CHAIN, 2)).toEqual({ adapterType: "pi_local", model: "github-copilot/claude-sonnet-5" });
    expect(resolveLaneFallback(CHAIN, 3)).toEqual({ adapterType: "claude_local", model: "claude-opus-5" });
  });

  it("treats a missing adapterType as 'keep the current adapter, swap the model'", () => {
    expect(resolveLaneFallback(CHAIN, 1)?.adapterType).toBeNull();
  });

  it("accepts bare strings so a model-only chain stays valid", () => {
    expect(readFallbackChain({ fallbackChain: ["a/b", "c/d"] })).toEqual([
      { adapterType: null, model: "a/b" },
      { adapterType: null, model: "c/d" },
    ]);
  });

  it("returns null past the end rather than looping on a dead lane", () => {
    expect(resolveLaneFallback(CHAIN, 4)).toBeNull();
    expect(isLaneFailoverExhausted(CHAIN, 4)).toBe(true);
  });

  it("treats an agent with no chain as 'no failover', not as exhausted", () => {
    // Distinction matters: no chain must keep upstream's wait-for-reset
    // behaviour rather than switching to the capped exponential path.
    expect(resolveLaneFallback({ model: "x" }, 1)).toBeNull();
    expect(isLaneFailoverExhausted({ model: "x" }, 1)).toBe(false);
  });

  it("degrades to no-failover on a malformed config instead of throwing", () => {
    expect(readFallbackChain(null)).toEqual([]);
    expect(readFallbackChain({ fallbackChain: "nope" })).toEqual([]);
    expect(readFallbackChain({ fallbackChain: [42, {}, { adapterType: "pi_local" }, { model: "  " }] })).toEqual([]);
    expect(resolveLaneFallback(CHAIN, 0)).toBeNull();
  });
});

describe("effective adapter type", () => {
  it("uses the override when it names a known adapter", () => {
    const r = resolveEffectiveAdapterType({
      agentAdapterType: "pi_local",
      contextSnapshot: { [LANE_FAILOVER_ADAPTER_TYPE_KEY]: "claude_local" },
      isKnownAdapterType: known,
    });
    expect(r).toEqual({ adapterType: "claude_local", overridden: true, rejected: null });
  });

  it("falls back to the agent's adapter when the override is unknown, and reports it", () => {
    // getServerAdapter silently returns the process adapter for unknown types,
    // so an unchecked typo would execute the wrong adapter entirely.
    const r = resolveEffectiveAdapterType({
      agentAdapterType: "pi_local",
      contextSnapshot: { [LANE_FAILOVER_ADAPTER_TYPE_KEY]: "typo_local" },
      isKnownAdapterType: known,
    });
    expect(r).toEqual({ adapterType: "pi_local", overridden: false, rejected: "typo_local" });
  });

  it("is a no-op with no context, no override, or an override equal to the current adapter", () => {
    for (const ctx of [null, {}, { [LANE_FAILOVER_ADAPTER_TYPE_KEY]: "pi_local" }, { [LANE_FAILOVER_ADAPTER_TYPE_KEY]: "  " }]) {
      const r = resolveEffectiveAdapterType({
        agentAdapterType: "pi_local",
        contextSnapshot: ctx,
        isKnownAdapterType: known,
      });
      expect(r.adapterType).toBe("pi_local");
      expect(r.overridden).toBe(false);
    }
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

  it("caps at 30m however many attempts", () => {
    for (const attempt of [6, 7, 12, 50, 1000, Number.MAX_SAFE_INTEGER]) {
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
