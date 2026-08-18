/**
 * Adapter+model lane failover.
 *
 * An agent's lane is two scalars (`adapterType` + `adapterConfig.model`) with no
 * way to express an alternative, so one dead provider takes the whole org down:
 * every run fails, agents go `status=error`, and missing-disposition recovery
 * forces their issues to `blocked` with no blocker relation and therefore no
 * wake path at all. An expired Claude OAuth token did exactly that to a 9-agent
 * company on 2026-08-17, stranding 26 issues.
 *
 * `provider_quota` already detects a spent lane, but its only remedy is to wait
 * out `retryNotBefore`. Waiting cannot help when a credential is gone rather
 * than throttled, and it burns the whole reset window while another paid lane
 * sits idle. Per paperclipai/paperclip#7891 the only supported failover today is
 * a manual `PATCH /api/agents/:id {adapterType}`.
 *
 * Config shape and naming follow the upstream request, #2743:
 *
 *   "adapterConfig": {
 *     "model": "claude-opus-5",
 *     "fallbackChain": [
 *       { "model": "claude-sonnet-5" },
 *       { "adapterType": "pi_local", "model": "github-copilot/claude-sonnet-5" },
 *       { "adapterType": "claude_local", "model": "claude-opus-5" }
 *     ]
 *   }
 *
 * `adapterType` is optional: omitted means "keep the current adapter, swap the
 * model only", which makes model-only failover (#3374) a special case of the
 * same mechanism. Crossing adapters is the case that actually matters here —
 * Copilot and Google run on `pi_local` while Claude Max runs on `claude_local`,
 * so a model-only swap cannot reach the second subscription at all.
 */

/** Base wait once every declared lane has been tried and failed. */
export const LANE_FAILOVER_EXHAUSTED_BASE_DELAY_MS = 60 * 1000;

/**
 * Hard ceiling on the exhausted-lane wait. The generic bounded ladder escalates
 * to 2h, which strands an agent long after a provider quota window — typically
 * minutes — would have reopened.
 */
export const LANE_FAILOVER_EXHAUSTED_MAX_DELAY_MS = 30 * 60 * 1000;

/**
 * Switching lane needs no wait, but never schedule at 0: a lane that fails
 * instantly would spin the scheduler.
 */
export const LANE_FAILOVER_SWITCH_DELAY_MS = 5 * 1000;

/** Context keys carried on the retry run so the executor can apply the switch. */
export const LANE_FAILOVER_MODEL_KEY = "laneFailoverModel";
export const LANE_FAILOVER_ADAPTER_TYPE_KEY = "laneFailoverAdapterType";

export type LaneFallbackEntry = {
  /** Omitted means "keep the agent's current adapter". */
  adapterType: string | null;
  model: string;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the ordered chain off an agent's adapter config.
 *
 * Accepts both the object form `{adapterType?, model}` and a bare string, so a
 * model-only chain stays valid. Malformed entries are dropped rather than
 * thrown, so a bad config degrades to "no failover" instead of breaking the
 * retry scheduler for every agent.
 */
export function readFallbackChain(adapterConfig: unknown): LaneFallbackEntry[] {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return [];
  const configured = (adapterConfig as Record<string, unknown>).fallbackChain;
  if (!Array.isArray(configured)) return [];

  const chain: LaneFallbackEntry[] = [];
  for (const raw of configured) {
    if (typeof raw === "string") {
      const model = raw.trim();
      if (model) chain.push({ adapterType: null, model });
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const model = readString(entry.model);
    if (!model) continue;
    chain.push({ adapterType: readString(entry.adapterType) || null, model });
  }
  return chain;
}

/**
 * Lane for retry attempt N: attempt 1 takes entry 0, attempt 2 takes entry 1.
 * Returns null past the end, which the caller treats as "exhausted" and answers
 * with a capped exponential wait instead of looping on lanes known to be dead.
 */
export function resolveLaneFallback(adapterConfig: unknown, attempt: number): LaneFallbackEntry | null {
  if (!Number.isInteger(attempt) || attempt <= 0) return null;
  const chain = readFallbackChain(adapterConfig);
  if (chain.length === 0) return null;
  return chain[attempt - 1] ?? null;
}

/** True when a chain exists but this attempt has run past the end of it. */
export function isLaneFailoverExhausted(adapterConfig: unknown, attempt: number): boolean {
  return readFallbackChain(adapterConfig).length > 0 && resolveLaneFallback(adapterConfig, attempt) === null;
}

/**
 * Capped exponential backoff: 1m, 2m, 4m, 8m, 16m, then 30m forever.
 * Only reached once every declared lane is dead, where retrying hard is waste.
 */
export function computeLaneFailoverExhaustedDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt <= 0) {
    return LANE_FAILOVER_EXHAUSTED_BASE_DELAY_MS;
  }
  // 2^30 already exceeds the cap; clamp so the exponent cannot overflow.
  const exponent = Math.min(attempt - 1, 30);
  const delay = LANE_FAILOVER_EXHAUSTED_BASE_DELAY_MS * 2 ** exponent;
  return Math.min(delay, LANE_FAILOVER_EXHAUSTED_MAX_DELAY_MS);
}

/**
 * Adapter this run must actually execute on.
 *
 * The override is per-run and lives on the run context, never on the agent row,
 * so a deliberate lane pin survives and one healthy retry cannot silently
 * re-home an agent.
 *
 * `isKnownAdapterType` is injected rather than imported to keep this module free
 * of the adapter registry, which drags in every adapter package. An unrecognised
 * type (typo, adapter removed since the retry was scheduled) falls back to the
 * agent's own adapter instead of failing the run.
 */
export function resolveEffectiveAdapterType(input: {
  agentAdapterType: string;
  contextSnapshot: unknown;
  isKnownAdapterType: (adapterType: string) => boolean;
}): { adapterType: string; overridden: boolean; rejected: string | null } {
  const { agentAdapterType, contextSnapshot, isKnownAdapterType } = input;
  if (typeof contextSnapshot !== "object" || contextSnapshot === null) {
    return { adapterType: agentAdapterType, overridden: false, rejected: null };
  }
  const requested = readString((contextSnapshot as Record<string, unknown>)[LANE_FAILOVER_ADAPTER_TYPE_KEY]);
  if (!requested || requested === agentAdapterType) {
    return { adapterType: agentAdapterType, overridden: false, rejected: null };
  }
  if (!isKnownAdapterType(requested)) {
    return { adapterType: agentAdapterType, overridden: false, rejected: requested };
  }
  return { adapterType: requested, overridden: true, rejected: null };
}
