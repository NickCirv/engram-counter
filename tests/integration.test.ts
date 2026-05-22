/**
 * INTEGRATION test — parser → counter → hash end-to-end.
 *
 * This is the test the testing-reviewer flagged as a P0 ship-blocker. Without
 * it, individual modules can be correct but compose wrong — and procurement
 * auditors testing the FULL pipeline (JSONL → AuditOutput) would expose the
 * seam. With it, the reproducibility imperative is proven end-to-end against
 * real fixtures.
 *
 * Asserts:
 *   1. saved_pct === 90.00 exactly from the 10q JSONL fixture
 *   2. counts.matched_queries === 10 (all entries align)
 *   3. fingerprint.fingerprint_match === true
 *   4. Two runs produce JSON.stringify-equal AuditOutput bytes (reproducibility)
 *   5. verifyAuditTrailHash returns Ok on the integration audit
 *   6. GOLDEN HASH locked — future hash drift = regression
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseJsonlFile,
  computeWorkloadFingerprint,
} from "../src/parser.js";
import {
  joinByQueryId,
  aggregateTokens,
  aggregateByWorkload,
} from "../src/counter.js";
import { buildAuditOutput, verifyAuditTrailHash } from "../src/hash.js";
import { DEFAULT_THRESHOLDS } from "../src/types.js";
import type { BuildAuditInput } from "../src/hash.js";
import type { AuditOutput, WorkloadFingerprint } from "../src/types.js";
import type { FingerprintOutput } from "../src/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");

const FIXED_TIME = "2026-05-21T12:00:00.000Z";
const FIXED_AUDIT_ID = "integration-test-10q";

/**
 * Map parser.FingerprintOutput (which has skewed_workloads + empty_input enum)
 * to types.WorkloadFingerprint (the shape AuditBlock expects).
 *
 * v0.2 will extend WorkloadFingerprint to match parser.FingerprintOutput directly;
 * for v0.1.0 we narrow here at the seam.
 */
function fingerprintForAudit(fp: FingerprintOutput): WorkloadFingerprint {
  // Map empty_input → workload_field_absent for the audit (v0.1.0 enum compat).
  const reason =
    fp.fingerprint_reason === "empty_input"
      ? "workload_field_absent"
      : fp.fingerprint_reason;
  return {
    baseline_workloads: fp.baseline_workloads,
    active_workloads: fp.active_workloads,
    fingerprint_match: fp.fingerprint_match,
    fingerprint_reason: reason,
    count_per_workload: fp.count_per_workload,
  };
}

function runFixturePipeline(): AuditOutput {
  const b = parseJsonlFile(join(FIX, "baseline-10q.jsonl"));
  const a = parseJsonlFile(join(FIX, "active-10q.jsonl"));
  if (!b.ok) throw new Error(`baseline parse failed: ${b.error.message}`);
  if (!a.ok) throw new Error(`active parse failed: ${a.error.message}`);

  const { matched, baseline_only, active_only } = joinByQueryId(
    b.value.entries,
    a.value.entries,
  );

  const fp = computeWorkloadFingerprint({
    baseline: b.value.entries,
    active: a.value.entries,
    workloadAbsentFailClosed: 0.01,
    countSkewWarn: 0.5,
  });

  const input: BuildAuditInput = {
    counter_version: "0.0.1",
    mode: "dev",
    inputs: {
      baseline_file: "baseline-10q.jsonl",
      baseline_sha256: b.value.file_sha256,
      active_file: "active-10q.jsonl",
      active_sha256: a.value.file_sha256,
      bom_stripped: b.value.bom_stripped || a.value.bom_stripped,
    },
    counts: {
      baseline_entries: b.value.entries.length,
      active_entries: a.value.entries.length,
      matched_queries: matched.length,
      baseline_only_queries: baseline_only.length,
      active_only_queries: active_only.length,
    },
    tokens: aggregateTokens(matched),
    cost_usd: null,
    per_workload: aggregateByWorkload(matched),
    fingerprint: fingerprintForAudit(fp),
    thresholds: DEFAULT_THRESHOLDS,
    warnings: [...b.value.warnings, ...a.value.warnings, ...fp.warnings],
  };

  return buildAuditOutput(input, {
    computed_at: FIXED_TIME,
    audit_id: FIXED_AUDIT_ID,
    reproducible_mode: true,
  });
}

