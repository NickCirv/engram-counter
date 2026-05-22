/**
 * engram-counter v0.1.0 — JCS canonicalization + SHA-256 + audit envelope assembly.
 *
 * THE TRUST-ANCHOR MODULE. The `audit_trail_hash` produced here is what:
 *   - Cosign / Sigstore signs (npm publish --provenance attaches a transparency entry)
 *   - Procurement auditors independently verify (run engram-counter on same inputs → same hash)
 *   - Downstream ingestion consumers validate against (recompute and check the submitted audit matches)
 *
 * Implements:
 *   - RFC 8785 JCS canonicalization (~150 LoC pure JS, zero deps)
 *   - SHA-256 over canonical bytes via node:crypto
 *   - F6 envelope pattern: outer presentation (computed_at, audit_id) NOT hashed,
 *     inner canonical audit IS hashed
 *   - Deterministic audit_id derivation from audit_trail_hash (reproducibility imperative)
 *
 * Zero runtime deps. Pure-functional except createHash (deterministic).
 */

import { createHash } from "node:crypto";

import { ok, err } from "./types.js";
import {
  INGESTION_CONTRACT_V1,
  PREDICATE_TYPE,
  SCHEMA_URL,
  STATEMENT_V1_TYPE,
} from "./schema.js";
import type {
  AuditBlock,
  AuditOutput,
  Counts,
  Envelope,
  PerWorkloadResult,
  Result,
  Sha256Hex,
  Thresholds,
  TokenAggregates,
  ValidationError,
  Warning,
  WorkloadFingerprint,
} from "./types.js";

// ════════════════════════════════════════════════════════════════════
// Frozen contract version (the SPEC version embedded in every audit)
// ════════════════════════════════════════════════════════════════════

export const ENGRAM_COUNTER_SPEC_VERSION = "0.1.0" as const;

// ════════════════════════════════════════════════════════════════════
// RFC 8785 JCS canonicalization — pure JS, zero deps
// ════════════════════════════════════════════════════════════════════

/**
 * Serialize a string per RFC 8785 §3.2.2.2 (JSON-required escapes only):
 *   \" \\ \b \f \n \r \t and \uXXXX for U+0000..U+001F.
 *
 * Surrogate handling (adversarial P0-1/P0-2 hardening):
 *   - Valid surrogate pairs (high + low) emitted as-is (UTF-16, transcoded
 *     to UTF-8 by Node's hash.update).
 *   - LONE surrogates (unpaired high or low) escaped as `\uXXXX` to match
 *     native JSON.stringify + Go/Java reference RFC 8785 implementations.
 *     Without this, lone surrogates would be silently replaced with U+FFFD
 *     during UTF-8 encoding, enabling SHA-256 collisions between distinct
 *     lone-surrogate inputs.
 *
 * All other characters (including non-ASCII Unicode) output as-is.
 */
function jcsString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) {
      out += '\\"';
    } else if (c === 0x5c) {
      out += "\\\\";
    } else if (c === 0x08) {
      out += "\\b";
    } else if (c === 0x0c) {
      out += "\\f";
    } else if (c === 0x0a) {
      out += "\\n";
    } else if (c === 0x0d) {
      out += "\\r";
    } else if (c === 0x09) {
      out += "\\t";
    } else if (c < 0x20) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate — check next char for valid low-surrogate pair
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Valid surrogate pair — reconstruct via charCode (type-safe under noUncheckedIndexedAccess)
        out += String.fromCharCode(c, next);
        i++; // skip low surrogate
      } else {
        // LONE high surrogate — escape per JSON.stringify / Go reference impl
        out += "\\u" + c.toString(16).padStart(4, "0");
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // LONE low surrogate (no preceding high) — escape per JSON.stringify
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out + '"';
}

/**
 * Serialize a number per RFC 8785 §3.2.2.3 (references ECMA-262 NumberToString).
 *
 * JavaScript's `String(n)` IS ECMA-262 NumberToString, so this just delegates,
 * with two safety checks:
 *   - Rejects non-finite (NaN, ±Infinity) — not valid in JSON anyway.
 *   - Rejects -0 to "-0" (JS String(-0) returns "0" naturally; explicit per RFC).
 */
function jcsNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`JCS canonicalization: non-finite number ${n}`);
  }
  // String(-0) === "0" in JS by default, so no special case needed; documented for clarity.
  return String(n);
}

/**
 * Recursive JCS serializer per RFC 8785.
 *
 * Object keys are sorted by UTF-16 code unit order (JavaScript's default
 * Array.sort comparator for strings — matches RFC 8785 §3.2.3).
 *
 * Throws on:
 *   - undefined (not representable in JSON)
 *   - functions (not representable in JSON)
 *   - non-finite numbers (NaN, ±Infinity)
 *   - circular references (TypeError from JSON.stringify-style; we detect via depth limit)
 */
