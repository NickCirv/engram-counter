/**
 * v0.2 hash semantics for the optional `cost` block on AuditBlock.
 *
 * Properties tested:
 *   1. v0.1.x input (no cost) and v0.2 input WITH cost on otherwise-identical
 *      data → DIFFERENT hashes (cost is part of the attestation surface)
 *   2. v0.2 input → identical re-runs → bit-identical hash (reproducibility)
 *   3. cost block actually appears in the output AuditBlock when set
 *   4. cost block absent in the output AuditBlock when input.cost omitted
 *
 * Back-compat is proven by the EXISTING golden hash tests in
 * integration.test.ts which still pass after these v0.2 changes — that's
 * the empirical evidence that absent-cost JCS canonical form is unchanged.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildAuditBlock, buildAuditOutput, computeAuditTrailHash } from "../src/hash";
import type {
  BuildAuditInput,
  CostAggregates,
  Counts,
  PerWorkloadResult,
  Thresholds,
  TokenAggregates,
  WorkloadFingerprint,
} from "../src/types";

// ─── Test fixtures ──────────────────────────────────────────────────

const FIXED_TOKENS: TokenAggregates = {
  baseline_sent_total: 1000,
  active_sent_total: 200,
  saved_sent: 800,
  baseline_received_total: 100,
  active_received_total: 50,
  saved_received: 50,
  baseline_total: 1100,
  active_total: 250,
  saved_total: 850,
  saved_pct: 77.27,
};

const FIXED_COUNTS: Counts = {
  baseline_entries: 1,
  active_entries: 1,
  matched_queries: 1,
  baseline_only_queries: 0,
  active_only_queries: 0,
};

const FIXED_FINGERPRINT: WorkloadFingerprint = {
  baseline_set: ["refactor"],
  active_set: ["refactor"],
  fingerprint_match: true,
  baseline_counts: { refactor: 1 },
  active_counts: { refactor: 1 },
};

const FIXED_THRESHOLDS: Thresholds = {
  workload_absent_fail_closed: 0.01,
  mismatch_warn: 0.1,
  mismatch_high: 0.5,
  count_skew_warn: 0.5,
};

const FIXED_PER_WORKLOAD: Record<string, PerWorkloadResult> = {
  refactor: {
    matched_queries: 1,
    baseline_total: 1100,
    active_total: 250,
    saved_total: 850,
    saved_pct: 77.27,
  },
};

function baseInput(): BuildAuditInput {
  return {
    counter_version: "0.1.1",
    mode: "strict",
    binary_sha256: "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    inputs: {
      baseline_file: "baseline.jsonl",
      baseline_sha256:
        "sha256:aaaa567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      active_file: "active.jsonl",
      active_sha256:
        "sha256:bbbb567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      bom_stripped: false,
    },
    counts: FIXED_COUNTS,
    tokens: FIXED_TOKENS,
    cost_usd: null,
    per_workload: FIXED_PER_WORKLOAD,
    fingerprint: FIXED_FINGERPRINT,
    thresholds: FIXED_THRESHOLDS,
    warnings: [],
  };
}

const FIXED_COST: CostAggregates = {
  model: "claude-sonnet-4-6",
  pricing_version: "anthropic-2026-05",
  baseline_cost_usd: 0.0045,
  active_cost_usd: 0.0011,
  saved_cost_usd: 0.0034,
  saved_pct: 75.56,
  cache_read_total: 5000,
  cache_creation_total: 1200,
};

// ─── Tests ──────────────────────────────────────────────────────────

describe("v0.2 cost block — hash differentiation", () => {
  it("v0.1.x input (no cost) and v0.2 input (with cost) produce DIFFERENT hashes", () => {
    const v1Input = baseInput(); // no .cost field
    const v2Input: BuildAuditInput = { ...baseInput(), cost: FIXED_COST };

    const v1Hash = computeAuditTrailHash(buildAuditBlock(v1Input));
    const v2Hash = computeAuditTrailHash(buildAuditBlock(v2Input));

    assert.notEqual(v1Hash, v2Hash, "cost block must affect the hash");
  });

  it("two v0.2 inputs with the SAME cost block produce the SAME hash", () => {
    const a: BuildAuditInput = { ...baseInput(), cost: FIXED_COST };
    const b: BuildAuditInput = { ...baseInput(), cost: { ...FIXED_COST } };

    const aHash = computeAuditTrailHash(buildAuditBlock(a));
    const bHash = computeAuditTrailHash(buildAuditBlock(b));

    assert.equal(aHash, bHash, "identical inputs must produce identical hashes");
  });

  it("two v0.2 inputs with DIFFERENT cost values produce DIFFERENT hashes", () => {
    const a: BuildAuditInput = { ...baseInput(), cost: FIXED_COST };
    const b: BuildAuditInput = {
      ...baseInput(),
      cost: { ...FIXED_COST, saved_cost_usd: 0.0035 }, // 1 cent different
    };

    const aHash = computeAuditTrailHash(buildAuditBlock(a));
    const bHash = computeAuditTrailHash(buildAuditBlock(b));

    assert.notEqual(aHash, bHash, "cost field changes must propagate to hash");
  });
});

describe("v0.2 cost block — AuditBlock shape", () => {
  it("cost field appears in the AuditBlock when input.cost is set", () => {
    const input: BuildAuditInput = { ...baseInput(), cost: FIXED_COST };
    const block = buildAuditBlock(input);

    assert.deepEqual(block.cost, FIXED_COST);
  });

  it("cost field is ABSENT (not present, not undefined) when input.cost omitted", () => {
    const block = buildAuditBlock(baseInput());

    // Per JCS canonicalization rules, absent keys MUST NOT appear in the
    // serialized form. `"cost" in block` confirms the key is not present —
    // both for hash correctness AND for envelope cleanliness.
    assert.equal("cost" in block, false, "cost key must not appear when omitted");
  });

  it("v0.1.x cost_usd field is preserved alongside new cost block", () => {
    // Both fields can coexist. cost_usd was the v0.1.x naive cost; cost is
    // the v0.2 structured cost. The v0.2 binary can populate both for
    // dual-readability (or just `cost` going forward).
    const input: BuildAuditInput = {
      ...baseInput(),
      cost_usd: 0.0034,
      cost: FIXED_COST,
    };
    const block = buildAuditBlock(input);

    assert.equal(block.cost_usd, 0.0034);
    assert.deepEqual(block.cost, FIXED_COST);
  });
});

describe("v0.2 cost block — reproducibility", () => {
  it("buildAuditOutput is deterministic with override computed_at", () => {
    const input: BuildAuditInput = { ...baseInput(), cost: FIXED_COST };
    const opts = { computed_at: "2026-05-29T22:00:00.000Z", reproducible_mode: true };

    const out1 = buildAuditOutput(input, opts);
    const out2 = buildAuditOutput(input, opts);

    // Bit-identical serialization — the strongest reproducibility property.
    assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  });

  it("hash is stable across re-runs (no float drift in cost fields)", () => {
    // Provoke any float-arithmetic instability by using values that don't
    // round trivially.
    const driftyInputCost: CostAggregates = {
      model: "claude-sonnet-4-6",
      pricing_version: "anthropic-2026-05",
      baseline_cost_usd: 0.0123,
      active_cost_usd: 0.0099,
      saved_cost_usd: 0.0024,
      saved_pct: 19.51,
      cache_read_total: 7777,
      cache_creation_total: 3333,
    };
    const input: BuildAuditInput = { ...baseInput(), cost: driftyInputCost };

    const hashes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      hashes.add(computeAuditTrailHash(buildAuditBlock(input)));
    }

    assert.equal(hashes.size, 1, "all 20 hash computations must produce the same value");
  });
});

describe("v0.2 cost block — GOLDEN HASH (reproducibility lock)", () => {
  it("locks the v0.2 cost-bearing audit_trail_hash (regression guard, mirrors v0.1 goldens)", () => {
    // A fully-pinned cost-bearing audit → exact hash. If the cost-block shape,
    // JCS canonicalization, or rounding ever changes, this fails loudly. This is
    // the v0.2 analog of the v0.1 golden hashes in integration.test.ts.
    const input: BuildAuditInput = {
      counter_version: "0.2.0",
      mode: "dev",
      inputs: {
        baseline_file: "b.jsonl",
        baseline_sha256: "sha256:" + "a".repeat(64),
        active_file: "a.jsonl",
        active_sha256: "sha256:" + "b".repeat(64),
        bom_stripped: false,
      },
      counts: { baseline_entries: 1, active_entries: 1, matched_queries: 1, baseline_only_queries: 0, active_only_queries: 0 },
      tokens: {
        baseline_sent_total: 1000, active_sent_total: 200, saved_sent: 800,
        baseline_received_total: 100, active_received_total: 50, saved_received: 50,
        baseline_total: 1100, active_total: 250, saved_total: 850, saved_pct: 77.27,
      },
      cost_usd: null,
      cost: {
        model: "claude-sonnet-4-6", pricing_version: "anthropic-2026-05",
        baseline_cost_usd: 0.0045, active_cost_usd: 0.0011, saved_cost_usd: 0.0034,
        saved_pct: 75.56, cache_read_total: 5000, cache_creation_total: 1200,
      },
      per_workload: { refactor: { matched_queries: 1, baseline_total: 1100, active_total: 250, saved_total: 850, saved_pct: 77.27 } },
      fingerprint: { baseline_set: ["refactor"], active_set: ["refactor"], fingerprint_match: true, baseline_counts: { refactor: 1 }, active_counts: { refactor: 1 } },
      thresholds: { workload_absent_fail_closed: 0.01, mismatch_warn: 0.1, mismatch_high: 0.5, count_skew_warn: 0.5 },
      warnings: [],
    };
    const out = buildAuditOutput(input, { computed_at: "2026-05-31T00:00:00.000Z", audit_id: "v0.2-golden", reproducible_mode: true });
    assert.equal(
      out.audit_trail_hash,
      "sha256:2b84cef558c3eacb706b90bc3233a9efee99ab32c9609f3ad6edb455e96d7705",
    );
  });
});
