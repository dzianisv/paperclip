/**
 * Model-lane failover.
 *
 * An agent's lane is two scalars (`adapterType` + `adapterConfig.model`) with no
 * way to express an alternative, so one dead provider takes the whole org down:
 * every run fails, agents go `status=error`, and missing-disposition recovery
 * forces their issues to `blocked` with no blocker relation and therefore no
 * wake path at all. That is exactly what an expired Claude OAuth token did to a
 * 9-agent company on 2026-08-17, stranding 26 issues.
 *
 * `provider_quota` already detects that a lane is spent, but its only remedy is
 * to wait out `retryNotBefore`. Waiting cannot help when the credential is gone
 * rather than throttled, and it burns the entire reset window while another paid
 * lane sits idle.
 *
 * `adapterConfig.failoverModels` is the missing list. Naming follows the
 * upstream feature request, paperclipai/paperclip#3374.
 */

/** Base wait once every declared lane has been tried and failed. */
export const LANE_FAILOVER_EXHAUSTED_BASE_DELAY_MS = 60 * 1000;

/**
 * Hard ceiling on the exhausted-lane wait.
 *
 * The generic bounded ladder escalates to 2h, which strands an agent long after
 * a provider quota window — typically minutes — would have reopened.
 */
export const LANE_FAILOVER_EXHAUSTED_MAX_DELAY_MS = 30 * 60 * 1000;

/**
 * Switching lane needs no wait, but never schedule at 0: a lane that fails
 * instantly would spin the scheduler.
 */
export const LANE_FAILOVER_SWITCH_DELAY_MS = 5 * 1000;

/**
 * Read the ordered failover chain off an agent's adapter config.
 * Non-string and blank entries are dropped so a malformed config degrades to
 * "no failover" rather than throwing inside the retry scheduler.
 */
export function readFailoverModels(adapterConfig: unknown): string[] {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return [];
  const configured = (adapterConfig as Record<string, unknown>).failoverModels;
  if (!Array.isArray(configured)) return [];
  return configured
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

/**
 * Model for retry attempt N: attempt 1 takes entry 0, attempt 2 takes entry 1.
 * Returns null past the end of the chain, which the caller treats as "exhausted"
 * and answers with a capped exponential wait instead of looping on lanes already
 * known to be dead.
 */
export function resolveLaneFailoverModel(adapterConfig: unknown, attempt: number): string | null {
  if (!Number.isInteger(attempt) || attempt <= 0) return null;
  const models = readFailoverModels(adapterConfig);
  if (models.length === 0) return null;
  return models[attempt - 1] ?? null;
}

/** True when a failover chain exists but this attempt has run past the end of it. */
export function isLaneFailoverExhausted(adapterConfig: unknown, attempt: number): boolean {
  return (
    readFailoverModels(adapterConfig).length > 0 &&
    resolveLaneFailoverModel(adapterConfig, attempt) === null
  );
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
