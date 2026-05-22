/**
 * tests for the v0.1.5 architectural foundations:
 *   - Result<T,E> + ok/err/mapResult/flatMapResult
 *   - Brand type constructors (asQueryId, asSha256Hex, asBasisPoints)
 *   - Logger interface (NullLogger contract)
 *   - validateIngestionV1 structural validator
 *
 * Per architecture lock.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ok,
  err,
  mapResult,
  flatMapResult,
  asQueryId,
  asSha256Hex,
  asBasisPoints,
  NullLogger,
} from "../src/types.js";
import type { Logger, Warning } from "../src/types.js";
import {
  validateIngestionV1,
  INGESTION_CONTRACT_V1,
  STATEMENT_V1_TYPE,
  PREDICATE_TYPE,
  SCHEMA_URL,
} from "../src/schema.js";

// ════════════════════════════════════════════════════════════════════
// Result<T, E> primitives
// ════════════════════════════════════════════════════════════════════

describe("Result<T, E> primitives", () => {
  it("ok() constructs a successful Result with the value", () => {
    const r = ok(42);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, 42);
  });

  it("err() constructs a failed Result with the error", () => {
    const e = new Error("test");
    const r = err(e);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, e);
  });

  it("mapResult transforms value on Ok, preserves Err", () => {
    const success = mapResult(ok(10), (x) => x * 2);
    if (success.ok) assert.equal(success.value, 20);

    const failure = mapResult(err("boom"), (x: number) => x * 2);
    if (!failure.ok) assert.equal(failure.error, "boom");
  });

  it("flatMapResult chains Result-returning operations", () => {
    const divideBy = (n: number) =>
      n === 0 ? err("div by zero") : ok(100 / n);

    const success = flatMapResult(ok(5), divideBy);
    if (success.ok) assert.equal(success.value, 20);

    const passthrough = flatMapResult(ok(0), divideBy);
    if (!passthrough.ok) assert.equal(passthrough.error, "div by zero");

    const errorPropagates = flatMapResult(
      err<string>("prior"),
      divideBy,
    );
    if (!errorPropagates.ok) assert.equal(errorPropagates.error, "prior");
  });
});

// ════════════════════════════════════════════════════════════════════
// Brand type safe constructors
// ════════════════════════════════════════════════════════════════════

describe("Brand type constructors", () => {
  describe("asQueryId", () => {
    it("accepts non-empty strings, returns Ok", () => {
      const r = asQueryId("q_abc123");
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value, "q_abc123");
    });

    it("preserves case-sensitivity (per SPEC C4)", () => {
      const a = asQueryId("Q_ABC");
      const b = asQueryId("q_abc");
      if (a.ok && b.ok) {
        assert.notEqual(a.value, b.value);
      }
    });

    it("rejects empty strings", () => {
      const r = asQueryId("");
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, "invalid_type");
    });
  });

  describe("asSha256Hex", () => {
    it("accepts valid sha256:<64-hex>", () => {
      const valid = "sha256:" + "a".repeat(64);
      const r = asSha256Hex(valid);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value, valid);
    });

    it("rejects missing sha256: prefix", () => {
      const r = asSha256Hex("a".repeat(64));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, "format_violation");
    });

    it("rejects wrong-length hex", () => {
      const r = asSha256Hex("sha256:" + "a".repeat(63));
      assert.equal(r.ok, false);
    });

    it("rejects uppercase hex (canonical is lowercase)", () => {
      const r = asSha256Hex("sha256:" + "A".repeat(64));
      assert.equal(r.ok, false);
    });
  });

  describe("asBasisPoints", () => {
    it("accepts positive integers (saved %)", () => {
      const r = asBasisPoints(9000);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.value, 9000);
    });

    it("accepts negative integers (engram regression)", () => {
      const r = asBasisPoints(-500);
      assert.equal(r.ok, true);
    });

    it("rejects non-integer numbers (IEEE-754 protection)", () => {
      const r = asBasisPoints(87.62);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, "invalid_type");
    });

    it("rejects NaN", () => {
      const r = asBasisPoints(NaN);
      assert.equal(r.ok, false);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// Logger contract
// ════════════════════════════════════════════════════════════════════

describe("Logger contract", () => {
  it("NullLogger no-ops cleanly", () => {
    const log: Logger = new NullLogger();
    assert.doesNotThrow(() => {
      log.warn("test", { foo: "bar" });
      log.info("test");
      log.debug("test", {});
    });
  });

  it("Logger interface accepts any conforming implementation", () => {
    const captured: Array<{ level: string; msg: string }> = [];
    const log: Logger = {
      warn: (msg) => captured.push({ level: "warn", msg }),
      info: (msg) => captured.push({ level: "info", msg }),
      debug: (msg) => captured.push({ level: "debug", msg }),
    };
    log.warn("hello");
    log.info("world");
    assert.equal(captured.length, 2);
    assert.equal(captured[0]?.level, "warn");
    assert.equal(captured[1]?.msg, "world");
  });
});

// ════════════════════════════════════════════════════════════════════
// validateIngestionV1 — structural validator
// ════════════════════════════════════════════════════════════════════

/** Build a minimal valid AuditOutput for happy-path tests. */
function buildValidAudit(): unknown {
  return {
    envelope: {
      computed_at: "2026-05-21T15:00:00Z",
      audit_id: "test-audit-001",
      reproducible_mode: true,
      ingestion_contract: INGESTION_CONTRACT_V1,
      _type: STATEMENT_V1_TYPE,
      predicateType: PREDICATE_TYPE,
      schema_url: SCHEMA_URL,
    },
    audit_trail_hash: "sha256:" + "a".repeat(64),
    audit: {
      version: "0.1.0",
      counter_version: "0.1.0",
      mode: "dev",
      methodology: "paired-run",
      inputs: {
        baseline_file: "baseline.jsonl",
        baseline_sha256: "sha256:" + "b".repeat(64),
        active_file: "active.jsonl",
        active_sha256: "sha256:" + "c".repeat(64),
        bom_stripped: false,
      },
      counts: {
        baseline_entries: 10,
        active_entries: 10,
        matched_queries: 10,
        baseline_only_queries: 0,
        active_only_queries: 0,
      },
      tokens: {
        baseline_sent_total: 521000,
        active_sent_total: 52100,
        saved_sent: 468900,
        baseline_received_total: 22550,
        active_received_total: 2255,
        saved_received: 20295,
        baseline_total: 543550,
        active_total: 54355,
        saved_total: 489195,
        saved_pct: 90,
      },
      cost_usd: null,
      per_workload: {},
      fingerprint: {
        baseline_workloads: "sha256:" + "d".repeat(64),
        active_workloads: "sha256:" + "d".repeat(64),
        fingerprint_match: true,
        fingerprint_reason: "ok",
        count_per_workload: {},
      },
      thresholds: {
        workload_absent_fail_closed: 0.01,
        mismatch_warn: 0.1,
        mismatch_high: 0.5,
        count_skew_warn: 0.5,
      },
      warnings: [],
    },
  };
}