describe("INTEGRATION — parser → counter → hash end-to-end (P0)", () => {
  it("produces saved_pct === 90.00 EXACTLY from the 10q golden fixture", () => {
    const out = runFixturePipeline();
    assert.equal(out.audit.tokens.saved_pct, 90);
  });

  it("matches all 10 queries (no baseline_only / active_only)", () => {
    const out = runFixturePipeline();
    assert.equal(out.audit.counts.matched_queries, 10);
    assert.equal(out.audit.counts.baseline_only_queries, 0);
    assert.equal(out.audit.counts.active_only_queries, 0);
  });

  it("fingerprint.fingerprint_match === true on the golden fixture", () => {
    const out = runFixturePipeline();
    assert.equal(out.audit.fingerprint.fingerprint_match, true);
    assert.equal(out.audit.fingerprint.fingerprint_reason, "ok");
  });

  it("BYTE-IDENTICAL across two invocations (reproducibility imperative)", () => {
    // The procurement-killer property: same input → byte-identical output JSON.
    const out1 = runFixturePipeline();
    const out2 = runFixturePipeline();
    assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  });

  it("verifyAuditTrailHash returns Ok on the integration audit (self-verification)", () => {
    const out = runFixturePipeline();
    const r = verifyAuditTrailHash(out);
    assert.equal(r.ok, true);
  });

  it("envelope contains all in-toto Statement v1 + ingestion contract fields", () => {
    const out = runFixturePipeline();
    assert.equal(out.envelope.computed_at, FIXED_TIME);
    assert.equal(out.envelope.audit_id, FIXED_AUDIT_ID);
    assert.equal(out.envelope.reproducible_mode, true);
    assert.equal(out.envelope.ingestion_contract, "v1");
    assert.equal(out.envelope._type, "https://in-toto.io/Statement/v1");
    assert.equal(
      out.envelope.predicateType,
      "https://cirvgreen.com/engram-counter/Attestation/v1",
    );
  });

  it("audit_trail_hash is in canonical sha256:<64-hex> format", () => {
    const out = runFixturePipeline();
    assert.match(out.audit_trail_hash, /^sha256:[0-9a-f]{64}$/);
  });

  // GOLDEN HASH — locks in the reproducibility contract.
  // Any future change in JCS / counter / parser / fingerprint that drifts this
  // hash is a regression that MUST be acknowledged in the changelog.
  // Captured 2026-05-21 from first green run of the integration pipeline:
  //   - parser.ts at SHA a3d73f7 with adversarial hardening
  //   - counter.ts + joinByQueryId
  //   - hash.ts with lone-surrogate + non-plain-object hardening
  it("GOLDEN HASH locks the reproducibility contract (v0.1.0-pre1)", () => {
    const out = runFixturePipeline();
    assert.equal(
      out.audit_trail_hash,
      "sha256:f5fe2b17396a6e4ec5583162f20774188f66eca72b22d16df5f75da67052a88f",
    );
  });
});

