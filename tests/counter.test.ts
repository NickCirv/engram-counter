/**
 * counter.ts unit tests — TDD red→green→refactor cycle.
 * Per SPEC v0.1.3 §Test coverage requirements + F8 + F9.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  savedPctBasisPoints,
  basisPointsToPct,
  diffQueries,
  aggregateTokens,
  aggregateByWorkload,
  mismatchSeverity,
} from "../src/counter.js";
import type { MatchedQuery } from "../src/types.js";

// ────────────────────────────────────────────────────────────────────
// Test helpers — build MatchedQuery objects from concise inputs
// ────────────────────────────────────────────────────────────────────

function makeMatch(
  query_id: string,
  workload: string | undefined,
  baselineTokens: { sent: number; received: number },
  activeTokens: { sent: number; received: number },
): MatchedQuery {
  return {
    query_id,
    workload,
    baseline: {
      query_id,
      timestamp: "2026-05-21T10:00:00Z",
      tokens_sent: baselineTokens.sent,
      tokens_received: baselineTokens.received,
      workload,
    },
    active: {
      query_id,
      timestamp: "2026-05-21T11:00:00Z",
      tokens_sent: activeTokens.sent,
      tokens_received: activeTokens.received,
      workload,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// The 10-query golden fixture — hand-computed for exact 90.00% savings
// ────────────────────────────────────────────────────────────────────

const GOLDEN_10Q_BASELINE = [
  { sent: 50000, received: 2000, workload: "refactor" },
  { sent: 48000, received: 1800, workload: "refactor" },
  { sent: 52000, received: 2200, workload: "refactor" },
  { sent: 30000, received: 1500, workload: "debug" },
  { sent: 32000, received: 1600, workload: "debug" },
  { sent: 28000, received: 1400, workload: "debug" },
  { sent: 70000, received: 3000, workload: "feature_add" },
  { sent: 72000, received: 3100, workload: "feature_add" },
  { sent: 68000, received: 2900, workload: "feature_add" },
  { sent: 71000, received: 3050, workload: "feature_add" },
];

const GOLDEN_10Q_ACTIVE = [
  { sent: 5000, received: 200 },
  { sent: 4800, received: 180 },
  { sent: 5200, received: 220 },
  { sent: 3000, received: 150 },
  { sent: 3200, received: 160 },
  { sent: 2800, received: 140 },
  { sent: 7000, received: 300 },
  { sent: 7200, received: 310 },
  { sent: 6800, received: 290 },
  { sent: 7100, received: 305 },
];

function buildGolden10Q(): MatchedQuery[] {
  return GOLDEN_10Q_BASELINE.map((b, i) => {
    const a = GOLDEN_10Q_ACTIVE[i];
    if (!a) throw new Error(`fixture index ${i} missing`);
    return makeMatch(
      `q_${String(i + 1).padStart(3, "0")}`,
      b.workload,
      { sent: b.sent, received: b.received },
      a,
    );
  });
}

// ────────────────────────────────────────────────────────────────────
// savedPctBasisPoints — SPEC F5 + F9 (BigInt math, no IEEE drift)
// ────────────────────────────────────────────────────────────────────

describe("savedPctBasisPoints (v0.1.3 F9 BigInt math)", () => {
  it("returns 9000 (90.00%) for the 10-query golden fixture totals", () => {
    // saved_total = 489195, baseline_total = 543550 → exactly 9000 basis points
    assert.equal(savedPctBasisPoints(489195, 543550), 9000);
  });

  it("returns 0 (0.00%) when no savings", () => {
    assert.equal(savedPctBasisPoints(0, 100), 0);
  });

  it("returns 10000 (100.00%) for total elimination", () => {
    assert.equal(savedPctBasisPoints(100, 100), 10000);
  });

  it("throws when baseline_total is zero (SPEC error handling)", () => {
    assert.throws(
      () => savedPctBasisPoints(100, 0),
      /baseline_total.*zero/i,
    );
  });

  it("handles negative saved_total (engram regression — saved_pct may be negative)", () => {
    // baseline 100, active 150 → saved -50 → -50.00%
    assert.equal(savedPctBasisPoints(-50, 100), -5000);
  });

  it("Fortune-100 scale (1.095e12 tokens): no Number.MAX_SAFE_INTEGER overflow per F9", () => {
    // 2000 devs × 1.5M tokens/dev/day × 365 days = 1.095e12 baseline tokens
    const baseline = 1_095_000_000_000;
    // Math.round(0.89 * baseline) = exact 974550000000
    const saved = 974_550_000_000;
    // With Number math: (974550000000 * 10000) = 9.7455e15 — UNDER 2^53 (9.007e15)? NO — over.
    // BigInt math handles correctly: returns 8900 (89.00%)
    const basis_points = savedPctBasisPoints(saved, baseline);
    assert.equal(basis_points, 8900);
  });

  it("Mega-scale (10x Fortune-100): BigInt still safe", () => {
    // 1.095e13 baseline × 10000 = 1.095e17 — far above 2^53. Must use BigInt.
    const baseline = 10_950_000_000_000;
    const saved = 9_745_500_000_000;
    const basis_points = savedPctBasisPoints(saved, baseline);
    assert.equal(basis_points, 8900);
  });
});

// ────────────────────────────────────────────────────────────────────
// basisPointsToPct — simple conversion
// ────────────────────────────────────────────────────────────────────

describe("basisPointsToPct", () => {
  it("converts 9000 basis points to 90.00%", () => {
    assert.equal(basisPointsToPct(9000), 90);
  });

  it("converts 8762 basis points to 87.62%", () => {
    assert.equal(basisPointsToPct(8762), 87.62);
  });

  it("converts 0 basis points to 0%", () => {
    assert.equal(basisPointsToPct(0), 0);
  });

  it("converts -5000 basis points to -50.00% (engram regression)", () => {
    assert.equal(basisPointsToPct(-5000), -50);
  });
});

// ────────────────────────────────────────────────────────────────────
// diffQueries — per-query diff math
// ────────────────────────────────────────────────────────────────────

describe("diffQueries", () => {
  it("computes correct diff for single matched query", () => {
    const matched: MatchedQuery[] = [
      makeMatch(
        "q_001",
        "refactor",
        { sent: 50000, received: 2000 },
        { sent: 5000, received: 200 },
      ),
    ];
    const diffs = diffQueries(matched);
    assert.equal(diffs.length, 1);
    const d = diffs[0]!;
    assert.equal(d.query_id, "q_001");
    assert.equal(d.workload, "refactor");
    assert.equal(d.baseline_total, 52000); // 50000 + 2000
    assert.equal(d.active_total, 5200); // 5000 + 200
    assert.equal(d.saved_total, 46800);
    assert.equal(d.saved_pct, 90);
  });

  it("handles negative saved_total (engram regression)", () => {
    const matched = [
      makeMatch(
        "q_x",
        "debug",
        { sent: 100, received: 0 },
        { sent: 150, received: 0 },
      ),
    ];
    const diffs = diffQueries(matched);
    const d = diffs[0]!;
    assert.equal(d.saved_total, -50);
    assert.equal(d.saved_pct, -50);
  });

  it("returns 0 saved_pct (not throw) when baseline is zero per spec for per-query", () => {
    const matched = [
      makeMatch(
        "q_zero",
        "debug",
        { sent: 0, received: 0 },
        { sent: 0, received: 0 },
      ),
    ];
    const diffs = diffQueries(matched);
    assert.equal(diffs[0]!.saved_pct, 0);
  });

  it("preserves all 10 queries from golden fixture", () => {
    const diffs = diffQueries(buildGolden10Q());
    assert.equal(diffs.length, 10);
    // All should hit exactly 90%
    for (const d of diffs) {
      assert.equal(d.saved_pct, 90);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// aggregateTokens — sum across matched queries
// ────────────────────────────────────────────────────────────────────

describe("aggregateTokens", () => {
  it("aggregates the 10-query golden fixture to exact 90.00% saved", () => {
    const agg = aggregateTokens(buildGolden10Q());
    assert.equal(agg.baseline_sent_total, 521000);
    assert.equal(agg.active_sent_total, 52100);
    assert.equal(agg.saved_sent, 468900);
    assert.equal(agg.baseline_received_total, 22550);
    assert.equal(agg.active_received_total, 2255);
    assert.equal(agg.saved_received, 20295);
    assert.equal(agg.baseline_total, 543550);
    assert.equal(agg.active_total, 54355);
    assert.equal(agg.saved_total, 489195);
    assert.equal(agg.saved_pct, 90);
  });

  it("handles empty input deterministically (zero across all fields)", () => {
    const agg = aggregateTokens([]);
    assert.equal(agg.baseline_total, 0);
    assert.equal(agg.active_total, 0);
    assert.equal(agg.saved_total, 0);
    assert.equal(agg.saved_pct, 0);
  });

  it("preserves negative saved_total across aggregation (regression scenario)", () => {
    const matched = [
      makeMatch(
        "r1",
        "x",
        { sent: 100, received: 0 },
        { sent: 200, received: 0 },
      ),
      makeMatch(
        "r2",
        "x",
        { sent: 100, received: 0 },
        { sent: 150, received: 0 },
      ),
    ];
    const agg = aggregateTokens(matched);
    assert.equal(agg.baseline_total, 200);
    assert.equal(agg.active_total, 350);
    assert.equal(agg.saved_total, -150);
    assert.equal(agg.saved_pct, -75);
  });
});

// ────────────────────────────────────────────────────────────────────
// aggregateByWorkload — per-workload grouping (sorted alphabetically)
// ────────────────────────────────────────────────────────────────────

describe("aggregateByWorkload", () => {
  it("groups 10-query fixture into 3 workloads with correct per-workload totals", () => {
    const groups = aggregateByWorkload(buildGolden10Q());

    // Sorted alphabetically: debug, feature_add, refactor (deterministic key ordering)
    assert.deepEqual(Object.keys(groups), [
      "debug",
      "feature_add",
      "refactor",
    ]);

    const r = groups["refactor"]!;
    assert.equal(r.matched_queries, 3);
    assert.equal(r.baseline_total, 156000);
    assert.equal(r.active_total, 15600);
    assert.equal(r.saved_total, 140400);
    assert.equal(r.saved_pct, 90);

    const d = groups["debug"]!;
    assert.equal(d.matched_queries, 3);
    assert.equal(d.baseline_total, 94500);
    assert.equal(d.active_total, 9450);
    assert.equal(d.saved_pct, 90);

    const f = groups["feature_add"]!;
    assert.equal(f.matched_queries, 4);
    assert.equal(f.baseline_total, 293050);
    assert.equal(f.active_total, 29305);
    assert.equal(f.saved_pct, 90);
  });

  it("places queries without workload field into __unspecified__ bucket", () => {
    const matched = [
      makeMatch(
        "q_1",
        undefined,
        { sent: 100, received: 10 },
        { sent: 10, received: 1 },
      ),
      makeMatch(
        "q_2",
        undefined,
        { sent: 100, received: 10 },
        { sent: 10, received: 1 },
      ),
    ];
    const groups = aggregateByWorkload(matched);
    assert.ok("__unspecified__" in groups);
    const u = groups["__unspecified__"]!;
    assert.equal(u.matched_queries, 2);
  });

  it("returns empty object for empty input", () => {
    const groups = aggregateByWorkload([]);
    assert.deepEqual(groups, {});
  });

  it("sorts workload keys alphabetically (determinism guarantee)", () => {
    // Insert in non-alphabetical order; output keys must be alphabetical
    const matched = [
      makeMatch(
        "q_z",
        "zeta",
        { sent: 100, received: 0 },
        { sent: 10, received: 0 },
      ),
      makeMatch(
        "q_a",
        "alpha",
        { sent: 100, received: 0 },
        { sent: 10, received: 0 },
      ),
      makeMatch(
        "q_m",
        "mu",
        { sent: 100, received: 0 },
        { sent: 10, received: 0 },
      ),
    ];
    const groups = aggregateByWorkload(matched);
    assert.deepEqual(Object.keys(groups), ["alpha", "mu", "zeta"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// mismatchSeverity — SPEC v0.1.3 F8 three-tier classification
// ────────────────────────────────────────────────────────────────────

describe("mismatchSeverity (v0.1.3 F8 three-tier)", () => {
  const thresholds = { warn: 0.1, high: 0.5 };

  it("returns 'ok' for 0% mismatch (perfect overlap)", () => {
    assert.equal(mismatchSeverity(100, 0, 0, thresholds), "ok");
  });

  it("returns 'ok' for exactly 10% mismatch (boundary, inclusive of warn threshold)", () => {
    // 90 matched, 10 baseline-only → 10/100 = 10% — boundary case
    // mismatch > warn → false at exactly 10%; treated as 'ok'
    assert.equal(mismatchSeverity(90, 10, 0, thresholds), "ok");
  });

  it("returns 'warn' for 11% mismatch (just over warn threshold)", () => {
    // 89 matched, 11 baseline-only → 11/100 = 11%
    assert.equal(mismatchSeverity(89, 11, 0, thresholds), "warn");
  });

  it("returns 'warn' for 49% mismatch (under high)", () => {
    assert.equal(mismatchSeverity(51, 49, 0, thresholds), "warn");
  });

  it("returns 'warn' for exactly 50% mismatch (boundary, inclusive)", () => {
    // 50 matched, 50 baseline-only → 50/100 = 50% — boundary case for high
    // mismatch > high → false at exactly 50%; treated as 'warn'
    assert.equal(mismatchSeverity(50, 50, 0, thresholds), "warn");
  });

  it("returns 'high' for 51% mismatch (just over high)", () => {
    assert.equal(mismatchSeverity(49, 51, 0, thresholds), "high");
  });

  it("returns 'high' for 80% mismatch (severe)", () => {
    assert.equal(mismatchSeverity(20, 80, 0, thresholds), "high");
  });

  it("returns 'ok' when no queries (degenerate case — no data, no mismatch)", () => {
    assert.equal(mismatchSeverity(0, 0, 0, thresholds), "ok");
  });

  it("splits mismatch between baseline_only and active_only correctly", () => {
    // 80 matched, 10 baseline-only, 10 active-only → 20/100 = 20% mismatch → warn
    assert.equal(mismatchSeverity(80, 10, 10, thresholds), "warn");
  });
});

// ────────────────────────────────────────────────────────────────────
// Input validation (v0.1.4 — from adversarial review findings A2-A5)
// ────────────────────────────────────────────────────────────────────

describe("savedPctBasisPoints input validation (v0.1.4 adversarial-review patches)", () => {
  it("throws TypeError on non-integer saved_total (fractional)", () => {
    assert.throws(() => savedPctBasisPoints(1.5, 100), TypeError);
  });

  it("throws TypeError on non-integer baseline_total (fractional)", () => {
    assert.throws(() => savedPctBasisPoints(100, 100.5), TypeError);
  });

  it("throws TypeError on NaN saved_total", () => {
    assert.throws(() => savedPctBasisPoints(NaN, 100), TypeError);
  });

  it("throws TypeError on Infinity baseline_total", () => {
    assert.throws(() => savedPctBasisPoints(50, Infinity), TypeError);
  });

  it("throws RangeError on negative baseline_total (silent sign-flip prevention)", () => {
    // Pre-patch: savedPctBasisPoints(-50, -100) silently returned +5000 — wrong
    assert.throws(() => savedPctBasisPoints(50, -100), RangeError);
  });
});

describe("mismatchSeverity input validation (v0.1.4 adversarial-review patches)", () => {
  it("throws TypeError on NaN thresholds (silent OK downgrade prevention)", () => {
    assert.throws(
      () => mismatchSeverity(50, 50, 0, { warn: NaN, high: NaN }),
      TypeError,
    );
  });

  it("throws TypeError on Infinity threshold", () => {
    assert.throws(
      () => mismatchSeverity(50, 50, 0, { warn: 0.1, high: Infinity }),
      TypeError,
    );
  });

  it("throws RangeError when warn > high (inverted thresholds — silent wrong tier prevention)", () => {
    // Pre-patch: mismatchSeverity(50, 50, 0, {warn:0.8, high:0.3}) returned "high" — wrong
    assert.throws(
      () => mismatchSeverity(50, 50, 0, { warn: 0.8, high: 0.3 }),
      RangeError,
    );
  });

  it("accepts equal warn and high (boundary case — effectively two-tier ok/high)", () => {
    // warn = high is valid (no throw). Effectively 2 tiers: ok / high; no warn returned.
    assert.doesNotThrow(() =>
      mismatchSeverity(50, 50, 0, { warn: 0.5, high: 0.5 }),
    );
    // At equal-threshold boundary: 'ok' (strict > semantics — neither > warn nor > high)
    assert.equal(
      mismatchSeverity(50, 50, 0, { warn: 0.5, high: 0.5 }),
      "ok",
    );
    // Above equal-threshold: 'high' (warn tier skipped when warn == high)
    assert.equal(
      mismatchSeverity(40, 60, 0, { warn: 0.5, high: 0.5 }),
      "high",
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Property-based invariants (v0.1.4 — SPEC §Test coverage requires fuzz)
// Hand-rolled seeded RNG for determinism; no new deps.
// ────────────────────────────────────────────────────────────────────

describe("counter.ts property-based invariants (hand-rolled seeded fuzz)", () => {
  /** Linear congruential generator for deterministic test fixtures. */
  function makeRng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }

  function generateMatched(seed: number, n: number): MatchedQuery[] {
    const rng = makeRng(seed);
    const result: MatchedQuery[] = [];
    const workloads = ["alpha", "beta", "gamma"];
    for (let i = 0; i < n; i++) {
      const bs = Math.floor(rng() * 100000) + 1; // never zero
      const br = Math.floor(rng() * 10000);
      // active is 5-25% of baseline (representative of engram savings)
      const reductionFactor = 0.05 + rng() * 0.2;
      const as_ = Math.floor(bs * reductionFactor);
      const ar = Math.floor(br * reductionFactor);
      const wl = workloads[Math.floor(rng() * workloads.length)]!;
      result.push(
        makeMatch(
          `q_${i.toString().padStart(4, "0")}`,
          wl,
          { sent: bs, received: br },
          { sent: as_, received: ar },
        ),
      );
    }
    return result;
  }

  it("INVARIANT: aggregateTokens.saved_total === sum(diffQueries.saved_total)", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const matched = generateMatched(seed, 50);
      const agg = aggregateTokens(matched);
      const diffs = diffQueries(matched);
      const sumDiffs = diffs.reduce((s, d) => s + d.saved_total, 0);
      assert.equal(
        agg.saved_total,
        sumDiffs,
        `seed ${seed}: aggregate saved_total (${agg.saved_total}) !== sum of per-query (${sumDiffs})`,
      );
    }
  });

  it("INVARIANT: per-workload sums equal aggregate totals", () => {
    for (let seed = 100; seed <= 110; seed++) {
      const matched = generateMatched(seed, 100);
      const agg = aggregateTokens(matched);
      const groups = aggregateByWorkload(matched);
      const sumWorkloads = Object.values(groups).reduce(
        (s, g) => s + g.saved_total,
        0,
      );
      assert.equal(
        agg.saved_total,
        sumWorkloads,
        `seed ${seed}: aggregate (${agg.saved_total}) !== sum-of-workloads (${sumWorkloads})`,
      );
    }
  });

  it("INVARIANT: aggregateTokens.baseline_total === sum(per-workload baseline_total)", () => {
    for (let seed = 200; seed <= 205; seed++) {
      const matched = generateMatched(seed, 75);
      const agg = aggregateTokens(matched);
      const groups = aggregateByWorkload(matched);
      const sumWorkloadBaseline = Object.values(groups).reduce(
        (s, g) => s + g.baseline_total,
        0,
      );
      assert.equal(agg.baseline_total, sumWorkloadBaseline);
    }
  });

  it("INVARIANT: counts in aggregateByWorkload sum to matched count", () => {
    for (let seed = 300; seed <= 305; seed++) {
      const matched = generateMatched(seed, 50);
      const groups = aggregateByWorkload(matched);
      const sumCounts = Object.values(groups).reduce(
        (s, g) => s + g.matched_queries,
        0,
      );
      assert.equal(sumCounts, matched.length);
    }
  });
});
