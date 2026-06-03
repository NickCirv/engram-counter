/**
 * Tests for v0.2 pricing module.
 *
 * Triple-audit:
 *   AUDIT 1: tsc --noEmit on this file (run via `npm run lint`)
 *   AUDIT 2: tsx --test runs these tests (run via `npm test`)
 *   AUDIT 3: cost calc sanity-checked against known reference-benchmark values
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  PRICING_2026_05,
  DEFAULT_MODEL,
  PRICING_VERSION,
  resolvePricing,
  calculateCost,
  type ModelPricing,
} from "../src/pricing";

describe("PRICING_2026_05 snapshot", () => {
  it("contains the three model SKUs from the design doc", () => {
    assert.ok("claude-sonnet-4-6" in PRICING_2026_05);
    assert.ok("claude-opus-4-7" in PRICING_2026_05);
    assert.ok("claude-haiku-4-5" in PRICING_2026_05);
  });

  it("Sonnet 4.6 rates match anthropic.com/pricing (2026-05)", () => {
    const sonnet = PRICING_2026_05["claude-sonnet-4-6"]!;
    assert.equal(sonnet.inputPerMillion, 3.0);
    assert.equal(sonnet.outputPerMillion, 15.0);
    assert.equal(sonnet.cacheReadMultiplier, 0.1);
    assert.equal(sonnet.cacheCreateMultiplier, 1.25);
  });

  it("Opus 4.7 rates match anthropic.com/pricing (2026-05)", () => {
    const opus = PRICING_2026_05["claude-opus-4-7"]!;
    assert.equal(opus.inputPerMillion, 15.0);
    assert.equal(opus.outputPerMillion, 75.0);
  });

  it("Haiku 4.5 rates match anthropic.com/pricing (2026-05)", () => {
    const haiku = PRICING_2026_05["claude-haiku-4-5"]!;
    assert.equal(haiku.inputPerMillion, 0.8);
    assert.equal(haiku.outputPerMillion, 4.0);
  });

  it("snapshot is deeply frozen to prevent runtime mutation", () => {
    assert.ok(Object.isFrozen(PRICING_2026_05));
    assert.ok(Object.isFrozen(PRICING_2026_05["claude-sonnet-4-6"]));
  });
});

describe("DEFAULT_MODEL + PRICING_VERSION", () => {
  it("DEFAULT_MODEL matches the reference benchmark model", () => {
    assert.equal(DEFAULT_MODEL, "claude-sonnet-4-6");
  });

  it("PRICING_VERSION is a stable opaque string for audit envelopes", () => {
    assert.equal(PRICING_VERSION, "anthropic-2026-05");
  });
});

describe("resolvePricing()", () => {
  it("returns the requested model when present", () => {
    const p = resolvePricing("claude-opus-4-7");
    assert.equal(p?.inputPerMillion, 15.0);
  });

  it("falls back to DEFAULT_MODEL when requested model absent", () => {
    const p = resolvePricing("nonexistent-model-xyz");
    assert.equal(p?.inputPerMillion, 3.0); // Sonnet rate
  });

  it("falls back to DEFAULT_MODEL when model is undefined (v0.1.x JSONL)", () => {
    const p = resolvePricing(undefined);
    assert.equal(p?.inputPerMillion, 3.0);
  });

  it("accepts a custom snapshot for projecting at historical rates", () => {
    const customSnapshot: Record<string, ModelPricing> = {
      "test-model": {
        inputPerMillion: 100,
        outputPerMillion: 500,
        cacheReadMultiplier: 0.1,
        cacheCreateMultiplier: 1.25,
      },
    };
    const p = resolvePricing("test-model", customSnapshot, "test-model");
    assert.equal(p?.inputPerMillion, 100);
  });

  it("returns undefined when neither model nor fallback exist", () => {
    const emptySnapshot: Record<string, ModelPricing> = {};
    const p = resolvePricing("anything", emptySnapshot, "also-missing");
    assert.equal(p, undefined);
  });
});

describe("calculateCost() — Sonnet 4.6 examples", () => {
  const sonnet = PRICING_2026_05["claude-sonnet-4-6"]!;

  it("v0.1.x row (no cache fields) reduces to input × output formula", () => {
    const cost = calculateCost(
      { tokens_sent: 1_000_000, tokens_received: 100_000 },
      sonnet,
    );
    // 1M input × $3 + 100K output × $15/M = $3 + $1.50 = $4.50
    assert.equal(cost, 4.5);
  });

  it("v0.2 row with caching computes FinOps-correct cost", () => {
    const cost = calculateCost(
      {
        tokens_sent: 1000,
        cache_read_tokens: 100_000,
        cache_creation_tokens: 10_000,
        tokens_received: 1_000,
      },
      sonnet,
    );
    // 1000 × $3/M = $0.003
    // 100K × $3/M × 0.1 = $0.030
    // 10K × $3/M × 1.25 = $0.0375
    // 1000 × $15/M = $0.015
    // Total: $0.0855
    const expected = 0.003 + 0.03 + 0.0375 + 0.015;
    assert.ok(
      Math.abs(cost - expected) < 1e-9,
      `expected ${expected}, got ${cost}`,
    );
  });

  it("empty row produces zero cost", () => {
    assert.equal(calculateCost({}, sonnet), 0);
  });

  it("matches a real baseline (no-cache) agent run within $0.01", () => {
    // Aggregate from a real baseline agent run: input=435731, cache=0, output=14435
    const cost = calculateCost(
      {
        tokens_sent: 435_731,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        tokens_received: 14_435,
      },
      sonnet,
    );
    // 435731 × $3/M + 14435 × $15/M = $1.3072 + $0.2165 = $1.5237
    assert.ok(
      Math.abs(cost - 1.5237) < 0.01,
      `expected ~$1.5237 from the baseline run aggregate, got $${cost.toFixed(4)}`,
    );
  });

  it("matches a real cache-enabled agent run within $0.01", () => {
    // Aggregate from a real cache-enabled agent run:
    // input=14128, cache_read=274806, cache_create=158820, output=14951
    const cost = calculateCost(
      {
        tokens_sent: 14_128,
        cache_read_tokens: 274_806,
        cache_creation_tokens: 158_820,
        tokens_received: 14_951,
      },
      sonnet,
    );
    // 14128 × $3/M = $0.0424
    // 274806 × $3/M × 0.1 = $0.0824
    // 158820 × $3/M × 1.25 = $0.5956
    // 14951 × $15/M = $0.2243
    // Total ≈ $0.9447
    assert.ok(
      Math.abs(cost - 0.9447) < 0.01,
      `expected ~$0.9447 from the cache-enabled run aggregate, got $${cost.toFixed(4)}`,
    );
  });
});

describe("calculateCost() — cross-model sanity", () => {
  it("Opus 4.7 is 5× more expensive than Sonnet 4.6 on same tokens", () => {
    const tokens = {
      tokens_sent: 100_000,
      tokens_received: 10_000,
    };
    const sonnetCost = calculateCost(tokens, PRICING_2026_05["claude-sonnet-4-6"]!);
    const opusCost = calculateCost(tokens, PRICING_2026_05["claude-opus-4-7"]!);
    // Sonnet: 100K × $3/M + 10K × $15/M = $0.30 + $0.15 = $0.45
    // Opus:   100K × $15/M + 10K × $75/M = $1.50 + $0.75 = $2.25 (exactly 5×)
    // Float arithmetic gives 4.999999...; use tolerance.
    assert.ok(
      Math.abs(opusCost / sonnetCost - 5) < 1e-9,
      `expected ratio ~5, got ${opusCost / sonnetCost}`,
    );
  });

  it("Haiku 4.5 is ~3.75× cheaper than Sonnet 4.6", () => {
    const tokens = { tokens_sent: 1_000_000, tokens_received: 0 };
    const sonnetCost = calculateCost(tokens, PRICING_2026_05["claude-sonnet-4-6"]!);
    const haikuCost = calculateCost(tokens, PRICING_2026_05["claude-haiku-4-5"]!);
    assert.ok(
      Math.abs(sonnetCost / haikuCost - 3.75) < 1e-9,
      `expected ratio ~3.75, got ${sonnetCost / haikuCost}`,
    );
  });
});