describe("INTEGRATION — mutation guard (off-by-one detection)", () => {
  it("audit_trail_hash differs when a single token is off by 1", () => {
    // The same pipeline but inject a -1 perturbation in active.tokens_sent of q_001.
    // This guards against future refactors that silently lose precision.
    const out1 = runFixturePipeline();

    const b = parseJsonlFile(join(FIX, "baseline-10q.jsonl"));
    const a = parseJsonlFile(join(FIX, "active-10q.jsonl"));
    if (!b.ok || !a.ok) throw new Error("fixture parse failed");

    // Perturb active[0].tokens_sent by -1
    const perturbed = a.value.entries.map((e, i) =>
      i === 0 ? { ...e, tokens_sent: e.tokens_sent - 1 } : e,
    );
    const { matched, baseline_only, active_only } = joinByQueryId(
      b.value.entries,
      perturbed,
    );
    const fp = computeWorkloadFingerprint({
      baseline: b.value.entries,
      active: perturbed,
      workloadAbsentFailClosed: 0.01,
      countSkewWarn: 0.5,
    });
    const input: BuildAuditInput = {
      counter_version: "0.0.1",
      mode: "dev",
      inputs: {
        baseline_file: "baseline-10q.jsonl",
        baseline_sha256: b.value.file_sha256,
        active_file: "active-10q.jsonl",
        active_sha256: a.value.file_sha256,
        bom_stripped: false,
      },
      counts: {
        baseline_entries: b.value.entries.length,
        active_entries: perturbed.length,
        matched_queries: matched.length,
        baseline_only_queries: baseline_only.length,
        active_only_queries: active_only.length,
      },
      tokens: aggregateTokens(matched),
      cost_usd: null,
      per_workload: aggregateByWorkload(matched),
      fingerprint: fingerprintForAudit(fp),
      thresholds: DEFAULT_THRESHOLDS,
      warnings: [],
    };
    const out2 = buildAuditOutput(input, {
      computed_at: FIXED_TIME,
      audit_id: FIXED_AUDIT_ID,
      reproducible_mode: true,
    });

    // Single-byte perturbation must propagate to a different audit_trail_hash.
    assert.notEqual(out1.audit_trail_hash, out2.audit_trail_hash);
  });
});

describe("INTEGRATION — joinByQueryId edge cases", () => {
  it("handles 100% mismatch (zero overlap)", () => {
    // All baseline q_ids differ from active q_ids
    const baseline = [
      {
        query_id: "b_001",
        timestamp: "t",
        tokens_sent: 100,
        tokens_received: 10,
      },
    ];
    const active = [
      {
        query_id: "a_001",
        timestamp: "t",
        tokens_sent: 50,
        tokens_received: 5,
      },
    ];
    const { matched, baseline_only, active_only } = joinByQueryId(
      baseline,
      active,
    );
    assert.equal(matched.length, 0);
    assert.equal(baseline_only.length, 1);
    assert.equal(active_only.length, 1);
  });

  it("handles empty baseline + active", () => {
    const { matched, baseline_only, active_only } = joinByQueryId([], []);
    assert.equal(matched.length, 0);
    assert.equal(baseline_only.length, 0);
    assert.equal(active_only.length, 0);
  });

  it("baseline workload is canonical (active workload ignored for matched)", () => {
    const baseline = [
      {
        query_id: "q_001",
        timestamp: "t",
        tokens_sent: 100,
        tokens_received: 10,
        workload: "refactor",
      },
    ];
    const active = [
      {
        query_id: "q_001",
        timestamp: "t",
        tokens_sent: 50,
        tokens_received: 5,
        workload: "debug", // different from baseline
      },
    ];
    const { matched } = joinByQueryId(baseline, active);
    assert.equal(matched.length, 1);
    assert.equal(matched[0]!.workload, "refactor"); // baseline wins
  });
});

// ════════════════════════════════════════════════════════════════════
// 100q flagship benchmark fixture (procurement scale)
// ════════════════════════════════════════════════════════════════════

const FIXED_TIME_100Q = "2026-05-21T14:00:00.000Z";
const FIXED_AUDIT_ID_100Q = "integration-test-100q";

