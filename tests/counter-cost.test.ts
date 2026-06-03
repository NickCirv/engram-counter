/**
 * Tests for v0.2 aggregateCost() — the FinOps-correct aggregator.
 *
 * Covers:
 *   - Pure-token cost (v0.1.x JSONL, no cache fields)
 *   - Cache-aware cost (v0.2 JSONL with cache fields)
 *   - Cross-platform reproducibility (rounded at 4dp)
 *   - Empty input edge case
 *   - Realistic real-world-derived data sanity-check
 *   - Saved-pct sign-flips (cost increase scenarios)
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { aggregateCost } from "../src/counter";
import { PRICING_2026_05 } from "../src/pricing";
import type { MatchedQuery, LogEntry } from "../src/types";

const SONNET_OPTS = { defaultModel: "claude-sonnet-4-6" } as const;
const OPUS_OPTS = { defaultModel: "claude-opus-4-7" } as const;

function mq(
  baseline: Partial<LogEntry>,
  active: Partial<LogEntry>,
  query_id = "q-001",
): MatchedQuery {
  const fill = (e: Partial<LogEntry>): LogEntry => ({
    query_id,
    timestamp: "2026-05-29T00:00:00Z",
    tokens_sent: 0,
    tokens_received: 0,
    ...e,
  });
  return { query_id, workload: undefined, baseline: fill(baseline), active: fill(active) };
}

describe("aggregateCost() — pure-token (v0.1.x compatibility)", () => {
  it("computes baseline + active cost from input/output tokens only", () => {
    // baseline: 100K input + 10K output → 100K × $3/M + 10K × $15/M = $0.30 + $0.15 = $0.45
    // active:    50K input +  5K output →  50K × $3/M +  5K × $15/M = $0.15 + $0.075 = $0.225
    // saved:    $0.225, saved_pct: 50.00%
    const m = mq(
      { tokens_sent: 100_000, tokens_received: 10_000 },
      { tokens_sent: 50_000, tokens_received: 5_000 },
    );
    const agg = aggregateCost([m], PRICING_2026_05, SONNET_OPTS);
    assert.equal(agg.baseline_cost_usd, 0.45);
    assert.equal(agg.active_cost_usd, 0.225);
    assert.equal(agg.saved_cost_usd, 0.225);
    assert.equal(agg.saved_pct, 50);
    assert.equal(agg.cache_read_total, 0);
    assert.equal(agg.cache_creation_total, 0);
  });

  it("returns zeros for empty input", () => {
    const agg = aggregateCost([], PRICING_2026_05, SONNET_OPTS);
    assert.equal(agg.baseline_cost_usd, 0);
    assert.equal(agg.active_cost_usd, 0);
    assert.equal(agg.saved_cost_usd, 0);
    assert.equal(agg.saved_pct, 0);
    assert.equal(agg.cache_read_total, 0);
    assert.equal(agg.cache_creation_total, 0);
  });

  it("zero baseline produces saved_pct=0 (no division by zero)", () => {
    const m = mq({}, { tokens_sent: 1000, tokens_received: 100 });
    const agg = aggregateCost([m], PRICING_2026_05, SONNET_OPTS);
    assert.equal(agg.baseline_cost_usd, 0);
    assert.equal(agg.saved_pct, 0);
  });
});

describe("aggregateCost() — cache-aware (v0.2)", () => {
  it("includes cache_read at 0.1× and cache_creation at 1.25×", () => {
    // baseline: pure input, no cache → 100K × $3/M = $0.30
    // active: 10K input + 100K cache_read + 50K cache_creation
    //   = 10K × $3/M + 100K × $3/M × 0.1 + 50K × $3/M × 1.25
    //   = $0.030 + $0.030 + $0.1875 = $0.2475
    // saved: $0.0525, saved_pct: 17.50%
    const m = mq(
      { tokens_sent: 100_000, tokens_received: 0 },
      {
        tokens_sent: 10_000,
        cache_read_tokens: 100_000,
        cache_creation_tokens: 50_000,
        tokens_received: 0,
      },
    );
    const agg = aggregateCost([m], PRICING_2026_05, SONNET_OPTS);
    assert.equal(agg.baseline_cost_usd, 0.3);
    assert.equal(agg.active_cost_usd, 0.2475);
    assert.equal(agg.saved_cost_usd, 0.0525);
    assert.equal(agg.saved_pct, 17.5);
    assert.equal(agg.cache_read_total, 100_000);
    assert.equal(agg.cache_creation_total, 50_000);
  });

  it("sums cache totals across baseline AND active rows", () => {
    const m = mq(
      { cache_read_tokens: 1000, cache_creation_tokens: 500 },
      { cache_read_tokens: 2000, cache_creation_tokens: 800 },
    );
    const agg = aggregateCost([m], PRICING_2026_05, SONNET_OPTS);
    assert.equal(agg.cache_read_total, 3000);
    assert.equal(agg.cache_creation_total, 1300);
  });

  it("multiple matched queries accumulate correctly", () => {
    const queries = [
      mq({ tokens_sent: 10_000 }, { tokens_sent: 5_000 }, "q-001"),
      mq({ tokens_sent: 20_000 }, { tokens_sent: 8_000 }, "q-002"),
      mq({ tokens_sent: 30_000 }, { tokens_sent: 10_000 }, "q-003"),
    ];
    const agg = aggregateCost(queries, PRICING_2026_05, SONNET_OPTS);
    // baseline: 60K × $3/M = $0.18
    // active:   23K × $3/M = $0.069
    // saved:    $0.111
    assert.equal(agg.baseline_cost_usd, 0.18);
    assert.equal(agg.active_cost_usd, 0.069);
    assert.equal(agg.saved_cost_usd, 0.111);
  });
});

describe("aggregateCost() — reproducibility (4dp rounding)", () => {
  it("results are byte-stable across re-runs (no float drift)", () => {
    // A test input that would produce float drift if rounding was skipped.
    const q1 = mq(
      { tokens_sent: 12_345, tokens_received: 678 },
      { tokens_sent: 1234, cache_read_tokens: 11_111, cache_creation_tokens: 2222, tokens_received: 678 },
    );
    const q2 = mq(
      { tokens_sent: 9876, tokens_received: 543 },
      { tokens_sent: 987, cache_read_tokens: 8889, cache_creation_tokens: 1111, tokens_received: 543 },
    );
    const agg1 = aggregateCost([q1, q2], PRICING_2026_05, SONNET_OPTS);
    const agg2 = aggregateCost([q1, q2], PRICING_2026_05, SONNET_OPTS);
    // Deep equality — same input → same output, bit-identical floats.
    assert.deepEqual(agg1, agg2);
  });

  it("USD values round cleanly to 4dp (no trailing 1e-17 dust)", () => {
    // Provoke 0.1+0.2 style float behavior with values designed to drift.
    const m = mq(
      { tokens_sent: 333, tokens_received: 666 },
      { tokens_sent: 111, tokens_received: 222 },
    );
    const agg = aggregateCost([m], PRICING_2026_05, SONNET_OPTS);
    // baseline = 333 × 3/M + 666 × 15/M = 0.000999 + 0.00999 = 0.010989
    // Rounds to 4dp: 0.011
    assert.equal(agg.baseline_cost_usd, 0.011);
    // Active = 111 × 3/M + 222 × 15/M = 0.000333 + 0.00333 = 0.003663
    // Rounds to 4dp: 0.0037
    assert.equal(agg.active_cost_usd, 0.0037);
  });
});

describe("aggregateCost() — regression (cost INCREASE)", () => {
  it("negative saved_cost_usd and negative saved_pct for cost regressions", () => {
    // baseline cheap, active expensive (engram made it worse)
    const m = mq(
      { tokens_sent: 1000, tokens_received: 100 }, // baseline $0.003 + $0.0015 = $0.0045
      { tokens_sent: 5000, tokens_received: 500 }, // active   $0.015 + $0.0075 = $0.0225
    );
    const agg = aggregateCost([m], PRICING_2026_05, SONNET_OPTS);
    // saved = 0.0045 - 0.0225 = -0.018 (negative — cost INCREASED)
    // saved_pct = -400%
    assert.ok(agg.saved_cost_usd < 0, `expected negative saved, got ${agg.saved_cost_usd}`);
    assert.ok(agg.saved_pct < 0, `expected negative saved_pct, got ${agg.saved_pct}`);
    assert.equal(agg.saved_cost_usd, -0.018);
    assert.equal(agg.saved_pct, -400);
  });
});

describe("aggregateCost() — real-world data sanity-check", () => {
  it("approximates a real baseline vs cache-enabled agent run", () => {
    // Real aggregate from a paired agent run (baseline + cache-enabled arm)
    // baseline:      input=435731, cache=0, output=14435  → $1.5237
    // cache-enabled: input=14128,  cr=274806, cc=158820, output=14951 → $0.9447
    // saved = $0.579, saved_pct ≈ 38%
    const m = mq(
      { tokens_sent: 435_731, tokens_received: 14_435 },
      {
        tokens_sent: 14_128,
        cache_read_tokens: 274_806,
        cache_creation_tokens: 158_820,
        tokens_received: 14_951,
      },
    );
    const agg = aggregateCost([m], PRICING_2026_05, SONNET_OPTS);
    assert.ok(Math.abs(agg.baseline_cost_usd - 1.5237) < 0.01, `got ${agg.baseline_cost_usd}`);
    assert.ok(Math.abs(agg.active_cost_usd - 0.9447) < 0.01, `got ${agg.active_cost_usd}`);
    // Saved_pct is in the +37-39% range (independently verified); allow 1pp tolerance.
    assert.ok(Math.abs(agg.saved_pct - 38) < 1, `expected ~+38%, got ${agg.saved_pct}`);
  });
});

describe("aggregateCost() — provenance metadata", () => {
  it("defaults model + pricing_version when opts fully omitted", () => {
    const m = mq({ tokens_sent: 1000 }, { tokens_sent: 500 });
    const agg = aggregateCost([m], PRICING_2026_05); // no opts at all
    assert.equal(agg.model, "claude-sonnet-4-6"); // DEFAULT_MODEL
    assert.equal(agg.pricing_version, "anthropic-2026-05"); // PRICING_VERSION
  });

  it("embeds explicit model + pricing_version when meta provided", () => {
    const m = mq({ tokens_sent: 1000 }, { tokens_sent: 500 });
    const agg = aggregateCost([m], PRICING_2026_05, {
      defaultModel: "claude-opus-4-7",
      pricing_version: "anthropic-2026-05",
    });
    assert.equal(agg.model, "claude-opus-4-7");
    assert.equal(agg.pricing_version, "anthropic-2026-05");
  });

  it("pricing_version label does not affect the numeric aggregates (model does)", () => {
    // The version STRING is provenance metadata — it must not change the math.
    // (The MODEL legitimately does change rates; that's tested separately.)
    const m = mq({ tokens_sent: 100_000 }, { tokens_sent: 50_000 });
    const a = aggregateCost([m], PRICING_2026_05, { defaultModel: "claude-sonnet-4-6", pricing_version: "label-A" });
    const b = aggregateCost([m], PRICING_2026_05, { defaultModel: "claude-sonnet-4-6", pricing_version: "label-B" });
    assert.equal(a.saved_cost_usd, b.saved_cost_usd);
    assert.equal(a.saved_pct, b.saved_pct);
  });
});

describe("aggregateCost() — per-row model pricing (HIGH bug fix 2026-05-30)", () => {
  it("prices each row by its OWN model field, not one CLI-chosen SKU", () => {
    // Realistic cost-reduction scenario: baseline on Opus, active routed to Haiku.
    // 100K input both. Opus baseline = 100K × $15/M = $1.50.
    // Haiku active = 100K × $0.80/M = $0.08. saved = $1.42 (94.67%).
    // The OLD bug priced both at one model → wrong cost + false provenance.
    const m = mq(
      { tokens_sent: 100_000, model: "claude-opus-4-7" },
      { tokens_sent: 100_000, model: "claude-haiku-4-5" },
    );
    const agg = aggregateCost([m], PRICING_2026_05); // default sonnet, but rows override
    assert.equal(agg.baseline_cost_usd, 1.5, "baseline must be priced at Opus rate");
    assert.equal(agg.active_cost_usd, 0.08, "active must be priced at Haiku rate");
    assert.equal(agg.saved_cost_usd, 1.42);
  });

  it("reports model='mixed' when rows span multiple models (honest provenance)", () => {
    const m = mq(
      { tokens_sent: 1000, model: "claude-opus-4-7" },
      { tokens_sent: 500, model: "claude-haiku-4-5" },
    );
    const agg = aggregateCost([m], PRICING_2026_05);
    assert.equal(agg.model, "mixed", "must not stamp a single false SKU on mixed data");
  });

  it("reports the single model when all rows agree (uniform provenance)", () => {
    const m = mq(
      { tokens_sent: 1000, model: "claude-opus-4-7" },
      { tokens_sent: 500, model: "claude-opus-4-7" },
    );
    const agg = aggregateCost([m], PRICING_2026_05);
    assert.equal(agg.model, "claude-opus-4-7");
  });

  it("falls back to defaultModel for rows lacking a model field", () => {
    const m = mq({ tokens_sent: 1000 }, { tokens_sent: 500 }); // no model fields
    const agg = aggregateCost([m], PRICING_2026_05, { defaultModel: "claude-haiku-4-5" });
    assert.equal(agg.model, "claude-haiku-4-5");
    // 1000 × $0.80/M = $0.0008, 500 × $0.80/M = $0.0004
    assert.equal(agg.baseline_cost_usd, 0.0008);
  });

  it("throws LOUD on an unknown ROW model even with a valid default (no silent fallback)", () => {
    // CODE-REVIEW FIX 2026-05-30: an explicit-but-unknown row model must THROW,
    // not silently fall back to the (valid) default — silent fallback would
    // mis-price the row and stamp false provenance. THIS is the procurement bug.
    const m = mq(
      { tokens_sent: 1000, model: "claude-opus-4-7" },
      { tokens_sent: 500, model: "claude-OFF-MENU-9" }, // unknown, but default IS valid
    );
    assert.throws(
      () => aggregateCost([m], PRICING_2026_05, { defaultModel: "claude-sonnet-4-6" }),
      /not in the pricing snapshot/,
    );
  });

  it("does NOT throw when a row simply lacks a model field (uses valid default)", () => {
    const m = mq({ tokens_sent: 1000 }, { tokens_sent: 500 }); // no model fields
    assert.doesNotThrow(() => aggregateCost([m], PRICING_2026_05, { defaultModel: "claude-sonnet-4-6" }));
  });
});

describe("aggregateCost() — pricing independence", () => {
  it("Opus 4.7 produces 5× higher costs on same tokens (no caching)", () => {
    const m = mq(
      { tokens_sent: 100_000, tokens_received: 0 },
      { tokens_sent: 50_000, tokens_received: 0 },
    );
    const sonnetAgg = aggregateCost([m], PRICING_2026_05, SONNET_OPTS);
    const opusAgg = aggregateCost([m], PRICING_2026_05, OPUS_OPTS);
    // saved_cost should be exactly 5× higher under Opus
    assert.ok(
      Math.abs(opusAgg.saved_cost_usd / sonnetAgg.saved_cost_usd - 5) < 1e-6,
      `ratio: ${opusAgg.saved_cost_usd / sonnetAgg.saved_cost_usd}`,
    );
    // saved_pct should be IDENTICAL (cost ratio is constant)
    assert.equal(sonnetAgg.saved_pct, opusAgg.saved_pct);
  });
});
