/**
 * engram-counter v0.1.0 — JSONL parser + workload fingerprint.
 *
 * Implements SPEC v0.1.3 §S2 (parser hard limits) + §F10 (Unicode line terminator
 * normalization) + §F1 redesigned workload fingerprint + §C5 (negative token clamping).
 *
 * Hardened per adversarial security review (adversarial 0.78 / code 0.83 / sec 0.88):
 *   - P0-1A — fingerprint tuples canonical via JSON.stringify (closes :/| collision)
 *   - P0-2A — Number.MAX_SAFE_INTEGER guard on tokens (closes 2^53 precision-loss smuggle)
 *   - P0-3A — dual SHA: file_sha256 (raw bytes) + normalized_content_sha256
 *   - P0-4A — collect ALL count_skews before return (no early-bail hiding multiples)
 *   - P0-2C — surface count_per_workload diagnostics even on set_mismatch path
 *   - P0-3C — const-extraction for type narrowing through assignment
 *   - Sec P1-C — reorder integer check BEFORE negative clamp (preserve non-int signal)
 *   - P1-d — Unicode NFC normalize before lowercase (closes composed/decomposed bypass)
 *
 * Zero runtime deps (uses node:crypto + node:fs stdlib only).
 *
 * Public surface:
 *   - normalizeLineTerminators: 7-sequence pre-processor
 *   - stripBom: UTF-8 BOM detection + multi-strip
 *   - walkValidate: recursive hard-limit walker
 *   - parseJsonlString / parseJsonlFile: main ingest
 *   - computeWorkloadFingerprint: SPEC F1 cross-check
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  err,
  NullLogger,
  ok,
} from "./types.js";
import type {
  LogEntry,
  Logger,
  Result,
  Sha256Hex,
  ValidationError,
  Warning,
  WarningCode,
} from "./types.js";

// ════════════════════════════════════════════════════════════════════
// Hard limits + defaults
// ════════════════════════════════════════════════════════════════════

/** Parser hard limits per SPEC v0.1.3 S2 + adversarial review extensions. */
export interface ParserLimits {
  readonly maxDepth: number;
  readonly maxFieldsPerObject: number;
  readonly maxStringLength: number;
  readonly maxLineLength: number;
  readonly maxLinesPerFile: number;
}

export const DEFAULT_PARSER_LIMITS: ParserLimits = {
  maxDepth: 8,
  maxFieldsPerObject: 64,
  maxStringLength: 4096,
  maxLineLength: 1_000_000, // 1 MB per line
  maxLinesPerFile: 10_000_000, // 10M lines per file
};

/** Result of parsing a JSONL file or string. */
export interface ParseResult {
  entries: LogEntry[];
  warnings: Warning[];
  /** SHA-256 of RAW bytes BEFORE BOM strip / normalization (intentional — detects bytes-on-disk changes). */
  file_sha256: Sha256Hex;
  /** SHA-256 of post-BOM-strip + post-line-normalize content (defeats BOM SHA-grinding per P0-3A). */
  normalized_content_sha256: Sha256Hex;
  /** True if any BOMs were stripped. */
  bom_stripped: boolean;
  /** Count of BOMs stripped (>1 indicates adversarial stacking). */
  bom_count: number;
  total_lines: number; // non-blank lines processed
  parsed_lines: number; // produced valid LogEntry
  skipped_lines: number; // produced warning but no entry
}

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

/** Prototype-polluting keys — rejected by limit walker. */
const PROTO_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Regex matching all 7 line terminators per SPEC v0.1.3 F10. */
const LINE_TERMINATORS_RE = /\r\n|\r|\n|\u2028|\u2029|\u0085|\u000c/g;

/** Sentinel for entries with no workload field. Null-byte prefix prevents collision with user values (P1-g). */
const UNSPECIFIED_WORKLOAD = "\u0000unspecified";

// ════════════════════════════════════════════════════════════════════
// Preprocessing
// ════════════════════════════════════════════════════════════════════