function run100qFixturePipeline(): AuditOutput {
  const b = parseJsonlFile(join(FIX, "baseline-100q.jsonl"));
  const a = parseJsonlFile(join(FIX, "active-100q.jsonl"));
  if (!b.ok) throw new Error(`100q baseline parse failed: ${b.error.message}`);
  if (!a.ok) throw new Error(`100q active parse failed: ${a.error.message}`);

  const { matched, baseline_only, active_only } = joinByQueryId(
    b.value.entries,
    a.value.entries,
  );

  const fp = computeWorkloadFingerprint({
    baseline: b.value.entries,
    active: a.value.entries,
    workloadAbsentFailClosed: 0.01,
    countSkewWarn: 0.5,
  });

  const input: BuildAuditInput = {
    counter_version: "0.0.1",
    mode: "dev",
    inputs: {
      baseline_file: "baseline-100q.jsonl",
      baseline_sha256: b.value.file_sha256,
      active_file: "active-100q.jsonl",
      active_sha256: a.value.file_sha256,
      bom_stripped: b.value.bom_stripped || a.value.bom_stripped,
    },
    counts: {
      baseline_entries: b.value.entries.length,
      active_entries: a.value.entries.length,
      matched_queries: matched.length,
      baseline_only_queries: baseline_only.length,
      active_only_queries: active_only.length,
    },
    tokens: aggregateTokens(matched),
    cost_usd: null,
    per_workload: aggregateByWorkload(matched),
    fingerprint: fingerprintForAudit(fp),
    thresholds: DEFAULT_THRESHOLDS,
    warnings: [...b.value.warnings, ...a.value.warnings, ...fp.warnings],
  };

  return buildAuditOutput(input, {
    computed_at: FIXED_TIME_100Q,
    audit_id: FIXED_AUDIT_ID_100Q,
    reproducible_mode: true,
  });
}

describe("INTEGRATION 100q — flagship procurement benchmark", () => {
  it("matches all 100 queries from baseline-100q + active-100q fixtures", () => {
    const out = run100qFixturePipeline();
    assert.equal(out.audit.counts.baseline_entries, 100);
    assert.equal(out.audit.counts.active_entries, 100);
    assert.equal(out.audit.counts.matched_queries, 100);
    assert.equal(out.audit.counts.baseline_only_queries, 0);
    assert.equal(out.audit.counts.active_only_queries, 0);
  });

  it("produces saved_pct ≈ 85.45% (synthetic-fixture honest value)", () => {
    const out = run100qFixturePipeline();
    // Honest non-round number — synthetic but realistic workload mix.
    // The 89.1% engramx v4.0 measured number is on REAL workloads.
    // The 100q fixture is for VERIFYING engram-counter, not engram itself.
    assert.equal(out.audit.tokens.saved_pct, 85.45);
  });

  it("fingerprint matches across all 5 workload categories", () => {
    const out = run100qFixturePipeline();
    assert.equal(out.audit.fingerprint.fingerprint_match, true);
    assert.equal(out.audit.fingerprint.fingerprint_reason, "ok");

    // 5 workloads expected: refactor, feature_add, debug, doc_lookup, test_writing
    const workloads = Object.keys(out.audit.per_workload);
    assert.equal(workloads.length, 5);
    assert.ok(workloads.includes("refactor"));
    assert.ok(workloads.includes("feature_add"));
    assert.ok(workloads.includes("debug"));
    assert.ok(workloads.includes("doc_lookup"));
    assert.ok(workloads.includes("test_writing"));
  });

  it("BYTE-IDENTICAL across two invocations (procurement reproducibility at scale)", () => {
    const out1 = run100qFixturePipeline();
    const out2 = run100qFixturePipeline();
    assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  });

  it("verifyAuditTrailHash returns Ok on the 100q integration audit", () => {
    const out = run100qFixturePipeline();
    const r = verifyAuditTrailHash(out);
    assert.equal(r.ok, true);
  });

  // GOLDEN HASH — locks the 100q reproducibility contract for INTEGRATION TEST inputs.
  // Note: integration test uses basename-only file labels ("baseline-100q.jsonl")
  // vs CLI which uses full paths — hashes differ because inputs.baseline_file is in
  // the audit block. The CLI golden hash is documented separately in bench/100q-summary.md.
  // Captured 2026-05-21 from first green run of the 100q benchmark pipeline.
  it("GOLDEN HASH (100q integration) locks the flagship reproducibility contract", () => {
    const out = run100qFixturePipeline();
    assert.equal(
      out.audit_trail_hash,
      "sha256:ab1ba82dd629f275451916c827edf2bdfbb41faab35de44eee5d6dd6ff0240f7",
    );
  });
});