function canonicalizeJcsValue(value: unknown, depth: number): string {
  if (depth > 64) {
    throw new Error("JCS canonicalization: depth limit (64) exceeded");
  }

  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";

  if (typeof value === "string") return jcsString(value);
  if (typeof value === "number") return jcsNumber(value);

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      items.push(canonicalizeJcsValue(item, depth + 1));
    }
    return "[" + items.join(",") + "]";
  }

  if (typeof value === "object") {
    // adversarial P0-3 + correctness C1 — reject non-plain-objects
    // (Date, Map, Set, Buffer, RegExp, class instances). Object.keys on these
    // returns [] (silent canonicalization to "{}" = data loss) or numeric
    // indices (Buffer treated as array of byte values) — both are attack
    // vectors that produce silent hash collisions across semantically
    // distinct inputs.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name =
        (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
      throw new Error(
        `JCS canonicalization: non-plain-object type rejected (${name})`,
      );
    }

    const obj = value as Record<string, unknown>;
    // Object.keys returns enumerable own properties; sort is UTF-16 code units per JS default.
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue; // RFC 8785: undefined values dropped (per JSON.stringify convention)
      parts.push(jcsString(key) + ":" + canonicalizeJcsValue(v, depth + 1));
    }
    return "{" + parts.join(",") + "}";
  }

  throw new Error(
    `JCS canonicalization: unsupported type ${typeof value} (value: ${String(value)})`,
  );
}

/**
 * Public JCS canonicalizer per RFC 8785.
 *
 * Returns the canonical JSON string of `value`. Output is deterministic:
 * two semantically-equivalent JSON values always produce IDENTICAL output
 * bytes. SHA-256 of this output is the audit's tamper-evident anchor.
 */
export function canonicalizeJcs(value: unknown): string {
  return canonicalizeJcsValue(value, 0);
}

// ════════════════════════════════════════════════════════════════════
// SHA-256 wrappers
// ════════════════════════════════════════════════════════════════════

/**
 * SHA-256 over a UTF-8 string. Returns `sha256:<64-hex>` Sha256Hex Brand.
 *
 * Hash-algorithm agility: the `sha256:` prefix allows future `sha3-256:`
 * or `blake3:` variants without breaking the v1 contract.
 */
export function sha256OverString(s: string): Sha256Hex {
  const hex = createHash("sha256").update(s, "utf8").digest("hex");
  return `sha256:${hex}` as Sha256Hex;
}

/**
 * SHA-256 over arbitrary bytes (Buffer / Uint8Array). Same prefix convention.
 */
export function sha256OverBuffer(b: Buffer | Uint8Array): Sha256Hex {
  const hex = createHash("sha256").update(b).digest("hex");
  return `sha256:${hex}` as Sha256Hex;
}

// ════════════════════════════════════════════════════════════════════
// Audit assembly — F6 envelope pattern (outer NOT hashed, inner IS hashed)
// ════════════════════════════════════════════════════════════════════

/**
 * Input to buildAuditOutput — everything the CLI computes BEFORE handing off
 * to hash assembly.
 */
export interface BuildAuditInput {
  counter_version: string; // CLI reads from package.json
  mode: "strict" | "dev";
  binary_sha256?: string; // present when mode === "strict"
  inputs: {
    baseline_file: string;
    baseline_sha256: string;
    active_file: string;
    active_sha256: string;
    bom_stripped: boolean;
  };
  counts: Counts;
  tokens: TokenAggregates;
  cost_usd: number | null;
  per_workload: Record<string, PerWorkloadResult>;
  fingerprint: WorkloadFingerprint;
  thresholds: Thresholds;
  warnings: Warning[];
}

/**
 * Assemble the INNER canonical audit block from parsed + computed inputs.
 *
 * The audit block is what gets JCS-canonicalized and SHA-256-hashed.
 * Outer envelope fields (computed_at, audit_id) are NOT in here.
 */
export function buildAuditBlock(input: BuildAuditInput): AuditBlock {
  const block: AuditBlock = {
    version: ENGRAM_COUNTER_SPEC_VERSION,
    counter_version: input.counter_version,
    mode: input.mode,
    methodology: "paired-run",
    inputs: input.inputs,
    counts: input.counts,
    tokens: input.tokens,
    cost_usd: input.cost_usd,
    per_workload: input.per_workload,
    fingerprint: input.fingerprint,
    thresholds: input.thresholds,
    warnings: input.warnings,
  };
  if (input.binary_sha256 !== undefined) {
    block.binary_sha256 = input.binary_sha256;
  }
  return block;
}

/**
 * Compute the audit_trail_hash by JCS-canonicalizing the audit block then
 * SHA-256 hashing the canonical bytes.
 *
 * Deterministic: same audit block → same hash, byte-for-byte. This is the
 * reproducibility imperative — two auditors running engram-counter on the
 * same logs at different times produce IDENTICAL audit_trail_hash.
 */
export function computeAuditTrailHash(audit: AuditBlock): Sha256Hex {
  const canonical = canonicalizeJcs(audit);
  return sha256OverString(canonical);
}

/**
 * Derive a short, content-addressed audit_id from the audit_trail_hash.
 *
 * Format: `ec_${12-hex}`. Content-addressed = same audit content always
 * produces same audit_id. Procurement-friendly: short enough to reference
 * in tickets, deterministic enough for reproducibility.
 *
 * NOT a UUID — UUIDs are non-deterministic and would break the
 * "same input → same output" trust contract that procurement requires.
 */
