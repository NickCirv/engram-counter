/**
 * Provider-shaped conversion examples — proves the disjoint-category
 * metric contract (types.ts LogEntry) end to end, with NO double counting.
 *
 * Two realistic usage-block shapes are converted to the JSONL contract:
 *
 *   1. Anthropic Messages API: `usage.input_tokens` already EXCLUDES the
 *      cache categories (cache_read_input_tokens / cache_creation_input_tokens
 *      are separate fields), so the mapping is 1:1.
 *      Source: platform.claude.com/docs/en/build-with-claude/prompt-caching.
 *
 *   2. OpenAI Chat Completions: `usage.prompt_tokens` INCLUDES
 *      `prompt_tokens_details.cached_tokens`, so a correct converter must
 *      subtract: tokens_sent = prompt_tokens - cached_tokens.
 *      Source: platform.openai.com/docs/guides/prompt-caching.
 *
 * The usage objects below are test fixtures shaped like those APIs' usage
 * blocks, not captured provider responses. The assertions are about
 * engram-counter's arithmetic on each shape, not about provider behavior.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { aggregateCost, aggregateTokens } from "../src/counter";
import { calculateCost, PRICING_2026_05 } from "../src/pricing";
import type { LogEntry, MatchedQuery } from "../src/types";

const SONNET = PRICING_2026_05["claude-sonnet-4-6"]!;
const OPTS = { defaultModel: "claude-sonnet-4-6" } as const;

function pair(baseline: LogEntry, active: LogEntry): MatchedQuery {
  return {
    query_id: baseline.query_id,
    workload: baseline.workload,
    baseline,
    active,
  };
}

// ────────────────────────────────────────────────────────────────────
// 1. Anthropic-shaped usage block: categories arrive disjoint.
// ────────────────────────────────────────────────────────────────────

interface AnthropicShapedUsage {
  input_tokens: number; // EXCLUDES both cache categories
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

/** Correct Anthropic conversion: direct 1:1 field map. */
function fromAnthropicShape(
  query_id: string,
  u: AnthropicShapedUsage,
): LogEntry {
  return {
    query_id,
    timestamp: "2026-10-12T00:00:00Z",
    tokens_sent: u.input_tokens,
    tokens_received: u.output_tokens,
    cache_read_tokens: u.cache_read_input_tokens,
    cache_creation_tokens: u.cache_creation_input_tokens,
  };
}

