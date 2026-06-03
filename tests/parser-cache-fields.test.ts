/**
 * Tests for v0.2 optional cache fields on LogEntry.
 *
 * Verifies parser correctly:
 *   - Reads cache_read_tokens + cache_creation_tokens when present
 *   - Treats absent fields as undefined (v0.1.x JSONL back-compat)
 *   - Rejects lines with invalid cache values (strict-when-present)
 *
 * Test isolation: these only exercise the cache-field parsing path. The
 * existing parser test suite (parser.test.ts) still owns all the v0.1.x
 * behavior coverage — these tests are purely additive.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseJsonlString } from "../src/parser";

function singleLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const BASE = {
  query_id: "q-001",
  timestamp: "2026-05-29T00:00:00Z",
  tokens_sent: 100,
  tokens_received: 50,
};

/** Unwrap a Result, throwing on the error variant — tightens test failures. */
function unwrap<T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!r.ok) {
    throw new Error(`parseJsonlString returned err: ${JSON.stringify(r.error)}`);
  }
  return r.value;
}

describe("LogEntry v0.2 cache fields — parser", () => {
  it("reads cache_read_tokens + cache_creation_tokens when both present", () => {
    const input = singleLine({
      ...BASE,
      cache_read_tokens: 5000,
      cache_creation_tokens: 1200,
    });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 1);
    const entry = r.entries[0]!;
    assert.equal(entry.cache_read_tokens, 5000);
    assert.equal(entry.cache_creation_tokens, 1200);
  });

  it("treats absent cache fields as undefined (v0.1.x back-compat)", () => {
    const input = singleLine(BASE);
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 1);
    const entry = r.entries[0]!;
    assert.equal(entry.cache_read_tokens, undefined);
    assert.equal(entry.cache_creation_tokens, undefined);
  });

  it("accepts cache_read_tokens=0 (caching configured but no hits)", () => {
    const input = singleLine({ ...BASE, cache_read_tokens: 0 });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0]!.cache_read_tokens, 0);
  });

  it("accepts cache_read_tokens without cache_creation_tokens (partial)", () => {
    const input = singleLine({ ...BASE, cache_read_tokens: 1234 });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 1);
    const entry = r.entries[0]!;
    assert.equal(entry.cache_read_tokens, 1234);
    assert.equal(entry.cache_creation_tokens, undefined);
  });

  it("rejects negative cache_read_tokens", () => {
    const input = singleLine({ ...BASE, cache_read_tokens: -5 });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0]!.code, "malformed_jsonl_line");
    assert.match(r.warnings[0]!.message, /cache_read_tokens/);
  });

  it("rejects non-integer cache_read_tokens", () => {
    const input = singleLine({ ...BASE, cache_read_tokens: 3.14 });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!.message, /cache_read_tokens/);
  });

  it("rejects non-number cache_read_tokens", () => {
    const input = singleLine({ ...BASE, cache_read_tokens: "5000" });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!.message, /cache_read_tokens/);
  });

  it("rejects cache_read_tokens > Number.MAX_SAFE_INTEGER", () => {
    // 9_007_199_254_740_992 == 2^53; +1 loses precision in JSON.parse
    const input = singleLine({ ...BASE, cache_read_tokens: Number.MAX_SAFE_INTEGER + 1 });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!.message, /cache_read_tokens/);
  });

  it("rejects negative cache_creation_tokens (same strict rule)", () => {
    const input = singleLine({ ...BASE, cache_creation_tokens: -100 });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!.message, /cache_creation_tokens/);
  });

  it("rejects NaN cache_creation_tokens", () => {
    const input = singleLine({ ...BASE, cache_creation_tokens: NaN });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!.message, /cache_creation_tokens/);
  });

  it("accepts a realistic row with caching active", () => {
    // Mirrors a real cache-enabled agent prompt (feature_add workload)
    const input = singleLine({
      query_id: "sou-feature_add-q00001",
      timestamp: "2026-05-29T00:00:00Z",
      tokens_sent: 942,
      tokens_received: 997,
      workload: "feature_add",
      cache_read_tokens: 18320,
      cache_creation_tokens: 10588,
    });
    const r = unwrap(parseJsonlString(input));
    assert.equal(r.entries.length, 1);
    const entry = r.entries[0]!;
    assert.equal(entry.tokens_sent, 942);
    assert.equal(entry.cache_read_tokens, 18320);
    assert.equal(entry.cache_creation_tokens, 10588);
    assert.equal(entry.workload, "feature_add");
  });

  it("rejects whole line on invalid cache field (strict-when-present)", () => {
    // The whole line gets rejected on invalid cache field — even though
    // tokens_sent + tokens_received are valid. Mirrors how timestamp is treated.
    const input = singleLine({ ...BASE, cache_read_tokens: -1 });
    const r = unwrap(parseJsonlString(input));
    // Zero entries, one warning — no partial entry leaked.
    assert.equal(r.entries.length, 0);
    assert.equal(r.warnings.filter(w => w.code === "malformed_jsonl_line").length, 1);
  });
});
