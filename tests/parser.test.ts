/**
 * parser.ts tests — JSONL ingest, line terminators, hard limits, fingerprint.
 *
 * Covers SPEC v0.1.3 §F1 (workload fingerprint), §F10 (Unicode terminators),
 * §S2 (parser hard limits), §C5 (negative token clamping), §F3 (BOM handling).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeLineTerminators,
  stripBom,
  walkValidate,
  parseJsonlString,
  parseJsonlFile,
  computeWorkloadFingerprint,
  DEFAULT_PARSER_LIMITS,
} from "../src/parser.js";
import type { ParserLimits } from "../src/parser.js";
import type { LogEntry, Warning } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

// ════════════════════════════════════════════════════════════════════
// stripBom
// ════════════════════════════════════════════════════════════════════

describe("stripBom (P0-3A multi-strip)", () => {
  it("returns [input, 0] when no BOM present", () => {
    const [s, count] = stripBom("hello");
    assert.equal(s, "hello");
    assert.equal(count, 0);
  });

  it("strips a single UTF-8 BOM and returns count=1", () => {
    const [s, count] = stripBom("﻿hello");
    assert.equal(s, "hello");
    assert.equal(count, 1);
  });

  it("handles empty string (no BOM)", () => {
    const [s, count] = stripBom("");
    assert.equal(s, "");
    assert.equal(count, 0);
  });

  it("STRIPS ALL stacked BOMs (P0-3A — single-strip enabled SHA-grinding)", () => {
    const [s, count] = stripBom("﻿﻿﻿hello");
    assert.equal(s, "hello");
    assert.equal(count, 3);
  });
});

// ════════════════════════════════════════════════════════════════════
// normalizeLineTerminators — 7 sequences per SPEC F10
// ════════════════════════════════════════════════════════════════════

describe("normalizeLineTerminators (SPEC F10 — 7 sequences)", () => {
  it("normalizes CRLF (Windows) to LF", () => {
    assert.equal(normalizeLineTerminators("a\r\nb"), "a\nb");
  });

  it("normalizes CR (old Mac) to LF", () => {
    assert.equal(normalizeLineTerminators("a\rb"), "a\nb");
  });

  it("preserves LF (Unix) as-is", () => {
    assert.equal(normalizeLineTerminators("a\nb"), "a\nb");
  });

  it("normalizes U+2028 (Line Separator) to LF", () => {
    assert.equal(normalizeLineTerminators("a\u2028b"), "a\nb");
  });

  it("normalizes U+2029 (Paragraph Separator) to LF", () => {
    assert.equal(normalizeLineTerminators("a\u2029b"), "a\nb");
  });

  it("normalizes U+0085 (Next Line / NEL) to LF", () => {
    assert.equal(normalizeLineTerminators("a\u0085b"), "a\nb");
  });

  it("normalizes U+000C (Form Feed) to LF", () => {
    assert.equal(normalizeLineTerminators("a\u000cb"), "a\nb");
  });

  it("normalizes mixed terminators in same string", () => {
    const input = "a\r\nb\rc\nd\u2028e\u2029f\u0085g\u000ch";
    const output = normalizeLineTerminators(input);
    assert.equal(output, "a\nb\nc\nd\ne\nf\ng\nh");
  });
});

// ════════════════════════════════════════════════════════════════════
// walkValidate — hard limits
// ════════════════════════════════════════════════════════════════════

describe("walkValidate (SPEC S2 hard limits)", () => {
  const limits = DEFAULT_PARSER_LIMITS;

  it("accepts shallow object within all limits", () => {
    const r = walkValidate({ a: 1, b: "ok" }, limits, 1, "$");
    assert.equal(r.ok, true);
  });

  it("rejects depth > maxDepth", () => {
    // build object with depth 10
    let v: unknown = "leaf";
    for (let i = 0; i < 10; i++) v = { nested: v };
    const r = walkValidate(v, limits, 1, "$");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "constraint_violation");
  });

  it("rejects field count > maxFieldsPerObject (64)", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 65; i++) big[`k${i}`] = i;
    const r = walkValidate(big, limits, 1, "$");
    assert.equal(r.ok, false);
  });

  it("rejects string > maxStringLength (4096)", () => {
    const longString = "x".repeat(4097);
    const r = walkValidate({ s: longString }, limits, 1, "$");
    assert.equal(r.ok, false);
  });

  it("REJECTS __proto__ key (prototype pollution defense)", () => {
    // Use defineProperty to avoid TS complaining about __proto__
    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    const r = walkValidate(evil, limits, 1, "$");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "schema_violation");
      assert.ok(r.error.message.includes("__proto__"));
    }
  });

  it("REJECTS constructor key", () => {
    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, "constructor", {
      value: { x: 1 },
      enumerable: true,
      configurable: true,
    });
    const r = walkValidate(evil, limits, 1, "$");
    assert.equal(r.ok, false);
  });

  it("REJECTS prototype key", () => {
    const evil = { prototype: { x: 1 } };
    const r = walkValidate(evil, limits, 1, "$");
    assert.equal(r.ok, false);
  });
});

// ════════════════════════════════════════════════════════════════════
// parseJsonlString — main ingest path
// ════════════════════════════════════════════════════════════════════

describe("parseJsonlString (happy path)", () => {
  const sample10q = `{"query_id":"q_001","timestamp":"2026-05-21T10:00:00Z","tokens_sent":50000,"tokens_received":2000,"workload":"refactor"}
{"query_id":"q_002","timestamp":"2026-05-21T10:00:10Z","tokens_sent":48000,"tokens_received":1800,"workload":"refactor"}
{"query_id":"q_003","timestamp":"2026-05-21T10:00:20Z","tokens_sent":52000,"tokens_received":2200,"workload":"refactor"}
`;

  it("parses 3 valid entries from 3 lines", () => {
    const r = parseJsonlString(sample10q);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.entries.length, 3);
    assert.equal(r.value.parsed_lines, 3);
    assert.equal(r.value.skipped_lines, 0);
    assert.equal(r.value.bom_stripped, false);
    assert.equal(r.value.warnings.length, 0);
  });

  it("preserves required + optional fields", () => {
    const r = parseJsonlString(sample10q);
    if (!r.ok) throw new Error("expected ok");
    const e = r.value.entries[0]!;
    assert.equal(e.query_id, "q_001");
    assert.equal(e.timestamp, "2026-05-21T10:00:00Z");
    assert.equal(e.tokens_sent, 50000);
    assert.equal(e.tokens_received, 2000);
    assert.equal(e.workload, "refactor");
  });

  it("produces deterministic file_sha256 for same input", () => {
    const r1 = parseJsonlString(sample10q);
    const r2 = parseJsonlString(sample10q);
    if (!r1.ok || !r2.ok) throw new Error("expected ok");
    assert.equal(r1.value.file_sha256, r2.value.file_sha256);
    assert.match(r1.value.file_sha256, /^sha256:[0-9a-f]{64}$/);
  });

  it("produces DIFFERENT file_sha256 for different line endings (raw bytes hash)", () => {
    const lf = `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}`;
    const crlf = lf.replace(/\n/g, "\r\n") + "\r\n"; // CRLF + trailing
    const lfTrailing = lf + "\n";
    const r1 = parseJsonlString(lfTrailing);
    const r2 = parseJsonlString(crlf);
    if (!r1.ok || !r2.ok) throw new Error("expected ok");
    // Logical content same but raw bytes differ → different SHAs
    assert.notEqual(r1.value.file_sha256, r2.value.file_sha256);
    // But both should parse to 1 entry (LF after normalization)
    assert.equal(r1.value.entries.length, 1);
    assert.equal(r2.value.entries.length, 1);
  });
});

describe("parseJsonlString (BOM)", () => {
  it("strips single UTF-8 BOM + emits warning + bom_count=1", () => {
    const withBom =
      "﻿" +
      `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}\n`;
    const r = parseJsonlString(withBom);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.bom_stripped, true);
    assert.equal(r.value.bom_count, 1);
    assert.equal(r.value.entries.length, 1);
    const bomWarning = r.value.warnings.find((w) => w.code === "bom_stripped");
    assert.ok(bomWarning);
  });

  it("strips STACKED BOMs + flags adversarial pattern (P0-3A)", () => {
    const stacked =
      "﻿﻿﻿﻿﻿" +
      `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}\n`;
    const r = parseJsonlString(stacked);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.bom_count, 5);
    assert.equal(r.value.entries.length, 1);
    const w = r.value.warnings.find((wn) => wn.code === "bom_stripped");
    assert.ok(w);
    assert.match(w.message, /5 stacked/);
  });

  it("normalized_content_sha256 IDENTICAL across BOM-stacking variants (P0-3A)", () => {
    // Same logical content, different BOM stacking — file_sha256 differs (good)
    // but normalized_content_sha256 IDENTICAL (defeats SHA-grinding).
    const body = `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}\n`;
    const v1 = parseJsonlString(body);
    const v2 = parseJsonlString("﻿" + body);
    const v3 = parseJsonlString("﻿﻿﻿" + body);
    if (!v1.ok || !v2.ok || !v3.ok) throw new Error("expected ok");

    // file_sha256 — varies by raw bytes
    assert.notEqual(v1.value.file_sha256, v2.value.file_sha256);
    assert.notEqual(v2.value.file_sha256, v3.value.file_sha256);

    // normalized_content_sha256 — IDENTICAL (BOM stripped before hash)
    assert.equal(v1.value.normalized_content_sha256, v2.value.normalized_content_sha256);
    assert.equal(v2.value.normalized_content_sha256, v3.value.normalized_content_sha256);
  });

  it("normalized_content_sha256 IDENTICAL across line-ending variants (P0-3A)", () => {
    const body = `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}`;
    const lf = parseJsonlString(body + "\n");
    const crlf = parseJsonlString(body + "\r\n");
    if (!lf.ok || !crlf.ok) throw new Error("expected ok");

    // file_sha256 differs
    assert.notEqual(lf.value.file_sha256, crlf.value.file_sha256);
    // normalized_content_sha256 identical (both LF after normalization)
    assert.equal(lf.value.normalized_content_sha256, crlf.value.normalized_content_sha256);
  });
});

describe("parseJsonlString (Unicode line terminators)", () => {
  it("splits on U+2028 (Line Separator)", () => {
    const input =
      `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}` +
      "\u2028" +
      `{"query_id":"q_002","timestamp":"t","tokens_sent":1,"tokens_received":1}`;
    const r = parseJsonlString(input);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 2);
  });

  it("splits on U+2029 (Paragraph Separator)", () => {
    const input =
      `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}` +
      "\u2029" +
      `{"query_id":"q_002","timestamp":"t","tokens_sent":1,"tokens_received":1}`;
    const r = parseJsonlString(input);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 2);
  });
});

describe("parseJsonlString (malformed lines)", () => {
  it("skips malformed JSON line + emits malformed_jsonl_line warning, continues", () => {
    const mixed =
      `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}\n` +
      `this is not JSON\n` +
      `{"query_id":"q_002","timestamp":"t","tokens_sent":1,"tokens_received":1}\n`;
    const r = parseJsonlString(mixed);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 2);
    assert.equal(r.value.skipped_lines, 1);
    const malformed = r.value.warnings.find(
      (w) => w.code === "malformed_jsonl_line",
    );
    assert.ok(malformed);
  });

  it("skips non-object JSON (array or primitive) with warning", () => {
    const r = parseJsonlString(`[1, 2, 3]\n`);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
    assert.equal(r.value.skipped_lines, 1);
  });

  it("skips entries missing required fields", () => {
    const missing = `{"query_id":"q_001"}\n`;
    const r = parseJsonlString(missing);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
    assert.equal(r.value.skipped_lines, 1);
  });

  it("skips entries with empty query_id", () => {
    const r = parseJsonlString(
      `{"query_id":"","timestamp":"t","tokens_sent":1,"tokens_received":1}\n`,
    );
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
  });

  it("ignores blank lines silently (no warning)", () => {
    const withBlanks =
      `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1}\n` +
      `\n` +
      `\n` +
      `{"query_id":"q_002","timestamp":"t","tokens_sent":1,"tokens_received":1}\n`;
    const r = parseJsonlString(withBlanks);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 2);
    assert.equal(r.value.total_lines, 2); // blank lines excluded
    assert.equal(r.value.warnings.length, 0);
  });
});

describe("parseJsonlString (negative tokens per C5)", () => {
  it("clamps negative tokens_sent to 0 + emits warning + KEEPS entry", () => {
    const negSent = `{"query_id":"q_001","timestamp":"t","tokens_sent":-100,"tokens_received":50}\n`;
    const r = parseJsonlString(negSent);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 1);
    assert.equal(r.value.entries[0]!.tokens_sent, 0);
    assert.equal(r.value.entries[0]!.tokens_received, 50);
    const clampWarn = r.value.warnings.find(
      (w) => w.code === "negative_token_clamped",
    );
    assert.ok(clampWarn);
  });

  it("clamps both negative values + KEEPS entry", () => {
    const r = parseJsonlString(
      `{"query_id":"q_001","timestamp":"t","tokens_sent":-100,"tokens_received":-50}\n`,
    );
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries[0]!.tokens_sent, 0);
    assert.equal(r.value.entries[0]!.tokens_received, 0);
  });
});

describe("parseJsonlString (hard limits)", () => {
  it("rejects line > maxLineLength via limit warning + skip", () => {
    const longString = `{"x":"${"a".repeat(1_000_001)}"}`;
    const r = parseJsonlString(longString + "\n");
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
    const limitWarn = r.value.warnings.find(
      (w) => w.code === "parser_limit_exceeded",
    );
    assert.ok(limitWarn);
  });

  it("rejects object with > 64 fields", () => {
    const big: Record<string, unknown> = {
      query_id: "q_001",
      timestamp: "t",
      tokens_sent: 1,
      tokens_received: 1,
    };
    for (let i = 0; i < 65; i++) big[`extra${i}`] = i;
    const r = parseJsonlString(JSON.stringify(big) + "\n");
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
    const limitWarn = r.value.warnings.find(
      (w) => w.code === "parser_limit_exceeded",
    );
    assert.ok(limitWarn);
  });

  it("rejects entry with __proto__ key", () => {
    // Use JSON.parse with __proto__ as a literal key
    const evil = `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1,"__proto__":{"polluted":true}}`;
    const r = parseJsonlString(evil + "\n");
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
    const w = r.value.warnings.find(
      (warn) => warn.code === "parser_limit_exceeded",
    );
    assert.ok(w);
  });

  it("rejects file with > maxLinesPerFile (returns Err, not warning)", () => {
    // Generate >10M lines worth of empty lines — use small limit for the test
    const customLimits: Partial<ParserLimits> = { maxLinesPerFile: 3 };
    const tooMany = "x\ny\nz\na\nb\n"; // 5 lines
    const r = parseJsonlString(tooMany, { limits: customLimits });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "constraint_violation");
  });
});

// ════════════════════════════════════════════════════════════════════
// parseJsonlFile — file-system path
// ════════════════════════════════════════════════════════════════════

describe("parseJsonlFile", () => {
  it("parses the baseline-10q fixture", () => {
    const path = join(FIXTURES_DIR, "baseline-10q.jsonl");
    const r = parseJsonlFile(path);
    if (!r.ok) throw new Error(`expected ok; got ${r.error.message}`);
    assert.equal(r.value.entries.length, 10);
    assert.equal(r.value.parsed_lines, 10);
    assert.equal(r.value.skipped_lines, 0);
    assert.equal(r.value.bom_stripped, false);
  });

  it("parses the active-10q fixture", () => {
    const path = join(FIXTURES_DIR, "active-10q.jsonl");
    const r = parseJsonlFile(path);
    if (!r.ok) throw new Error(`expected ok; got ${r.error.message}`);
    assert.equal(r.value.entries.length, 10);
  });

  it("returns Err for missing file", () => {
    const r = parseJsonlFile("/nonexistent/path/file.jsonl");
    assert.equal(r.ok, false);
  });
});

// ════════════════════════════════════════════════════════════════════
// computeWorkloadFingerprint — SPEC F1 redesigned
// ════════════════════════════════════════════════════════════════════

describe("computeWorkloadFingerprint (SPEC F1)", () => {
  function makeEntry(query_id: string, workload?: string): LogEntry {
    const e: LogEntry = {
      query_id,
      timestamp: "2026-05-21T10:00:00Z",
      tokens_sent: 100,
      tokens_received: 10,
    };
    if (workload !== undefined) e.workload = workload;
    return e;
  }

  it("matches when baseline + active have identical (query_id, workload) tuples", () => {
    const baseline = [
      makeEntry("q_001", "refactor"),
      makeEntry("q_002", "debug"),
      makeEntry("q_003", "feature_add"),
    ];
    const active = [
      makeEntry("q_001", "refactor"),
      makeEntry("q_002", "debug"),
      makeEntry("q_003", "feature_add"),
    ];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.01,
      countSkewWarn: 0.5,
    });
    assert.equal(r.fingerprint_match, true);
    assert.equal(r.fingerprint_reason, "ok");
    assert.equal(r.baseline_workloads, r.active_workloads);
  });

  it("NORMALIZES workload via lowercase + trim (case/whitespace bypass closed)", () => {
    const baseline = [makeEntry("q_001", "refactor")];
    const active = [makeEntry("q_001", "  REFACTOR  ")];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.01,
      countSkewWarn: 0.5,
    });
    assert.equal(r.fingerprint_match, true);
    assert.equal(r.fingerprint_reason, "ok");
  });

  it("FAIL-CLOSED when workload absent on >1% of entries", () => {
    const baseline = [
      makeEntry("q_001", "refactor"),
      makeEntry("q_002"), // no workload
    ];
    const active = [makeEntry("q_001", "refactor"), makeEntry("q_002")];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.01,
      countSkewWarn: 0.5,
    });
    assert.equal(r.fingerprint_match, null);
    assert.equal(r.fingerprint_reason, "workload_field_absent");
    const w = r.warnings.find((w) => w.code === "workload_field_absent");
    assert.ok(w);
  });

  it("detects set mismatch when query_ids differ", () => {
    const baseline = [
      makeEntry("q_001", "refactor"),
      makeEntry("q_002", "debug"),
    ];
    const active = [
      makeEntry("q_001", "refactor"),
      makeEntry("q_003", "debug"), // different query_id
    ];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.01,
      countSkewWarn: 0.5,
    });
    assert.equal(r.fingerprint_match, false);
    assert.equal(r.fingerprint_reason, "set_mismatch");
  });

  it("provides count_per_workload breakdown", () => {
    const baseline = [
      makeEntry("q_001", "refactor"),
      makeEntry("q_002", "refactor"),
      makeEntry("q_003", "debug"),
    ];
    const active = [
      makeEntry("q_001", "refactor"),
      makeEntry("q_002", "refactor"),
      makeEntry("q_003", "debug"),
    ];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.01,
      countSkewWarn: 0.5,
    });
    assert.equal(r.count_per_workload["refactor"]?.baseline, 2);
    assert.equal(r.count_per_workload["refactor"]?.active, 2);
    assert.equal(r.count_per_workload["debug"]?.baseline, 1);
    assert.equal(r.count_per_workload["debug"]?.active, 1);
  });
});

// ════════════════════════════════════════════════════════════════════
// HARDENING — attack-defense tests from adversarial security review
// ════════════════════════════════════════════════════════════════════

describe("P0-2A MAX_SAFE_INTEGER guard (token precision-loss smuggle)", () => {
  it("REJECTS tokens_sent > Number.MAX_SAFE_INTEGER", () => {
    // 9007199254740993 (2^53+1) — silently becomes 9007199254740992 in JSON.parse
    const evil = `{"query_id":"q_001","timestamp":"t","tokens_sent":9007199254740993,"tokens_received":1}\n`;
    const r = parseJsonlString(evil);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
    const w = r.value.warnings.find((wn) => wn.code === "malformed_jsonl_line");
    assert.ok(w);
    assert.match(w.message, /MAX_SAFE_INTEGER/);
  });

  it("REJECTS tokens_received > Number.MAX_SAFE_INTEGER", () => {
    const evil = `{"query_id":"q_001","timestamp":"t","tokens_sent":1,"tokens_received":1e20}\n`;
    const r = parseJsonlString(evil);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
  });

  it("ACCEPTS tokens at Number.MAX_SAFE_INTEGER boundary", () => {
    const safe = `{"query_id":"q_001","timestamp":"t","tokens_sent":9007199254740991,"tokens_received":1}\n`;
    const r = parseJsonlString(safe);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 1);
  });
});

describe("Sec P1-C — non-integer check BEFORE clamp (preserve signal)", () => {
  it("REJECTS tokens_sent: -3.7 as non-integer (not silently clamped to 0)", () => {
    const tricky = `{"query_id":"q_001","timestamp":"t","tokens_sent":-3.7,"tokens_received":0}\n`;
    const r = parseJsonlString(tricky);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
    const w = r.value.warnings.find((wn) =>
      wn.message.includes("non-integer"),
    );
    assert.ok(w);
  });

  it("REJECTS tokens_sent: 0.5 as non-integer", () => {
    const tricky = `{"query_id":"q_001","timestamp":"t","tokens_sent":0.5,"tokens_received":0}\n`;
    const r = parseJsonlString(tricky);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 0);
  });

  it("ACCEPTS tokens_sent: -3 as clamped integer (keeps entry, warns)", () => {
    const negInt = `{"query_id":"q_001","timestamp":"t","tokens_sent":-3,"tokens_received":0}\n`;
    const r = parseJsonlString(negInt);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.entries.length, 1);
    assert.equal(r.value.entries[0]!.tokens_sent, 0);
    const w = r.value.warnings.find((wn) => wn.code === "negative_token_clamped");
    assert.ok(w);
  });
});

describe("P0-5A — prototype-mutation belt-and-braces defense", () => {
  it("REJECTS object whose prototype was mutated via Object.setPrototypeOf", () => {
    // Construct via Object.create with non-standard prototype
    const evil = Object.create({ inherited: true });
    evil.query_id = "q_001";
    evil.timestamp = "t";
    evil.tokens_sent = 1;
    evil.tokens_received = 1;

    // Note: we can't smuggle this through JSONL parsing — JSON.parse always
    // creates Object.prototype-rooted objects on Node 20+. But walkValidate
    // directly should reject it (belt-and-braces).
    const r = walkValidate(evil, DEFAULT_PARSER_LIMITS, 1, "$");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "schema_violation");
      assert.match(r.error.message, /prototype/);
    }
  });

  it("ACCEPTS object created via Object.create(null) (legitimate dictionary)", () => {
    const dict: Record<string, unknown> = Object.create(null);
    dict["query_id"] = "q_001";
    const r = walkValidate(dict, DEFAULT_PARSER_LIMITS, 1, "$");
    assert.equal(r.ok, true);
  });
});

describe("P0-1A — Fingerprint :/| collision defense (JSON.stringify tuples)", () => {
  function makeEntry(query_id: string, workload?: string): LogEntry {
    const e: LogEntry = {
      query_id,
      timestamp: "2026-05-21T10:00:00Z",
      tokens_sent: 100,
      tokens_received: 10,
    };
    if (workload !== undefined) e.workload = workload;
    return e;
  }

  it("DEFEATS classic colon-separator collision attack", () => {
    // Attacker tries to make these two appear identical via the old
    // `${id}:${workload}` string concat (which produces "q_001:refactor:extra"
    // for BOTH inputs):
    //   id="q_001:refactor", workload="extra"      → "q_001:refactor:extra"
    //   id="q_001",          workload="refactor:extra" → "q_001:refactor:extra"
    // With JSON.stringify tuples, these produce DIFFERENT canonical forms:
    //   ["q_001:refactor","extra"]  vs  ["q_001","refactor:extra"]
    const baseline = [makeEntry("q_001:refactor", "extra")];
    const active = [makeEntry("q_001", "refactor:extra")];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.5,
      countSkewWarn: 0.5,
    });
    // Should be detected as set_mismatch (NOT collision-matched as before)
    assert.equal(r.fingerprint_match, false);
  });

  it("DEFEATS pipe-injection collision via | in query_id", () => {
    const baseline = [makeEntry("q_001|q_002", "refactor")];
    const active = [
      makeEntry("q_001", "refactor"),
      makeEntry("q_002", "refactor"),
    ];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.5,
      countSkewWarn: 0.5,
    });
    assert.equal(r.fingerprint_match, false);
  });
});

describe("P0-4A — collect ALL count_skews (no alphabetic-first hiding)", () => {
  function makeEntry(query_id: string, workload: string): LogEntry {
    return {
      query_id,
      timestamp: "t",
      tokens_sent: 100,
      tokens_received: 10,
      workload,
    };
  }

  it("flags MULTIPLE skewed workloads via skewed_workloads array", () => {
    // 3 workloads, each skewed differently. Previously only first reported.
    const baseline = [
      ...Array.from({ length: 10 }, (_, i) => makeEntry(`a${i}`, "alpha")),
      ...Array.from({ length: 10 }, (_, i) => makeEntry(`b${i}`, "beta")),
      ...Array.from({ length: 10 }, (_, i) => makeEntry(`c${i}`, "gamma")),
    ];
    // Active: drop most of alpha and beta; keep gamma roughly balanced
    const active = [
      ...Array.from({ length: 2 }, (_, i) => makeEntry(`a${i}`, "alpha")), // 80% skew
      ...Array.from({ length: 1 }, (_, i) => makeEntry(`b${i}`, "beta")), // 90% skew
      ...Array.from({ length: 10 }, (_, i) => makeEntry(`c${i}`, "gamma")),
    ];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.01,
      countSkewWarn: 0.5,
    });
    // Hashes will differ (set_mismatch via missing entries) BUT skewed_workloads
    // surfaces alpha + beta (P0-2C requirement).
    assert.ok(r.skewed_workloads.length >= 2);
    assert.ok(r.skewed_workloads.includes("alpha"));
    assert.ok(r.skewed_workloads.includes("beta"));
    // Multiple skew warnings should be present
    const skewWarnings = r.warnings.filter(
      (w) => w.code === "fingerprint_count_skew",
    );
    assert.ok(skewWarnings.length >= 2);
  });
});

describe("P1-c — empty baseline/active returns empty_input (fail-closed)", () => {
  it("returns null match + empty_input reason for empty baseline", () => {
    const r = computeWorkloadFingerprint({
      baseline: [],
      active: [
        {
          query_id: "q_001",
          timestamp: "t",
          tokens_sent: 1,
          tokens_received: 1,
        },
      ],
      workloadAbsentFailClosed: 0.5,
      countSkewWarn: 0.5,
    });
    assert.equal(r.fingerprint_match, null);
    assert.equal(r.fingerprint_reason, "empty_input");
  });

  it("returns null match + empty_input reason for empty active", () => {
    const r = computeWorkloadFingerprint({
      baseline: [
        {
          query_id: "q_001",
          timestamp: "t",
          tokens_sent: 1,
          tokens_received: 1,
        },
      ],
      active: [],
      workloadAbsentFailClosed: 0.5,
      countSkewWarn: 0.5,
    });
    assert.equal(r.fingerprint_match, null);
    assert.equal(r.fingerprint_reason, "empty_input");
  });

  it("returns null match for both empty (no silent fingerprint_match=true)", () => {
    const r = computeWorkloadFingerprint({
      baseline: [],
      active: [],
      workloadAbsentFailClosed: 0.5,
      countSkewWarn: 0.5,
    });
    assert.equal(r.fingerprint_match, null);
    assert.equal(r.fingerprint_reason, "empty_input");
  });
});

describe("P1-d — Unicode NFC normalization on workload", () => {
  function makeEntry(query_id: string, workload: string): LogEntry {
    return {
      query_id,
      timestamp: "t",
      tokens_sent: 100,
      tokens_received: 10,
      workload,
    };
  }

  it("matches composed vs decomposed Unicode workloads", () => {
    // "refactör" composed (NFC, ö = U+00F6) vs decomposed (NFD, o + U+0308)
    const composed = "refactör";
    const decomposed = "refactör";
    const baseline = [makeEntry("q_001", composed)];
    const active = [makeEntry("q_001", decomposed)];
    const r = computeWorkloadFingerprint({
      baseline,
      active,
      workloadAbsentFailClosed: 0.01,
      countSkewWarn: 0.5,
    });
    // Both normalize to NFC → match
    assert.equal(r.fingerprint_match, true);
  });
});

