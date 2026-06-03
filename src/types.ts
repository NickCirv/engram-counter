/**
 * engram-counter v0.1.0 type definitions.
 * Maps directly to SPEC v0.1.5 schema (internal spec, not shipped).
 *
 * Architecture foundations (post-comprehensive-audit):
 *   - Result<T, E> discriminated union for fallible operations across modules
 *   - Brand types preventing primitive-confusion bugs at scale
 *   - Logger interface for injected logging (downstream consumers capture warnings)
 *   - Structured Warning type with frozen WarningCode enum
 *   - In-toto Statement v1 envelope alignment (_type + predicateType + schema_url)
 */

// ════════════════════════════════════════════════════════════════════
// Result<T, E> — Discriminated union for fallible operations
// ════════════════════════════════════════════════════════════════════

/**
 * Result type for operations that may fail.
 * Used across parser/hash/cli pipeline to thread errors without throwing
 * across module seams (which would force cli.ts into a megacatch).
 *
 * Convention: ok=true → value present; ok=false → error present.
 * Never both, never neither. TypeScript discriminates on `ok`.
 */
export type Result<T, E = ValidationError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Construct a successful Result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Construct a failed Result. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Map success value through fn, preserving error. */
export function mapResult<T, U, E>(
  r: Result<T, E>,
  fn: (t: T) => U,
): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Chain Result-returning operations (monadic bind). */
export function flatMapResult<T, U, E>(
  r: Result<T, E>,
  fn: (t: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

// ════════════════════════════════════════════════════════════════════
// Brand types — nominal typing for primitive-confusion prevention
// ════════════════════════════════════════════════════════════════════

/**
 * Brand helper — adds a phantom type tag to a primitive so the type system
 * distinguishes nominally-different uses of the same primitive (e.g., string).
 *
 * Branded values are subtypes — they ARE assignable to the underlying primitive
 * (so existing string-typed APIs continue to accept them) but NOT vice versa
 * (so functions that expect QueryId cannot be silently called with arbitrary strings).
 *
 * Counter.ts stays primitive-typed for backward compatibility; parser.ts
 * onwards produces and consumes Brand types.
 */
export type Brand<T, B extends string> = T & {
  readonly __brand: B;
};

/** Stable identifier correlating baseline ↔ active log entries. */
export type QueryId = Brand<string, "QueryId">;

/** SHA-256 hex digest, prefixed `sha256:` per SPEC §Hash-algorithm agility. */
export type Sha256Hex = Brand<string, "Sha256Hex">;

/** Integer basis points (0–10000 = 0.00%–100.00%, may be negative for regression). */
export type BasisPoints = Brand<number, "BasisPoints">;

// ════════════════════════════════════════════════════════════════════
// Validation — typed errors + safe constructors for Brand types
// ════════════════════════════════════════════════════════════════════

/** Structured validation error — replaces ad-hoc strings across the pipeline. */
export interface ValidationError {
  readonly code: ValidationErrorCode;
  readonly message: string;
  readonly path?: string; // JSON pointer to the offending field
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Frozen enum of validation error codes — downstream consumers can categorize programmatically. */
export type ValidationErrorCode =
  | "invalid_type"
  | "out_of_range"
  | "schema_violation"
  | "required_field_missing"
  | "unknown_field"
  | "format_violation"
  | "constraint_violation";

/** Safe constructor: validates string then brands as QueryId. */
export function asQueryId(s: string): Result<QueryId, ValidationError> {
  if (typeof s !== "string" || s.length === 0) {
    return err({
      code: "invalid_type",
      message: "QueryId must be a non-empty string",
      context: { received: typeof s, length: typeof s === "string" ? s.length : null },
    });
  }
  // Case-sensitive, no trimming per SPEC v0.1.3 §C4.
  return ok(s as QueryId);
}

/** Safe constructor: validates sha256:<hex> shape. */
export function asSha256Hex(s: string): Result<Sha256Hex, ValidationError> {
  if (!/^sha256:[0-9a-f]{64}$/.test(s)) {
    return err({
      code: "format_violation",
      message: "Sha256Hex must match /^sha256:[0-9a-f]{64}$/",
      context: { received_prefix: s.slice(0, 20) },
    });
  }
  return ok(s as Sha256Hex);
}

/** Safe constructor: validates integer in [-10000, ∞) — negative allowed for engram regression. */
export function asBasisPoints(n: number): Result<BasisPoints, ValidationError> {
  if (!Number.isInteger(n)) {
    return err({
      code: "invalid_type",
      message: "BasisPoints must be an integer",
      context: { received: n },
    });
  }
  return ok(n as BasisPoints);
}

// ════════════════════════════════════════════════════════════════════
// Logger interface — injected, never console.error directly
// ════════════════════════════════════════════════════════════════════

/** Structured log context — downstream consumers can index/search on these fields. */
export type LogContext = Readonly<Record<string, unknown>>;

/**
 * Logger interface. Modules accept Logger via constructor/parameter injection,
 * never reach for `console.error` directly. Downstream consumers provide a Logger that
 * captures messages programmatically for audit-event timelines.
 */
export interface Logger {
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
}

/** No-op Logger — for tests and contexts where logging is suppressed. */
export class NullLogger implements Logger {
  warn(): void {}
  info(): void {}
  debug(): void {}
}

// ════════════════════════════════════════════════════════════════════
// Structured Warning — replaces opaque string[] warnings
// ════════════════════════════════════════════════════════════════════

/**
 * Frozen enum of warning codes — downstream consumers can categorize + filter on these.
 * Adding a new code is a v1.x backward-compatible change; removing a code is breaking.
 */
export type WarningCode =
  // Mismatch tolerance (SPEC v0.1.3 F8)
  | "low_mismatch_within_tolerance"
  | "partial_audit_warning"
  | "very_high_mismatch_rate"
  // Fingerprint (SPEC v0.1.3 F1)
  | "workload_field_absent"
  | "fingerprint_set_mismatch"
  | "fingerprint_count_skew"
  // Parser (SPEC v0.1.3 F10 + S2)
  | "bom_stripped"
  | "malformed_jsonl_line"
  | "parser_limit_exceeded"
  | "unicode_line_terminator_normalized"
  // Data hygiene (SPEC v0.1.4 C5/A6)
  | "negative_token_clamped"
  | "duplicate_query_id"
  // Sample size (SPEC v0.1.3 P1 N7)
  | "sample_size_below_recommended_minimum";

/** Structured warning — replaces opaque `string[]` per architect P0 finding. */
export interface Warning {
  readonly code: WarningCode;
  readonly message: string;
  readonly context?: LogContext;
}

/** A single LLM call event in JSONL log format. */
export interface LogEntry {
  query_id: string;
  timestamp: string; // ISO-8601 UTC
  tokens_sent: number;
  tokens_received: number;
  workload?: string;
  model?: string;
  provider?: string;
  dev_id?: string;
  metadata?: Record<string, unknown>;
  /**
   * Tokens served from Anthropic prompt cache (charged at 0.1× input rate).
   * Optional — v0.1.x JSONL files have no cache fields; v0.2 treats absent as 0.
   * If present, must be a non-negative integer ≤ Number.MAX_SAFE_INTEGER.
   * Required for cost_saved_pct accuracy when caching is active.
   */
  cache_read_tokens?: number;
  /**
   * Tokens written to Anthropic prompt cache (charged at 1.25× input rate
   * for the default 5-minute TTL). Optional — same back-compat rules as
   * cache_read_tokens above. Required for FinOps-correct cost calc.
   */
  cache_creation_tokens?: number;
}

/** A paired query: baseline + active log entries with matching query_id. */
export interface MatchedQuery {
  query_id: string;
  workload: string | undefined;
  baseline: LogEntry;
  active: LogEntry;
}

/** Per-query diff result. */
export interface QueryDiff {
  query_id: string;
  workload: string | undefined;
  baseline_total: number; // tokens_sent + tokens_received from baseline
  active_total: number; // tokens_sent + tokens_received from active
  saved_total: number; // baseline_total - active_total (may be negative)
  saved_pct: number; // (saved_total / baseline_total) * 100, 2-dp via integer math
}

/** Aggregate token counts across a set of matched queries. */
export interface TokenAggregates {
  baseline_sent_total: number;
  active_sent_total: number;
  saved_sent: number;
  baseline_received_total: number;
  active_received_total: number;
  saved_received: number;
  baseline_total: number;
  active_total: number;
  saved_total: number;
  saved_pct: number; // 2-dp via F5/F9 BigInt math
}

/** Per-workload aggregate breakdown. */
export interface PerWorkloadResult {
  matched_queries: number;
  baseline_total: number;
  active_total: number;
  saved_total: number;
  saved_pct: number;
}

/**
 * v0.2 — Aggregate cost (USD) across matched queries.
 *
 * Mirrors TokenAggregates but in dollars, with cache-aware pricing.
 * Pure-additive: v0.1.x AuditBlock keeps its naive cost_usd; this richer
 * structure is what v0.2 attaches when JSONL rows have cache fields.
 *
 * Precision: USD float rounded to 4 decimal places at boundary (covers all
 * realistic procurement scenarios without float-drift hash instability).
 * Cents-precision (2dp) is sufficient for marketing display; 4dp leaves
 * headroom for fractional-cent rates without losing information.
 */
export interface CostAggregates {
  /**
   * Pricing provenance — the model SKU whose rates were applied. Procurement
   * auditors need this to reproduce the cost figures. Defaults to the
   * DEFAULT_MODEL constant when no per-audit model is specified.
   */
  model: string;
  /**
   * Pricing snapshot identifier (e.g. "anthropic-2026-05"). Frozen in
   * pricing.ts. An auditor pairs this with the open-source pricing table to
   * recompute every USD figure below from the token counts — that's what
   * makes the cost claim independently verifiable.
   */
  pricing_version: string;
  /** Sum of cost across all baseline rows, USD. */
  baseline_cost_usd: number;
  /** Sum of cost across all active rows, USD. */
  active_cost_usd: number;
  /** baseline - active. Negative = cost increase (regression). */
  saved_cost_usd: number;
  /** (saved / baseline) × 100, 2-dp. Zero if baseline is zero. */
  saved_pct: number;
  /** Total cache_read_tokens across BOTH baseline + active rows. */
  cache_read_total: number;
  /** Total cache_creation_tokens across BOTH baseline + active rows. */
  cache_creation_total: number;
}

/** Severity tier for query mismatch tolerance per v0.1.3 F8 (three-tier exit codes). */
export type MismatchSeverity = "ok" | "warn" | "high";

/** Thresholds per v0.1.3 F13 (with documented rationales in SPEC). */
export interface Thresholds {
  workload_absent_fail_closed: number; // default 0.01 (1%)
  mismatch_warn: number; // default 0.10 (10%)
  mismatch_high: number; // default 0.50 (50%)
  count_skew_warn: number; // default 0.50 (50%)
}

/** Default thresholds matching SPEC v0.1.3 F13. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  workload_absent_fail_closed: 0.01,
  mismatch_warn: 0.1,
  mismatch_high: 0.5,
  count_skew_warn: 0.5,
};

/** Workload fingerprint per v0.1.3 F1 (redesigned to defeat S1 bypass). */
export interface WorkloadFingerprint {
  baseline_workloads: string; // sha256:... over sorted (query_id + ':' + normalized_workload)
  active_workloads: string;
  fingerprint_match: boolean | null;
  fingerprint_reason:
    | "ok"
    | "workload_field_absent"
    | "set_mismatch"
    | "count_skew";
  count_per_workload: Record<string, { baseline: number; active: number }>;
}

/** Counts of entries + matched/unmatched. */
export interface Counts {
  baseline_entries: number;
  active_entries: number;
  matched_queries: number;
  baseline_only_queries: number;
  active_only_queries: number;
}

/** Inner canonical audit block — JCS-hashed per v0.1.3 F6 envelope pattern. */
export interface AuditBlock {
  version: string; // engram-counter SPEC version (e.g., '0.1.0')
  counter_version: string; // derived from package.json at runtime per F2
  binary_sha256?: string; // present only when mode === 'strict' (default per F7)
  mode: "strict" | "dev"; // F7 — 'strict' is default
  methodology: "paired-run";
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
  warnings: Warning[]; // v0.1.5 — structured (was string[] in v0.1.4) per architect P0
  /**
   * v0.2 — Cache-aware FinOps cost aggregate. OPTIONAL for back-compat:
   * absent for v0.1.x JSONL inputs (no cache fields), present for v0.2+
   * JSONL inputs that include cache_read_tokens / cache_creation_tokens.
   *
   * Hash semantics: JCS canonicalizer omits absent keys, so v0.1.x audits
   * produce the SAME hash whether computed by v0.1.x or v0.2+ binary.
   * v0.2 audits with the cost block produce a DIFFERENT hash (by design —
   * the cost data is part of the attestation surface).
   */
  cost?: CostAggregates;
}

/** Outer envelope — presentation metadata, NOT hashed (v0.1.3 F6 + v0.1.5 in-toto alignment). */
export interface Envelope {
  computed_at: string; // ISO-8601 UTC
  audit_id: string; // UUID-v4 or --audit-id value
  reproducible_mode: boolean; // true ONLY when --audit-id explicitly provided
  ingestion_contract: "v1"; // F11 — frozen for downstream ingestion compat
  // v0.1.5 in-toto Statement v1 alignment.
  //
  // _type is the in-toto Statement v1 URI (resolvable to the spec at https://in-toto.io/Statement/v1).
  //
  // predicateType is a URI IDENTIFIER (like an XML namespace URI) per in-toto spec — does NOT need to
  // resolve as HTTP-fetchable. cosign verify-blob / slsa-verifier match on the URI literal, they do
  // not dereference. https://cirvgreen.com/engram-counter/Attestation/v1 is the canonical identifier.
  //
  // schema_url IS intended to be fetchable (JSON Schema $id resolvable). To avoid 404 on day 1, the
  // canonical artifact is hosted via GitHub raw URL until cirvgreen.com/engram-counter/schemas/ is
  // deployed. This is the URL downstream consumers should fetch to verify ingestion contract.
  _type: "https://in-toto.io/Statement/v1";
  predicateType: "https://cirvgreen.com/engram-counter/Attestation/v1";
  schema_url: "https://raw.githubusercontent.com/NickCirv/engram-counter/main/schemas/ingestion-contract-v1.schema.json";
}

/** Full output JSON structure per v0.1.3 F6 envelope pattern. */
export interface AuditOutput {
  envelope: Envelope;
  audit_trail_hash: string; // sha256:<hex>
  audit: AuditBlock;
}