/**
 * Strip UTF-8 BOM(s) from start of string. LOOPS to strip stacked BOMs per
 * adversarial-review B1 (single-BOM strip enabled SHA-grinding attack — an
 * adversary prefixing N BOMs could produce N distinct file_sha256 values
 * for the same logical content).
 *
 * Returns [stripped, bomCount] — caller emits warning if bomCount > 0.
 */
export function stripBom(s: string): [string, number] {
  let count = 0;
  while (s.length > 0 && s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
    count++;
  }
  return [s, count];
}

/**
 * Normalize 7 line-terminator sequences to LF per SPEC v0.1.3 F10:
 *   CRLF (Windows), CR (old Mac), LF (Unix), U+2028 (Line Separator),
 *   U+2029 (Paragraph Separator), U+0085 (Next Line), U+000C (Form Feed).
 */
export function normalizeLineTerminators(s: string): string {
  return s.replace(LINE_TERMINATORS_RE, "\n");
}

// ════════════════════════════════════════════════════════════════════
// Hard-limit walker (recursive, prototype-pollution defense)
// ════════════════════════════════════════════════════════════════════

/**
 * Recursively validate that a parsed JSON value satisfies parser hard limits:
 *   - depth ≤ limits.maxDepth
 *   - field count per object ≤ limits.maxFieldsPerObject
 *   - string length ≤ limits.maxStringLength
 *   - no prototype-polluting keys (__proto__, constructor, prototype)
 *   - object prototype must be Object.prototype or null (belt-and-braces P0-5A
 *     defense — verified unnecessary on Node ≥20.18 but cheap defense-in-depth)
 *
 * Returns Ok on success, Err with JSON-pointer-style path on first violation.
 */
export function walkValidate(
  value: unknown,
  limits: ParserLimits,
  depth: number,
  path: string,
): Result<true, ValidationError> {
  if (depth > limits.maxDepth) {
    return err({
      code: "constraint_violation",
      message: `Max depth ${limits.maxDepth} exceeded`,
      path,
    });
  }

  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      return err({
        code: "constraint_violation",
        message: `String length ${value.length} exceeds max ${limits.maxStringLength}`,
        path,
      });
    }
    return ok(true);
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const child = walkValidate(value[i], limits, depth + 1, `${path}[${i}]`);
      if (!child.ok) return child;
    }
    return ok(true);
  }

  if (value !== null && typeof value === "object") {
    // Belt-and-braces prototype check per adversarial P0-5A — verified
    // unnecessary on Node ≥20.18 (Object.keys correctly enumerates __proto__
    // as an own property post-JSON.parse) but cheap defense-in-depth.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return err({
        code: "schema_violation",
        message: "Object prototype mutated (prototype-pollution defense)",
        path,
      });
    }

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > limits.maxFieldsPerObject) {
      return err({
        code: "constraint_violation",
        message: `Field count ${keys.length} exceeds max ${limits.maxFieldsPerObject}`,
        path,
      });
    }
    for (const key of keys) {
      if (PROTO_KEYS.has(key)) {
        return err({
          code: "schema_violation",
          message: `Prototype-polluting key rejected: ${key}`,
          path: `${path}.${key}`,
        });
      }
      const child = walkValidate(obj[key], limits, depth + 1, `${path}.${key}`);
      if (!child.ok) return child;
    }
  }

  return ok(true);
}

// ════════════════════════════════════════════════════════════════════
// Per-line parsing
// ════════════════════════════════════════════════════════════════════

/** Construct a Warning with optional context. */
function makeWarning(
  code: WarningCode,
  message: string,
  context?: Record<string, unknown>,
): Warning {
  return context !== undefined ? { code, message, context } : { code, message };
}

interface LineParseOutcome {
  entry?: LogEntry;
  warning?: Warning;
}

