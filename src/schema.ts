/**
 * Ingestion Contract v1 — URLs, types, structural validator.
 *
 * The frozen JSON Schema at schemas/ingestion-contract-v1.schema.json is the
 * authoritative contract. This module exports the URLs that must appear in
 * envelopes + a hand-rolled structural validator (zero runtime deps) that
 * checks required-fields + types. Full JSON Schema validation can be added
 * via ajv in V0.2 if needed.
 *
 * Per architecture lock (P0 from comprehensive audit).
 */

import { err, ok } from "./types.js";
import type {
  AuditOutput,
  Result,
  ValidationError,
  Warning,
  WarningCode,
} from "./types.js";

// ════════════════════════════════════════════════════════════════════
// Frozen URIs — must match schemas/ingestion-contract-v1.schema.json
// ════════════════════════════════════════════════════════════════════

export const INGESTION_CONTRACT_V1 = "v1" as const;

export const STATEMENT_V1_TYPE =
  "https://in-toto.io/Statement/v1" as const;

export const PREDICATE_TYPE =
  "https://cirvgreen.com/engram-counter/Attestation/v1" as const;

/**
 * Canonical SCHEMA_URL points at GitHub raw (resolvable HTTP today). Once
 * cirvgreen.com/engram-counter/schemas/* is deployed, this URL will
 * redirect; until then GitHub raw is the load-bearing URL.
 */
export const SCHEMA_URL =
  "https://raw.githubusercontent.com/NickCirv/engram-counter/main/schemas/ingestion-contract-v1.schema.json" as const;

/** Valid Warning codes — kept in sync with types.ts WarningCode + JSON Schema. */
const VALID_WARNING_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>([
  "low_mismatch_within_tolerance",
  "partial_audit_warning",
  "very_high_mismatch_rate",
  "workload_field_absent",
  "fingerprint_set_mismatch",
  "fingerprint_count_skew",
  "bom_stripped",
  "malformed_jsonl_line",
  "parser_limit_exceeded",
  "unicode_line_terminator_normalized",
  "negative_token_clamped",
  "duplicate_query_id",
  "sample_size_below_recommended_minimum",
]);

// ════════════════════════════════════════════════════════════════════
// Hand-rolled structural validator — checks required fields + types
// ════════════════════════════════════════════════════════════════════

/** Type guard: value is a non-null object (not array, not function). */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): Result<never, ValidationError> {
  return err({
    code: "schema_violation",
    message,
    path,
  });
}

function failMissing(
  path: string,
  field: string,
): Result<never, ValidationError> {
  return err({
    code: "required_field_missing",
    message: `Required field missing: ${field}`,
    path: `${path}.${field}`,
  });
}

function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && /^sha256:[0-9a-f]{64}$/.test(s);
}

/**
 * v0.1.5 hardening (adversarial review P0): the hand-rolled validator was
 * materially weaker than the JSON Schema. These helpers close that gap.
 */

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isNumberInRange01(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function isBoolOrNull(v: unknown): v is boolean | null {
  return typeof v === "boolean" || v === null;
}

/** Reject unknown top-level keys (additionalProperties: false enforcement). */
function rejectExtraKeys(
  obj: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
): Result<true, ValidationError> {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      return err({
        code: "unknown_field",
        message: `Unknown field "${key}" (additionalProperties: false)`,
        path: `${path}.${key}`,
      });
    }
    // Defend against prototype pollution attempts
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return err({
        code: "schema_violation",
        message: `Prototype-polluting key "${key}" rejected`,
        path: `${path}.${key}`,
      });
    }
  }
  return ok(true);
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "computed_at",
  "audit_id",
  "reproducible_mode",
  "ingestion_contract",
  "_type",
  "predicateType",
  "schema_url",
]);

const AUDIT_KEYS: ReadonlySet<string> = new Set([
  "version",
  "counter_version",
  "binary_sha256",
  "mode",
  "methodology",
  "inputs",
  "counts",
  "tokens",
  "cost_usd",
  "per_workload",
  "fingerprint",
  "thresholds",
  "warnings",
]);