describe("provider example — Anthropic-shaped usage (disjoint by construction)", () => {
  // 10_000 uncached input, 80_000 cache read, 5_000 cache write, 2_000 output
  const usage: AnthropicShapedUsage = {
    input_tokens: 10_000,
    cache_read_input_tokens: 80_000,
    cache_creation_input_tokens: 5_000,
    output_tokens: 2_000,
  };
  const entry = fromAnthropicShape("q-anthropic-1", usage);

  it("each token lands in exactly one category (no overlap, nothing lost)", () => {
    const categorySum =
      entry.tokens_sent +
      (entry.cache_read_tokens ?? 0) +
      (entry.cache_creation_tokens ?? 0);
    const providerInputTotal =
      usage.input_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens;
    assert.equal(categorySum, providerInputTotal);
    assert.equal(entry.tokens_received, usage.output_tokens);
  });

  it("cost prices every category exactly once at its own rate", () => {
    // Hand-computed at the 2026-05 Sonnet snapshot ($3/M in, $15/M out):
    //   uncached input: 10_000 × $3/M            = $0.03
    //   cache read:     80_000 × $3/M × 0.10     = $0.024
    //   cache write:     5_000 × $3/M × 1.25     = $0.01875
    //   output:          2_000 × $15/M           = $0.03
    //   total                                     = $0.10275
    const cost = calculateCost(entry, SONNET);
    assert.ok(Math.abs(cost - 0.10275) < 1e-12);
  });

  it("token aggregates count uncached traffic; cache totals carry the rest", () => {
    const m = pair(entry, {
      ...entry,
      query_id: "q-anthropic-1",
      tokens_sent: 1_000,
      tokens_received: 500,
      cache_read_tokens: 90_000,
      cache_creation_tokens: 0,
    });
    const tokens = aggregateTokens([m]);
    // baseline_total = 10_000 + 2_000; active_total = 1_000 + 500 — cache excluded.
    assert.equal(tokens.baseline_total, 12_000);
    assert.equal(tokens.active_total, 1_500);

    const cost = aggregateCost([m], PRICING_2026_05, OPTS);
    // Cache traffic is not dropped — it is reported (and priced) in the cost block.
    assert.equal(cost.cache_read_total, 80_000 + 90_000);
    assert.equal(cost.cache_creation_total, 5_000 + 0);
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. OpenAI Chat Completions-shaped usage block: prompt_tokens INCLUDES
//    cached_tokens — the converter must subtract.
// ────────────────────────────────────────────────────────────────────

interface OpenAIShapedUsage {
  prompt_tokens: number; // INCLUDES prompt_tokens_details.cached_tokens
  completion_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
}

/** CORRECT OpenAI conversion: derive the disjoint uncached-input count. */
function fromOpenAIShape(query_id: string, u: OpenAIShapedUsage): LogEntry {
  const cached = u.prompt_tokens_details.cached_tokens;
  assert.ok(
    cached <= u.prompt_tokens,
    "contradictory usage: cached_tokens exceeds prompt_tokens",
  );
  return {
    query_id,
    timestamp: "2026-10-12T00:00:00Z",
    tokens_sent: u.prompt_tokens - cached, // uncached input ONLY
    tokens_received: u.completion_tokens,
    cache_read_tokens: cached,
  };
}

/** NAIVE (WRONG) conversion: passes the cache-inclusive total AND the cache field. */
function fromOpenAIShapeNaive(
  query_id: string,
  u: OpenAIShapedUsage,
): LogEntry {
  return {
    query_id,
    timestamp: "2026-10-12T00:00:00Z",
    tokens_sent: u.prompt_tokens, // still includes cached_tokens — violates contract
    tokens_received: u.completion_tokens,
    cache_read_tokens: u.prompt_tokens_details.cached_tokens,
  };
}

describe("provider example — OpenAI Chat Completions-shaped usage (overlapping input total)", () => {
  // 100_000 prompt tokens of which 60_000 were cached; 3_000 completion tokens.
  const usage: OpenAIShapedUsage = {
    prompt_tokens: 100_000,
    completion_tokens: 3_000,
    prompt_tokens_details: { cached_tokens: 60_000 },
  };

  it("correct conversion yields disjoint categories that re-sum to the provider total", () => {
    const entry = fromOpenAIShape("q-openai-1", usage);
    assert.equal(entry.tokens_sent, 40_000);
    assert.equal(entry.cache_read_tokens, 60_000);
    assert.equal(
      entry.tokens_sent + (entry.cache_read_tokens ?? 0),
      usage.prompt_tokens,
    );
  });

  it("correct conversion prices each prompt token exactly once", () => {
    // Hand-computed at the 2026-05 Sonnet snapshot:
    //   uncached input: 40_000 × $3/M        = $0.12
    //   cache read:     60_000 × $3/M × 0.10 = $0.018
    //   output:          3_000 × $15/M       = $0.045
    //   total                                 = $0.183
    const cost = calculateCost(fromOpenAIShape("q-openai-1", usage), SONNET);
    assert.ok(Math.abs(cost - 0.183) < 1e-12);
  });

  it("naive conversion double-counts cost by exactly cached_tokens × full input rate", () => {
    const correct = calculateCost(fromOpenAIShape("q-openai-1", usage), SONNET);
    const naive = calculateCost(
      fromOpenAIShapeNaive("q-openai-1", usage),
      SONNET,
    );
    // The 60_000 cached tokens are charged a second time at the FULL input
    // rate inside tokens_sent: 60_000 × $3/M = $0.18 of phantom cost.
    const phantom = (60_000 / 1_000_000) * SONNET.inputPerMillion;
    assert.ok(naive > correct);
    assert.ok(Math.abs(naive - correct - phantom) < 1e-12);
  });

  it("naive conversion also inflates token aggregates by the cached count", () => {
    const correctEntry = fromOpenAIShape("q-openai-1", usage);
    const naiveEntry = fromOpenAIShapeNaive("q-openai-1", usage);
    const base: LogEntry = {
      query_id: "q-openai-1",
      timestamp: "2026-10-12T00:00:00Z",
      tokens_sent: 0,
      tokens_received: 0,
    };
    const correctAgg = aggregateTokens([pair(correctEntry, base)]);
    const naiveAgg = aggregateTokens([pair(naiveEntry, base)]);
    assert.equal(correctAgg.baseline_total, 40_000 + 3_000);
    assert.equal(naiveAgg.baseline_total, 100_000 + 3_000);
    assert.equal(
      naiveAgg.baseline_total - correctAgg.baseline_total,
      usage.prompt_tokens_details.cached_tokens,
    );
  });

  it("rejects contradictory usage (cached_tokens > prompt_tokens) instead of zeroing", () => {
    assert.throws(() =>
      fromOpenAIShape("q-bad", {
        prompt_tokens: 100,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 101 },
      }),
    );
  });
});