describe("validateIngestionV1", () => {
  it("accepts valid AuditOutput", () => {
    const r = validateIngestionV1(buildValidAudit());
    assert.equal(r.ok, true);
  });

  it("rejects non-object root", () => {
    const r = validateIngestionV1("not an object");
    assert.equal(r.ok, false);
  });

  it("rejects missing envelope", () => {
    const a = buildValidAudit() as Record<string, unknown>;
    delete a["envelope"];
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "required_field_missing");
      assert.equal(r.error.path, "$.envelope");
    }
  });

  it("rejects wrong ingestion_contract value", () => {
    const a = buildValidAudit() as { envelope: Record<string, unknown> };
    a.envelope["ingestion_contract"] = "v2";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "schema_violation");
      assert.equal(r.error.path, "$.envelope.ingestion_contract");
    }
  });

  it("rejects malformed audit_trail_hash", () => {
    const a = buildValidAudit() as Record<string, unknown>;
    a["audit_trail_hash"] = "not-a-valid-hash";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
  });

  it("rejects strict mode without binary_sha256", () => {
    const a = buildValidAudit() as { audit: Record<string, unknown> };
    a.audit["mode"] = "strict";
    // intentionally NOT adding binary_sha256
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.path, "$.audit.binary_sha256");
  });

  it("accepts strict mode WITH valid binary_sha256", () => {
    const a = buildValidAudit() as { audit: Record<string, unknown> };
    a.audit["mode"] = "strict";
    a.audit["binary_sha256"] = "sha256:" + "e".repeat(64);
    const r = validateIngestionV1(a);
    assert.equal(r.ok, true);
  });

  it("rejects unknown warning codes", () => {
    const a = buildValidAudit() as { audit: { warnings: unknown[] } };
    a.audit.warnings.push({
      code: "totally_made_up_code",
      message: "test",
    });
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "constraint_violation");
  });

  it("accepts known warning codes", () => {
    const a = buildValidAudit() as { audit: { warnings: Warning[] } };
    a.audit.warnings.push({
      code: "low_mismatch_within_tolerance",
      message: "5 queries skipped",
    });
    const r = validateIngestionV1(a);
    assert.equal(r.ok, true);
  });

  it("rejects wrong _type URI (in-toto Statement v1 alignment)", () => {
    const a = buildValidAudit() as { envelope: Record<string, unknown> };
    a.envelope["_type"] = "https://wrong.example.com/type/v1";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.path, "$.envelope._type");
  });

  // ─── v0.1.5 adversarial-review hardening tests ───

  it("REJECTS wrong schema_url (must match SCHEMA_URL constant — closes adversarial P1)", () => {
    const a = buildValidAudit() as { envelope: Record<string, unknown> };
    a.envelope["schema_url"] = "https://attacker.example.com/x.json";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.path, "$.envelope.schema_url");
  });

  it("REJECTS additional properties in envelope (additionalProperties: false)", () => {
    const a = buildValidAudit() as { envelope: Record<string, unknown> };
    a.envelope["unknown_field"] = "should be rejected";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "unknown_field");
      assert.equal(r.error.path, "$.envelope.unknown_field");
    }
  });

  it("REJECTS __proto__ key (prototype pollution defense)", () => {
    const a = buildValidAudit() as Record<string, unknown>;
    Object.defineProperty(a, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
  });

  it("REJECTS non-ISO-8601 computed_at (was previously any string)", () => {
    const a = buildValidAudit() as { envelope: Record<string, unknown> };
    a.envelope["computed_at"] = "yesterday";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.path, "$.envelope.computed_at");
  });

  it("REJECTS non-integer count fields (was previously any value)", () => {
    const a = buildValidAudit() as { audit: { counts: Record<string, unknown> } };
    a.audit.counts["matched_queries"] = "100"; // string, not integer
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.path, "$.audit.counts.matched_queries");
  });

  it("REJECTS negative count (counts.* must be ≥ 0)", () => {
    const a = buildValidAudit() as { audit: { counts: Record<string, unknown> } };
    a.audit.counts["matched_queries"] = -100;
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
  });

  it("REJECTS out-of-range threshold (must be [0, 1])", () => {
    const a = buildValidAudit() as {
      audit: { thresholds: Record<string, unknown> };
    };
    a.audit.thresholds["mismatch_warn"] = 99; // way out of [0, 1]
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.path, "$.audit.thresholds.mismatch_warn");
  });

  it("REJECTS string saved_pct (must be finite number)", () => {
    const a = buildValidAudit() as { audit: { tokens: Record<string, unknown> } };
    a.audit.tokens["saved_pct"] = "90"; // string, not number
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.path, "$.audit.tokens.saved_pct");
  });

  it("REJECTS string cost_usd (must be number or null)", () => {
    const a = buildValidAudit() as { audit: Record<string, unknown> };
    a.audit["cost_usd"] = "1234.56";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.path, "$.audit.cost_usd");
  });

  it("ACCEPTS null cost_usd (when --cost-per-million not provided)", () => {
    const a = buildValidAudit() as { audit: Record<string, unknown> };
    a.audit["cost_usd"] = null;
    const r = validateIngestionV1(a);
    assert.equal(r.ok, true);
  });

  it("REJECTS non-boolean fingerprint_match", () => {
    const a = buildValidAudit() as {
      audit: { fingerprint: Record<string, unknown> };
    };
    a.audit.fingerprint["fingerprint_match"] = "true"; // string, not boolean
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
  });

  it("ACCEPTS null fingerprint_match (fail-closed case)", () => {
    const a = buildValidAudit() as {
      audit: { fingerprint: Record<string, unknown> };
    };
    a.audit.fingerprint["fingerprint_match"] = null;
    a.audit.fingerprint["fingerprint_reason"] = "workload_field_absent";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, true);
  });

  it("REJECTS unknown fingerprint_reason", () => {
    const a = buildValidAudit() as {
      audit: { fingerprint: Record<string, unknown> };
    };
    a.audit.fingerprint["fingerprint_reason"] = "made_up_reason";
    const r = validateIngestionV1(a);
    assert.equal(r.ok, false);
  });
});
