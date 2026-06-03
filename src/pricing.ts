/**
 * engram-counter v0.2 — Anthropic model pricing snapshots.
 *
 * Frozen pricing tables for cost_saved_pct computation. Pinned to a
 * version-stamped snapshot so audit hashes remain reproducible even
 * if Anthropic rates change in the future.
 *
 * Source: anthropic.com/pricing as of 2026-05.
 * Cache multipliers per platform.claude.com/docs/en/build-with-claude/prompt-caching.
 *
 * Multi-snapshot pattern: future versions add new const tables
 * (PRICING_2026_08, etc.) without removing prior ones. Customers can
 * recompute historical audits by selecting the matching snapshot.
 *
 * Design decision: ship the 2026-05 snapshot only for v0.2; add historical
 * snapshots when a customer needs to reproduce an audit under past pricing.
 */

export interface ModelPricing {
  /** $/M for non-cached input tokens. */
  readonly inputPerMillion: number;
  /** $/M for output tokens. */
  readonly outputPerMillion: number;
  /**
   * Multiplier applied to inputPerMillion for cache_read_input_tokens.
   * Typically 0.10 (90% discount) per Anthropic prompt caching docs.
   */
  readonly cacheReadMultiplier: number;
  /**
   * Multiplier applied to inputPerMillion for cache_creation_input_tokens.
   * Typically 1.25 for 5-min TTL or 2.00 for 1-hour TTL.
   * v0.2 supports only the 5-min default.
   */
  readonly cacheCreateMultiplier: number;
}

/**
 * Pricing snapshot for May 2026. Frozen — do not mutate.
 *
 * Verified against anthropic.com/pricing on 2026-05-29.
 * If Anthropic changes rates, add a new PRICING_2026_XX const rather
 * than mutating this one; audits hashed against 2026-05 must remain
 * reproducible indefinitely.
 */
export const PRICING_2026_05: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "claude-sonnet-4-6": Object.freeze({
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadMultiplier: 0.1,
    cacheCreateMultiplier: 1.25,
  }),
  "claude-opus-4-7": Object.freeze({
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadMultiplier: 0.1,
    cacheCreateMultiplier: 1.25,
  }),
  "claude-haiku-4-5": Object.freeze({
    inputPerMillion: 0.8,
    outputPerMillion: 4.0,
    cacheReadMultiplier: 0.1,
    cacheCreateMultiplier: 1.25,
  }),
});

/**
 * Default model identifier when a JSONL row omits the optional `model` field.
 * v0.1.x JSONL files have no model field; v0.2 treats them as Sonnet 4.6,
 * the default model for the reference benchmark.
 */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Identifier embedded in v0.2 audit envelopes so customers can replay. */
export const PRICING_VERSION = "anthropic-2026-05";

/**
 * Resolve pricing for a given model id, falling back to a provided default.
 * Returns undefined only if BOTH the requested model AND the fallback are
 * absent from the snapshot — caller must handle.
 */
export function resolvePricing(
  model: string | undefined,
  snapshot: Readonly<Record<string, ModelPricing>> = PRICING_2026_05,
  fallback: string = DEFAULT_MODEL,
): ModelPricing | undefined {
  if (model !== undefined && model in snapshot) {
    return snapshot[model];
  }
  return snapshot[fallback];
}

/**
 * FinOps-correct cost calculation for a single JSONL row.
 * Sums input + cache_read (× 0.1) + cache_create (× 1.25) + output.
 *
 * All token fields are treated as optional (default 0) to preserve
 * v0.1.x JSONL back-compat: rows without cache fields get cache=0
 * and reduce to the v0.1.x formula (input × rate + output × output_rate).
 *
 * Returns USD as a JavaScript number. Precision: ~15 significant digits;
 * downstream audit hashing should round/format consistently to avoid
 * float drift across systems.
 */
export function calculateCost(
  row: {
    readonly tokens_sent?: number;
    readonly cache_read_tokens?: number;
    readonly cache_creation_tokens?: number;
    readonly tokens_received?: number;
  },
  pricing: ModelPricing,
): number {
  const input = row.tokens_sent ?? 0;
  const cacheRead = row.cache_read_tokens ?? 0;
  const cacheCreate = row.cache_creation_tokens ?? 0;
  const output = row.tokens_received ?? 0;
  return (
    (input / 1_000_000) * pricing.inputPerMillion +
    (cacheRead / 1_000_000) * pricing.inputPerMillion * pricing.cacheReadMultiplier +
    (cacheCreate / 1_000_000) * pricing.inputPerMillion * pricing.cacheCreateMultiplier +
    (output / 1_000_000) * pricing.outputPerMillion
  );
}