/**
 * Parse one JSONL line + validate as LogEntry.
 *
 * Semantics:
 *   - Empty / whitespace-only line: silently skipped (no warning).
 *   - Line length > limits.maxLineLength: warning, skip.
 *   - Malformed JSON: warning, skip.
 *   - Not a JSON object: warning, skip.
 *   - Limit violation (depth/fields/string/proto key): warning, skip.
 *   - Missing/invalid required field: warning, skip.
 *   - Token > Number.MAX_SAFE_INTEGER: warning, skip (P0-2A).
 *   - Non-integer token (incl. -3.7): warning, skip (Sec P1-C — check BEFORE clamp).
 *   - Negative tokens: CLAMPED to 0 (per C5), warning emitted, ENTRY KEPT.
 */
function parseLine(
  line: string,
  lineNum: number,
  limits: ParserLimits,
): LineParseOutcome {
  if (line.length === 0) return {};

  if (line.length > limits.maxLineLength) {
    return {
      warning: makeWarning(
        "parser_limit_exceeded",
        `Line ${lineNum} exceeds max line length`,
        { line_num: lineNum, length: line.length, max: limits.maxLineLength },
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return {
      warning: makeWarning(
        "malformed_jsonl_line",
        `Line ${lineNum} is not valid JSON`,
        { line_num: lineNum, error: (e as Error).message },
      ),
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      warning: makeWarning(
        "malformed_jsonl_line",
        `Line ${lineNum} did not parse to a JSON object`,
        { line_num: lineNum },
      ),
    };
  }

  // Hard-limit walk (depth, field count, string length, proto-key rejection, prototype check).
  const limitCheck = walkValidate(parsed, limits, 1, "$");
  if (!limitCheck.ok) {
    return {
      warning: makeWarning(
        "parser_limit_exceeded",
        `Line ${lineNum} violates parser limits: ${limitCheck.error.message}`,
        { line_num: lineNum, path: limitCheck.error.path },
      ),
    };
  }

  // P0-3C — extract to consts BEFORE typeof checks so type narrowing carries
  // through assignment (let through indexed access is fragile across refactors).
  const obj = parsed as Record<string, unknown>;
  const rawQueryId = obj["query_id"];
  const rawTimestamp = obj["timestamp"];
  const rawSent = obj["tokens_sent"];
  const rawReceived = obj["tokens_received"];

  if (typeof rawQueryId !== "string" || rawQueryId.length === 0) {
    return {
      warning: makeWarning(
        "malformed_jsonl_line",
        `Line ${lineNum} missing or invalid query_id`,
        { line_num: lineNum },
      ),
    };
  }
  if (typeof rawTimestamp !== "string" || rawTimestamp.length === 0) {
    return {
      warning: makeWarning(
        "malformed_jsonl_line",
        `Line ${lineNum} missing or invalid timestamp`,
        { line_num: lineNum },
      ),
    };
  }
  if (typeof rawSent !== "number" || !Number.isFinite(rawSent)) {
    return {
      warning: makeWarning(
        "malformed_jsonl_line",
        `Line ${lineNum} missing or invalid tokens_sent`,
        { line_num: lineNum },
      ),
    };
  }
  if (typeof rawReceived !== "number" || !Number.isFinite(rawReceived)) {
    return {
      warning: makeWarning(
        "malformed_jsonl_line",
        `Line ${lineNum} missing or invalid tokens_received`,
        { line_num: lineNum },
      ),
    };
  }

  // P0-2A — reject tokens that lost precision in JSON.parse (>2^53-1).
  // BigInt math downstream depends on integer exactness; smuggled
  // 9007199254740993 silently becomes 9007199254740992 in JSON.parse,
  // producing off-by-one savings without any signal.
  if (
    rawSent > Number.MAX_SAFE_INTEGER ||
    rawReceived > Number.MAX_SAFE_INTEGER ||
    rawSent < -Number.MAX_SAFE_INTEGER ||
    rawReceived < -Number.MAX_SAFE_INTEGER
  ) {
    return {
      warning: makeWarning(
        "malformed_jsonl_line",
        `Line ${lineNum} has token value exceeding Number.MAX_SAFE_INTEGER (precision-lossy)`,
        { line_num: lineNum, max_safe: Number.MAX_SAFE_INTEGER },
      ),
    };
  }

  // Sec P1-C — integer check BEFORE negative clamp so a -3.7 payload still
  // reports as non-integer rather than silently clamping to 0 (losing signal).
  if (!Number.isInteger(rawSent) || !Number.isInteger(rawReceived)) {
    return {
      warning: makeWarning(
        "malformed_jsonl_line",
        `Line ${lineNum} has non-integer token value`,
        { line_num: lineNum },
      ),
    };
  }

  // Token clamping per v0.1.4 C5: negative tokens clamped to 0, line KEPT.
  let tokens_sent: number = rawSent;
  let tokens_received: number = rawReceived;
  let clampWarning: Warning | undefined;

  if (tokens_sent < 0 || tokens_received < 0) {
    const original = { tokens_sent, tokens_received };
    tokens_sent = Math.max(0, tokens_sent);
    tokens_received = Math.max(0, tokens_received);
    clampWarning = makeWarning(
      "negative_token_clamped",
      `Line ${lineNum} had negative token value(s), clamped to 0`,
      { line_num: lineNum, original },
    );
  }

  const entry: LogEntry = {
    query_id: rawQueryId,
    timestamp: rawTimestamp,
    tokens_sent,
    tokens_received,
  };

  if (typeof obj["workload"] === "string") entry.workload = obj["workload"];
  if (typeof obj["model"] === "string") entry.model = obj["model"];
  if (typeof obj["provider"] === "string") entry.provider = obj["provider"];
  if (typeof obj["dev_id"] === "string") entry.dev_id = obj["dev_id"];
  if (
    obj["metadata"] !== undefined &&
    obj["metadata"] !== null &&
    typeof obj["metadata"] === "object" &&
    !Array.isArray(obj["metadata"])
  ) {
    entry.metadata = obj["metadata"] as Record<string, unknown>;
  }

  return clampWarning !== undefined
    ? { entry, warning: clampWarning }
    : { entry };
}

// ════════════════════════════════════════════════════════════════════
// Public API — parseJsonlString + parseJsonlFile
// ════════════════════════════════════════════════════════════════════

/**
 * Parse JSONL from an in-memory string.
 *
 * Processing order (deterministic):
 *   1. SHA-256 over RAW bytes (BEFORE BOM strip / line normalization) → file_sha256.
 *      Same logical content with different line endings produces DIFFERENT file SHAs
 *      (intentional — we want to detect that the bytes on disk changed).
 *   2. Strip UTF-8 BOM(s) — multi-strip per P0-3A defense — record bom_count.
 *   3. Normalize 7 line terminators to LF.
 *   4. SHA-256 over post-strip + post-normalize content → normalized_content_sha256.
 *      Defeats BOM-stacking SHA-grinding attack: same logical content → same SHA
 *      regardless of BOM/line-ending stacking.
 *   5. Split on LF. For each non-empty line, parse + validate as LogEntry.
 *   6. Per-line failures become warnings (lines counted as skipped).
 *      Per-line clampings emit warnings BUT keep the entry.
 *   7. File-level limit (maxLinesPerFile) returns Err.
 */
export function parseJsonlString(
  contents: string,
  options?: {
    limits?: Partial<ParserLimits>;
    logger?: Logger;
  },
): Result<ParseResult, ValidationError> {
  const limits: ParserLimits = {
    ...DEFAULT_PARSER_LIMITS,
    ...(options?.limits ?? {}),
  };
  const logger = options?.logger ?? new NullLogger();

  // SHA-256 over raw bytes (UTF-8 encoded contents) BEFORE any normalization.
  const file_sha256_hex = createHash("sha256")
    .update(contents, "utf8")
    .digest("hex");
  const file_sha256 = `sha256:${file_sha256_hex}` as Sha256Hex;

  // Strip BOM(s) — multi-strip per P0-3A.
  const [bomStripped, bomCount] = stripBom(contents);

  // Normalize line terminators
  const normalized = normalizeLineTerminators(bomStripped);

  // P0-3A — SHA over normalized content. Auditor cross-checks against file_sha256
  // to detect BOM/line-ending shenanigans.
  const normalized_sha256_hex = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex");
  const normalized_content_sha256 = `sha256:${normalized_sha256_hex}` as Sha256Hex;

  // Split into lines
  const lines = normalized.split("\n");

  if (lines.length > limits.maxLinesPerFile) {
    return err({
      code: "constraint_violation",
      message: `File contains ${lines.length} lines, exceeds max ${limits.maxLinesPerFile}`,
      path: "$",
    });
  }

  const entries: LogEntry[] = [];
  const warnings: Warning[] = [];

  if (bomCount > 0) {
    const w = makeWarning(
      "bom_stripped",
      bomCount === 1
        ? "UTF-8 BOM detected at file start and stripped"
        : `${bomCount} stacked UTF-8 BOMs detected at file start and stripped (adversarial pattern)`,
      { bom_count: bomCount },
    );
    warnings.push(w);
    logger.warn(w.message, w.context);
  }

  let parsed_lines = 0;
  let skipped_lines = 0;
  let nonBlankLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    nonBlankLines++;

    const outcome = parseLine(line, i + 1, limits);
    if (outcome.warning !== undefined) {
      warnings.push(outcome.warning);
      logger.warn(outcome.warning.message, outcome.warning.context);
    }
    if (outcome.entry !== undefined) {
      entries.push(outcome.entry);
      parsed_lines++;
    } else if (outcome.warning !== undefined) {
      skipped_lines++;
    }
  }

  return ok({
    entries,
    warnings,
    file_sha256,
    normalized_content_sha256,
    bom_stripped: bomCount > 0,
    bom_count: bomCount,
    total_lines: nonBlankLines,
    parsed_lines,
    skipped_lines,
  });
}

/**
 * Parse JSONL from a file path (synchronous read).
 *
 * For v0.1.0 the parser reads the entire file into memory. Streaming
 * optimization is V0.2. At max-lines-per-file (10M × ~250 bytes/line ≈ 2.5GB),
 * this is a documented limit; a future version may add `parser_streaming: true` opt-in.
 *
 * SECURITY NOTE (per security-reviewer P1-A): filepath is passed directly to
 * readFileSync with no normalization. Callers (CLI, SDK) MUST validate filepath
 * against an allow-list when exposing this API to untrusted input. Library
 * users in trusted contexts (audit pipelines) require no further sanitization.
 */
export function parseJsonlFile(
  filepath: string,
  options?: {
    limits?: Partial<ParserLimits>;
    logger?: Logger;
  },
): Result<ParseResult, ValidationError> {
  let contents: string;
  try {
    contents = readFileSync(filepath, "utf8");
  } catch (e) {
    return err({
      code: "invalid_type",
      message: `Failed to read ${filepath}: ${(e as Error).message}`,
      path: "$",
    });
  }
  return parseJsonlString(contents, options);
}

// ════════════════════════════════════════════════════════════════════
// Workload fingerprint per SPEC v0.1.3 F1 (redesigned to defeat S1 bypass)
// ════════════════════════════════════════════════════════════════════

/**
 * Normalize workload for fingerprint: Unicode NFC + lowercase + trim.
 *
 * P1-d — NFC normalization closes the composed/decomposed bypass:
 *   `"refactör"` (NFC) vs `"refactör"` (decomposed) → both NFC-equivalent
 *   after .normalize("NFC"). Without this, attacker submits decomposed in
 *   baseline + composed in active → false set-mismatch (or vice-versa).
 */
function normalizeWorkload(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

/**
 * Centralized workload-key resolution per P1-e (DRY): same logic used in
 * tuple construction + count tracking.
 *
 * Returns the normalized workload string, or UNSPECIFIED_WORKLOAD sentinel
 * (null-byte prefixed per P1-g — prevents collision with user-supplied
 * `"__unspecified__"` workload value).
 */
function workloadKey(entry: LogEntry): string {
  return entry.workload !== undefined && entry.workload !== ""
    ? normalizeWorkload(entry.workload)
    : UNSPECIFIED_WORKLOAD;
}

export interface FingerprintInput {
  baseline: readonly LogEntry[];
  active: readonly LogEntry[];
  /** Fail-closed threshold (0..1) — workload absent on >this fraction triggers null match. */
  workloadAbsentFailClosed: number;
  /** Count skew threshold (0..1) — fraction asymmetry triggering warning. */
  countSkewWarn: number;
}

export interface FingerprintOutput {
  baseline_workloads: Sha256Hex;
  active_workloads: Sha256Hex;
  fingerprint_match: boolean | null;
  fingerprint_reason: "ok" | "workload_field_absent" | "set_mismatch" | "count_skew" | "empty_input";
  count_per_workload: Record<string, { baseline: number; active: number }>;
  warnings: Warning[];
  /** Per-workload skews surfaced even on set_mismatch path (P0-2C). Empty when no skews. */
  skewed_workloads: string[];
}

/**
 * Compute workload fingerprint per SPEC v0.1.3 F1 (redesigned after surrogate-S1
 * bypass discovery), HARDENED per adversarial audit:
 *
 *   P0-1A — canonical tuple = JSON.stringify([query_id, normalized_workload]).
 *     Closes :/| collision attack (legal chars in user input couldn't be
 *     smuggled across the separator before).
 *
 *   P0-4A — collect ALL count_skews before return. Previous implementation
 *     early-returned on first skewed workload, hiding multiples (attacker
 *     engineered low-importance workload alphabetically-first to mask
 *     high-importance skew).
 *
 *   P0-2C — set_mismatch path now ALSO surfaces count_per_workload skew
 *     diagnostics. Auditor sees BOTH "sets differ" AND "and here's WHICH
 *     workloads are most skewed" in a single output.
 *
 *   P1-c — empty baseline + empty active no longer silently matches (empty
 *     fingerprints are equal). Emits warning + null match + reason "empty_input".
 *
 *   P1-d — Unicode NFC normalize before lowercase (in normalizeWorkload).
 *
 *   P1-g — UNSPECIFIED_WORKLOAD uses \u0000 prefix (collision-proof).
 *
 *   P1-e — workloadKey() helper centralizes resolution (DRY).
 */
export function computeWorkloadFingerprint(
  input: FingerprintInput,
): FingerprintOutput {
  const warnings: Warning[] = [];
  const { baseline, active, workloadAbsentFailClosed, countSkewWarn } = input;

  // P1-c — empty input is suspicious (caller should validate, but fail-loud here too)
  if (baseline.length === 0 || active.length === 0) {
    warnings.push(
      makeWarning(
        "workload_field_absent",
        "Empty baseline or active entries — fingerprint cannot be meaningfully computed",
        { baseline_count: baseline.length, active_count: active.length },
      ),
    );
    // Compute empty hashes for completeness, but return fail-closed.
    const emptyHash = `sha256:${createHash("sha256")
      .update("")
      .digest("hex")}` as Sha256Hex;
    return {
      baseline_workloads: emptyHash,
      active_workloads: emptyHash,
      fingerprint_match: null,
      fingerprint_reason: "empty_input",
      count_per_workload: {},
      warnings,
      skewed_workloads: [],
    };
  }

  // Per-side workload-absent ratio
  const baselineAbsent = baseline.filter(
    (e) => e.workload === undefined || e.workload === "",
  ).length;
  const activeAbsent = active.filter(
    (e) => e.workload === undefined || e.workload === "",
  ).length;
  const baselineAbsentRatio = baselineAbsent / baseline.length;
  const activeAbsentRatio = activeAbsent / active.length;

  // P0-1A — canonical tuples via JSON.stringify([id, workload]) close :/| collision.
  // JSON.stringify escapes embedded delimiters in either field, so no user input
  // can produce a tuple that collides with a different (id, workload) pair.
  const baselineTuples = baseline
    .map((e) => JSON.stringify([e.query_id, workloadKey(e)]))
    .sort();
  const activeTuples = active
    .map((e) => JSON.stringify([e.query_id, workloadKey(e)]))
    .sort();

  // Use newline as join — JSON.stringify guarantees \n is escaped inside strings,
  // so collisions across the boundary are cryptographically infeasible.
  const baseline_workloads = `sha256:${createHash("sha256")
    .update(baselineTuples.join("\n"))
    .digest("hex")}` as Sha256Hex;
  const active_workloads = `sha256:${createHash("sha256")
    .update(activeTuples.join("\n"))
    .digest("hex")}` as Sha256Hex;

  // Per-workload counts (uses workloadKey helper for consistency).
  const count_per_workload: Record<string, { baseline: number; active: number }> = {};
  for (const e of baseline) {
    const w = workloadKey(e);
    if (!count_per_workload[w]) count_per_workload[w] = { baseline: 0, active: 0 };
    count_per_workload[w].baseline++;
  }
  for (const e of active) {
    const w = workloadKey(e);
    if (!count_per_workload[w]) count_per_workload[w] = { baseline: 0, active: 0 };
    count_per_workload[w].active++;
  }

  // P0-4A — collect ALL skewed workloads (sorted deterministically), don't early-return.
  // Auditor sees every skew rather than just the alphabetically-first.
  const skewed_workloads: string[] = [];
  const entries = Object.entries(count_per_workload).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [workload, counts] of entries) {
    const max = Math.max(counts.baseline, counts.active);
    const min = Math.min(counts.baseline, counts.active);
    if (max > 0 && min / max < 1 - countSkewWarn) {
      skewed_workloads.push(workload);
      warnings.push(
        makeWarning(
          "fingerprint_count_skew",
          `Workload "${workload}" has count skew greater than ${(countSkewWarn * 100).toFixed(0)}%`,
          { workload, baseline_count: counts.baseline, active_count: counts.active },
        ),
      );
    }
  }

  // Fail-closed: workload absent on >threshold%
  if (
    baselineAbsentRatio > workloadAbsentFailClosed ||
    activeAbsentRatio > workloadAbsentFailClosed
  ) {
    warnings.push(
      makeWarning(
        "workload_field_absent",
        "Workload field absent on more entries than fail-closed threshold",
        {
          baseline_absent_ratio: baselineAbsentRatio,
          active_absent_ratio: activeAbsentRatio,
          threshold: workloadAbsentFailClosed,
        },
      ),
    );
    return {
      baseline_workloads,
      active_workloads,
      fingerprint_match: null,
      fingerprint_reason: "workload_field_absent",
      count_per_workload,
      warnings,
      skewed_workloads,
    };
  }

  // Set mismatch (different tuples between baseline + active).
  // P0-2C — even on set_mismatch path, surface count diagnostics (already collected above).
  if (baseline_workloads !== active_workloads) {
    warnings.push(
      makeWarning(
        "fingerprint_set_mismatch",
        "Baseline + active workload sets differ",
        {
          baseline_workloads,
          active_workloads,
          skewed_workloads_count: skewed_workloads.length,
        },
      ),
    );
    return {
      baseline_workloads,
      active_workloads,
      fingerprint_match: false,
      fingerprint_reason: "set_mismatch",
      count_per_workload,
      warnings,
      skewed_workloads,
    };
  }

  // Hashes match — count_skew is the remaining gradient.
  if (skewed_workloads.length > 0) {
    return {
      baseline_workloads,
      active_workloads,
      fingerprint_match: false,
      fingerprint_reason: "count_skew",
      count_per_workload,
      warnings,
      skewed_workloads,
    };
  }

  return {
    baseline_workloads,
    active_workloads,
    fingerprint_match: true,
    fingerprint_reason: "ok",
    count_per_workload,
    warnings,
    skewed_workloads,
  };
}