const INPUTS_KEYS: ReadonlySet<string> = new Set([
  "baseline_file",
  "baseline_sha256",
  "active_file",
  "active_sha256",
  "bom_stripped",
]);

const COUNTS_KEYS: ReadonlySet<string> = new Set([
  "baseline_entries",
  "active_entries",
  "matched_queries",
  "baseline_only_queries",
  "active_only_queries",
]);

const FINGERPRINT_KEYS: ReadonlySet<string> = new Set([
  "baseline_workloads",
  "active_workloads",
  "fingerprint_match",
  "fingerprint_reason",
  "count_per_workload",
]);

const THRESHOLDS_KEYS: ReadonlySet<string> = new Set([
  "workload_absent_fail_closed",
  "mismatch_warn",
  "mismatch_high",
  "count_skew_warn",
]);

const WARNING_KEYS: ReadonlySet<string> = new Set(["code", "message", "context"]);

const ISO8601_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function validateWarning(
  w: unknown,
  path: string,
): Result<Warning, ValidationError> {
  if (!isObj(w)) return fail(path, "Warning must be an object");
  if (typeof w["code"] !== "string")
    return failMissing(path, "code");
  if (typeof w["message"] !== "string")
    return failMissing(path, "message");
  if (!VALID_WARNING_CODES.has(w["code"] as WarningCode)) {
    return err({
      code: "constraint_violation",
      message: `Unknown warning code: ${w["code"]}`,
      path: `${path}.code`,
      context: { received: w["code"] },
    });
  }
  return ok(w as unknown as Warning);
}

/**
 * Validate structural conformance to Ingestion Contract v1.
 *
 * Returns Ok(AuditOutput) on success, Err(ValidationError) with JSON-pointer-style
 * path indicating the offending field.
 *
 * This is a HAND-ROLLED validator with zero runtime deps. Validates structure
 * (required fields, primitive types, enums) but does NOT replace a full JSON
 * Schema validator (ajv) — pattern constraints, conditional schemas, $ref
 * recursion are not exhaustive. For production-grade verification, downstream
 * consumers should additionally run `ajv` against schemas/ingestion-contract-v1.schema.json.
 */
