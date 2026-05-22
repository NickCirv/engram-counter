#!/usr/bin/env node
/**
 * Deterministic fixture generator for engram-counter benchmarks.
 *
 * Produces tests/fixtures/baseline-100q.jsonl + active-100q.jsonl
 * via a seeded LCG (no Math.random; deterministic across Node versions).
 *
 * REPRODUCIBILITY CLAIM: running this script twice produces byte-identical
 * fixtures. Auditors can regenerate to verify the committed fixtures.
 *
 * The fixtures are SYNTHETIC — not real workload capture. The saved_pct
 * target (~89%) mirrors engramx v4.0's measured 89.1% but is NOT itself
 * a measurement of engram; it exercises engram-counter's pipeline at
 * procurement-relevant scale.
 *
 * Usage:
 *   node scripts/generate-fixture.js
 *
 * Then verify:
 *   node bin/engram-counter.js \
 *     --baseline tests/fixtures/baseline-100q.jsonl \
 *     --active tests/fixtures/active-100q.jsonl \
 *     --audit-id audit-100q-bench \
 *     --no-binary-hash
 */

"use strict";

const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

// ════════════════════════════════════════════════════════════════════
// Deterministic LCG (Linear Congruential Generator)
// Parameters from Numerical Recipes — well-tested, period 2^32.
// ════════════════════════════════════════════════════════════════════

const SEED = 1729; // Hardy-Ramanujan number; documented + memorable

function makeLcg(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000; // [0, 1)
  };
}

const rng = makeLcg(SEED);

function randInt(min, max) {
  // Inclusive of both bounds
  return min + Math.floor(rng() * (max - min + 1));
}

function randRange(min, max) {
  return min + rng() * (max - min);
}

// ════════════════════════════════════════════════════════════════════
// Workload distribution (mirrors realistic full-stack engineer day)
// Sums to 100 queries.
// ════════════════════════════════════════════════════════════════════

const WORKLOADS = [
  {
    name: "refactor",
    count: 28,
    baselineSentRange: [15000, 50000],
    reductionPctRange: [88, 92], // engram excels at structure-aware compression
  },
  {
    name: "feature_add",
    count: 24,
    baselineSentRange: [20000, 55000],
    reductionPctRange: [85, 89], // high context variance
  },
  {
    name: "debug",
    count: 22,
    baselineSentRange: [8000, 25000],
    reductionPctRange: [90, 94], // very effective dedup on debug traces
  },
  {
    name: "doc_lookup",
    count: 14,
    baselineSentRange: [5000, 15000],
    reductionPctRange: [75, 82], // already small; harder to compress
  },
  {
    name: "test_writing",
    count: 12,
    baselineSentRange: [10000, 30000],
    reductionPctRange: [87, 91],
  },
];

// ════════════════════════════════════════════════════════════════════
// Generate paired queries
// ════════════════════════════════════════════════════════════════════

const baselineEntries = [];
const activeEntries = [];

let queryIndex = 0;
const startTimestamp = Date.UTC(2026, 4, 21, 10, 0, 0); // 2026-05-21 10:00:00 UTC

for (const wl of WORKLOADS) {
  for (let i = 0; i < wl.count; i++) {
    queryIndex++;
    const queryId = `q_${String(queryIndex).padStart(3, "0")}`;

    // Baseline tokens_sent ∈ wl.baselineSentRange
    const baselineSent = randInt(wl.baselineSentRange[0], wl.baselineSentRange[1]);
    // Realistic tokens_received ≈ 3.5-4.5% of tokens_sent (LLM output is short)
    const baselineReceived = Math.max(
      1,
      Math.floor(baselineSent * (0.035 + rng() * 0.01)),
    );

    // Reduction percentage ∈ wl.reductionPctRange
    const reductionPct = randRange(wl.reductionPctRange[0], wl.reductionPctRange[1]);

    const activeSent = Math.max(1, Math.floor(baselineSent * (1 - reductionPct / 100)));
    // Active output is slightly less (compressed responses)
    const activeReceived = Math.max(
      1,
      Math.floor(baselineReceived * (0.92 + rng() * 0.05)),
    );

    // Spread timestamps across an 8-hour workday
    const tsOffsetSeconds = Math.floor(
      ((queryIndex - 1) / 100) * 8 * 3600 + randInt(0, 30),
    );
    const ts = new Date(startTimestamp + tsOffsetSeconds * 1000).toISOString();

    baselineEntries.push({
      query_id: queryId,
      timestamp: ts,
      tokens_sent: baselineSent,
      tokens_received: baselineReceived,
      workload: wl.name,
    });
    activeEntries.push({
      query_id: queryId,
      timestamp: ts,
      tokens_sent: activeSent,
      tokens_received: activeReceived,
      workload: wl.name,
    });
  }
}

// ════════════════════════════════════════════════════════════════════
// Write JSONL files
// ════════════════════════════════════════════════════════════════════

const FIXTURES_DIR = join(__dirname, "..", "tests", "fixtures");

function toJsonl(entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

const baselinePath = join(FIXTURES_DIR, "baseline-100q.jsonl");
const activePath = join(FIXTURES_DIR, "active-100q.jsonl");

writeFileSync(baselinePath, toJsonl(baselineEntries), "utf8");
writeFileSync(activePath, toJsonl(activeEntries), "utf8");

// ════════════════════════════════════════════════════════════════════
// Summary stats (printed to stderr — stdout reserved for machine pipes)
// ════════════════════════════════════════════════════════════════════

const baselineSentTotal = baselineEntries.reduce((s, e) => s + e.tokens_sent, 0);
const activeSentTotal = activeEntries.reduce((s, e) => s + e.tokens_sent, 0);
const baselineReceivedTotal = baselineEntries.reduce(
  (s, e) => s + e.tokens_received,
  0,
);
const activeReceivedTotal = activeEntries.reduce(
  (s, e) => s + e.tokens_received,
  0,
);
const baselineTotal = baselineSentTotal + baselineReceivedTotal;
const activeTotal = activeSentTotal + activeReceivedTotal;
const savedTotal = baselineTotal - activeTotal;
const savedPct = (savedTotal / baselineTotal) * 100;

process.stderr.write(`engram-counter fixture generator — SEED=${SEED}\n`);
process.stderr.write(`  baseline-100q.jsonl: ${baselineEntries.length} entries\n`);
process.stderr.write(`  active-100q.jsonl:   ${activeEntries.length} entries\n`);
process.stderr.write(`  baseline_total:      ${baselineTotal.toLocaleString()} tokens\n`);
process.stderr.write(`  active_total:        ${activeTotal.toLocaleString()} tokens\n`);
process.stderr.write(`  saved_total:         ${savedTotal.toLocaleString()} tokens\n`);
process.stderr.write(`  saved_pct (preview): ${savedPct.toFixed(4)}%\n`);
process.stderr.write(`  Files written:\n`);
process.stderr.write(`    ${baselinePath}\n`);
process.stderr.write(`    ${activePath}\n`);