export function deriveAuditId(audit_trail_hash: Sha256Hex): string {
  // correctness C4 — runtime format guard (Brand type protects at
  // compile-time but deserialization paths can bypass it via `as Sha256Hex`).
  if (!/^sha256:[0-9a-f]{64}$/.test(audit_trail_hash)) {
    throw new Error(
      `deriveAuditId: malformed audit_trail_hash (expected sha256:<64-hex>): ${audit_trail_hash}`,
    );
  }
  // audit_trail_hash format: "sha256:<64-hex>" — strip prefix, take first 12 chars
  const hex = audit_trail_hash.slice("sha256:".length, "sha256:".length + 12);
  return `ec_${hex}`;
}

/**
 * Assemble the outer envelope. computed_at is wall-clock UTC (presentation
 * only — NOT in audit_trail_hash per F6).
 */
export function buildEnvelope(
  audit_trail_hash: Sha256Hex,
  options?: {
    computed_at?: string;
    audit_id?: string;
    reproducible_mode?: boolean;
  },
): Envelope {
  const computed_at = options?.computed_at ?? new Date().toISOString();
  const audit_id = options?.audit_id ?? deriveAuditId(audit_trail_hash);
  const reproducible_mode = options?.reproducible_mode ?? false;

  return {
    computed_at,
    audit_id,
    reproducible_mode,
    ingestion_contract: INGESTION_CONTRACT_V1,
    _type: STATEMENT_V1_TYPE,
    predicateType: PREDICATE_TYPE,
    schema_url: SCHEMA_URL,
  };
}

/**
 * High-level entry: build complete AuditOutput from BuildAuditInput.
 *
 * This is what the CLI calls. Steps:
 *   1. Assemble inner audit block from input
 *   2. JCS-canonicalize + SHA-256 → audit_trail_hash
 *   3. Build outer envelope (computed_at injected here)
 *   4. Compose AuditOutput { envelope, audit_trail_hash, audit }
 *
 * Reproducibility property: for any two invocations with identical
 * BuildAuditInput (and overridden computed_at to same value),
 * `JSON.stringify(buildAuditOutput(input))` produces IDENTICAL bytes.
 */
export function buildAuditOutput(
  input: BuildAuditInput,
  options?: {
    computed_at?: string;
    audit_id?: string;
    reproducible_mode?: boolean;
  },
): AuditOutput {
  const audit = buildAuditBlock(input);
  const audit_trail_hash = computeAuditTrailHash(audit);
  const envelope = buildEnvelope(audit_trail_hash, options);
  return { envelope, audit_trail_hash, audit };
}

/**
 * Re-verify an existing AuditOutput by re-computing the audit_trail_hash
 * from its audit block and comparing.
 *
 * This is what an auditor calls when validating a submitted attestation:
 * "compute hash over the audit block, compare to the claimed audit_trail_hash."
 *
 * Returns Ok(true) on match, Err with details on mismatch.
 */
export function verifyAuditTrailHash(
  output: AuditOutput,
): Result<true, ValidationError> {
  // correctness C3 — format guard at runtime boundary.
  if (!/^sha256:[0-9a-f]{64}$/.test(output.audit_trail_hash)) {
    return err({
      code: "constraint_violation",
      message: `audit_trail_hash format invalid (expected sha256:<64-hex>): ${output.audit_trail_hash}`,
      path: "$.audit_trail_hash",
    });
  }

  // Recompute + compare — primary tamper detection.
  const recomputed = computeAuditTrailHash(output.audit);
  if (recomputed !== output.audit_trail_hash) {
    return err({
      code: "constraint_violation",
      message: `audit_trail_hash mismatch — recomputed ${recomputed} but output claims ${output.audit_trail_hash}`,
      path: "$.audit_trail_hash",
    });
  }

  // adversarial P1-4 + envelope-linkage P0-1 — envelope linkage check.
  //
  // The `ec_<12hex>` audit_id prefix is RESERVED for content-derived ids. Any
  // audit_id starting with this prefix MUST equal deriveAuditId(audit_trail_hash)
  // regardless of reproducible_mode. This defeats the "forge an ec_-prefixed
  // audit_id via --audit-id while reproducible_mode=true" attack discovered in
  // adversarial review.
  //
  // User-provided labels (audit_id NOT starting with `ec_`) are not derived —
  // no linkage check, just opaque references for procurement bookkeeping.
  if (output.envelope.audit_id.startsWith("ec_")) {
    // Safe to cast: format regex above guarantees Sha256Hex shape.
    const expected_id = deriveAuditId(output.audit_trail_hash as Sha256Hex);
    if (output.envelope.audit_id !== expected_id) {
      return err({
        code: "constraint_violation",
        message: `envelope.audit_id (${output.envelope.audit_id}) uses reserved 'ec_<12hex>' format but does not match deriveAuditId(audit_trail_hash) = ${expected_id}; envelope-to-audit linkage broken`,
        path: "$.envelope.audit_id",
      });
    }
  }

  return ok(true);
}