export function validateIngestionV1(
  input: unknown,
): Result<AuditOutput, ValidationError> {
  if (!isObj(input)) return fail("$", "Root must be an object");

  // Top-level: only envelope, audit_trail_hash, audit allowed
  const rootExtra = rejectExtraKeys(
    input,
    new Set(["envelope", "audit_trail_hash", "audit"]),
    "$",
  );
  if (!rootExtra.ok) return rootExtra;

  // ─── Envelope ───
  const envelope = input["envelope"];
  if (!isObj(envelope)) return failMissing("$", "envelope");

  for (const field of ENVELOPE_KEYS) {
    if (!(field in envelope)) return failMissing("$.envelope", field);
  }

  const envExtra = rejectExtraKeys(envelope, ENVELOPE_KEYS, "$.envelope");
  if (!envExtra.ok) return envExtra;

  // computed_at — ISO-8601 UTC pattern, not just any string
  if (typeof envelope["computed_at"] !== "string" || !ISO8601_UTC.test(envelope["computed_at"]))
    return fail(
      "$.envelope.computed_at",
      "computed_at must match ISO-8601 UTC pattern /^\\d{4}-\\d{2}-\\d{2}T...Z$/",
    );
  if (typeof envelope["audit_id"] !== "string" || envelope["audit_id"].length === 0)
    return fail("$.envelope.audit_id", "audit_id must be non-empty string");
  if (typeof envelope["reproducible_mode"] !== "boolean")
    return fail("$.envelope.reproducible_mode", "reproducible_mode must be boolean");
  if (envelope["ingestion_contract"] !== "v1")
    return fail(
      "$.envelope.ingestion_contract",
      `ingestion_contract must be "v1"; got ${JSON.stringify(envelope["ingestion_contract"])}`,
    );
  if (envelope["_type"] !== STATEMENT_V1_TYPE)
    return fail("$.envelope._type", `_type must be ${STATEMENT_V1_TYPE}`);
  if (envelope["predicateType"] !== PREDICATE_TYPE)
    return fail("$.envelope.predicateType", `predicateType must be ${PREDICATE_TYPE}`);
  // schema_url MUST equal SCHEMA_URL constant (v0.1.5 hardening — was only typeof string before)
  if (envelope["schema_url"] !== SCHEMA_URL)
    return fail(
      "$.envelope.schema_url",
      `schema_url must be ${SCHEMA_URL} (received: ${JSON.stringify(envelope["schema_url"])})`,
    );

  // ─── audit_trail_hash ───
  if (!isSha256Hex(input["audit_trail_hash"]))
    return fail(
      "$.audit_trail_hash",
      "audit_trail_hash must match /^sha256:[0-9a-f]{64}$/",
    );

  // ─── Audit block ───
  const audit = input["audit"];
  if (!isObj(audit)) return failMissing("$", "audit");

  for (const field of AUDIT_KEYS) {
    // binary_sha256 is conditionally required (only when mode === "strict")
    if (field === "binary_sha256") continue;
    if (!(field in audit)) return failMissing("$.audit", field);
  }

  const auditExtra = rejectExtraKeys(audit, AUDIT_KEYS, "$.audit");
  if (!auditExtra.ok) return auditExtra;

  if (typeof audit["version"] !== "string")
    return fail("$.audit.version", "version must be string");
  if (typeof audit["counter_version"] !== "string")
    return fail("$.audit.counter_version", "counter_version must be string");
  if (audit["mode"] !== "strict" && audit["mode"] !== "dev")
    return fail(
      "$.audit.mode",
      `mode must be "strict" or "dev"; got ${JSON.stringify(audit["mode"])}`,
    );
  if (audit["methodology"] !== "paired-run")
    return fail("$.audit.methodology", 'methodology must be "paired-run"');

  if (audit["mode"] === "strict" && !isSha256Hex(audit["binary_sha256"]))
    return fail(
      "$.audit.binary_sha256",
      "binary_sha256 required (sha256:<hex>) when mode === 'strict'",
    );
  if (audit["mode"] === "dev" && "binary_sha256" in audit && !isSha256Hex(audit["binary_sha256"]))
    return fail(
      "$.audit.binary_sha256",
      "if binary_sha256 is present (even in dev mode), it must match sha256:<hex>",
    );

  // ─── inputs ───
  const inputs = audit["inputs"];
  if (!isObj(inputs)) return fail("$.audit.inputs", "inputs must be object");
  for (const field of INPUTS_KEYS) {
    if (!(field in inputs)) return failMissing("$.audit.inputs", field);
  }
  const inputsExtra = rejectExtraKeys(inputs, INPUTS_KEYS, "$.audit.inputs");
  if (!inputsExtra.ok) return inputsExtra;
  if (typeof inputs["baseline_file"] !== "string")
    return fail("$.audit.inputs.baseline_file", "must be string");
  if (typeof inputs["active_file"] !== "string")
    return fail("$.audit.inputs.active_file", "must be string");
  if (!isSha256Hex(inputs["baseline_sha256"]))
    return fail("$.audit.inputs.baseline_sha256", "must match sha256:<hex>");
  if (!isSha256Hex(inputs["active_sha256"]))
    return fail("$.audit.inputs.active_sha256", "must match sha256:<hex>");
  if (typeof inputs["bom_stripped"] !== "boolean")
    return fail("$.audit.inputs.bom_stripped", "must be boolean");

  // ─── counts (must be non-negative integers) ───
  const counts = audit["counts"];
  if (!isObj(counts)) return fail("$.audit.counts", "counts must be object");
  for (const field of COUNTS_KEYS) {
    if (!(field in counts)) return failMissing("$.audit.counts", field);
    if (!isNonNegativeInt(counts[field]))
      return fail(`$.audit.counts.${field}`, `must be a non-negative integer`);
  }
  const countsExtra = rejectExtraKeys(counts, COUNTS_KEYS, "$.audit.counts");
  if (!countsExtra.ok) return countsExtra;

  // ─── tokens (must be integers; saved_pct is number) ───
  const tokens = audit["tokens"];
  if (!isObj(tokens)) return fail("$.audit.tokens", "tokens must be object");
  for (const intField of [
    "baseline_sent_total",
    "active_sent_total",
    "saved_sent",
    "baseline_received_total",
    "active_received_total",
    "saved_received",
    "baseline_total",
    "active_total",
    "saved_total",
  ]) {
    if (!isInt(tokens[intField]))
      return fail(`$.audit.tokens.${intField}`, "must be an integer");
  }
  if (typeof tokens["saved_pct"] !== "number" || !Number.isFinite(tokens["saved_pct"]))
    return fail("$.audit.tokens.saved_pct", "must be a finite number");

  // ─── cost_usd (number | null) ───
  if (!isNumberOrNull(audit["cost_usd"]))
    return fail("$.audit.cost_usd", "must be number or null");

  // ─── per_workload (object map; values structurally validated) ───
  const perWorkload = audit["per_workload"];
  if (!isObj(perWorkload))
    return fail("$.audit.per_workload", "must be an object");

  // ─── fingerprint ───
  const fingerprint = audit["fingerprint"];
  if (!isObj(fingerprint))
    return fail("$.audit.fingerprint", "fingerprint must be object");
  for (const field of FINGERPRINT_KEYS) {
    if (!(field in fingerprint))
      return failMissing("$.audit.fingerprint", field);
  }
  const fpExtra = rejectExtraKeys(fingerprint, FINGERPRINT_KEYS, "$.audit.fingerprint");
  if (!fpExtra.ok) return fpExtra;
  if (!isSha256Hex(fingerprint["baseline_workloads"]))
    return fail("$.audit.fingerprint.baseline_workloads", "must be sha256:<hex>");
  if (!isSha256Hex(fingerprint["active_workloads"]))
    return fail("$.audit.fingerprint.active_workloads", "must be sha256:<hex>");
  if (!isBoolOrNull(fingerprint["fingerprint_match"]))
    return fail("$.audit.fingerprint.fingerprint_match", "must be boolean or null");
  const validReasons = new Set([
    "ok",
    "workload_field_absent",
    "set_mismatch",
    "count_skew",
  ]);
  if (typeof fingerprint["fingerprint_reason"] !== "string" || !validReasons.has(fingerprint["fingerprint_reason"]))
    return fail(
      "$.audit.fingerprint.fingerprint_reason",
      "must be one of: ok, workload_field_absent, set_mismatch, count_skew",
    );

  // ─── thresholds (numbers in [0, 1]) ───
  const thresholds = audit["thresholds"];
  if (!isObj(thresholds))
    return fail("$.audit.thresholds", "thresholds must be object");
  for (const field of THRESHOLDS_KEYS) {
    if (!(field in thresholds)) return failMissing("$.audit.thresholds", field);
    if (!isNumberInRange01(thresholds[field]))
      return fail(`$.audit.thresholds.${field}`, "must be number in [0, 1]");
  }
  const thresholdsExtra = rejectExtraKeys(thresholds, THRESHOLDS_KEYS, "$.audit.thresholds");
  if (!thresholdsExtra.ok) return thresholdsExtra;

  // ─── warnings (validate each element) ───
  const warnings = audit["warnings"];
  if (!Array.isArray(warnings))
    return fail("$.audit.warnings", "warnings must be an array");
  for (let i = 0; i < warnings.length; i++) {
    const w = warnings[i];
    if (!isObj(w))
      return fail(`$.audit.warnings[${i}]`, "Warning must be an object");
    const wExtra = rejectExtraKeys(
      w,
      WARNING_KEYS,
      `$.audit.warnings[${i}]`,
    );
    if (!wExtra.ok) return wExtra;
    const wResult = validateWarning(w, `$.audit.warnings[${i}]`);
    if (!wResult.ok) return wResult;
  }

  // Passed structural validation
  return ok(input as unknown as AuditOutput);
}
