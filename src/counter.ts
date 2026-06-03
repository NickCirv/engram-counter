/**
 * engram-counter v0.1.0 — core math primitives.
 *
 * All percentage math goes through BigInt intermediate per SPEC v0.1.3 F9
 * to avoid Number.MAX_SAFE_INTEGER (2^53) overflow at Fortune-100 scale.
 *
 * Deterministic across Node 18/20/22/Bun. No IEEE-754 drift.
 *
 * Pure functions — no IO, no side effects, no hidden state.
 */

import type {
  CostAggregates,
  LogEntry,
  MatchedQuery,
  MismatchSeverity,
  PerWorkloadResult,
  QueryDiff,
  TokenAggregates,
} from "./types.js";
import {
  calculateCost,
  DEFAULT_MODEL,
  PRICING_VERSION,
  type ModelPricing,
} from "./pricing.js";

/**
 * Compute basis points (= percent × 100) of saved tokens.
 *
 * Uses BigInt intermediate product to avoid Number.MAX_SAFE_INTEGER overflow
 * at Fortune-100 scale (2000+ devs × 1.5M tokens/day × 365 days).
 * Per SPEC v0.1.3 F9.
 *
 * Input validation per v0.1.4 (adversarial review findings A2, A3):
 *   - Both arguments must be integers (no float/NaN/Infinity)
 *   - baseline_total must be ≥ 0 (negative baseline produces sign-flipped
 *     saved_pct silently — defense at boundary)
 *   - baseline_total === 0 throws (percentage undefined)
 *
 * @param saved_total - baseline_total - active_total (may be negative for regression)
 * @param baseline_total - total tokens in baseline window (non-negative integer)
 * @returns basis points (e.g., 9000 = 90.00%); may be negative when engram regresses
 * @throws TypeError on non-integer inputs (NaN, Infinity, fractional)
 * @throws RangeError when baseline_total < 0
 * @throws Error when baseline_total === 0
 */
export function savedPctBasisPoints(
  saved_total: number,
  baseline_total: number,
): number {
  if (!Number.isInteger(saved_total)) {
    throw new TypeError(
      `saved_total must be an integer; got ${saved_total}`,
    );
  }
  if (!Number.isInteger(baseline_total)) {
    throw new TypeError(
      `baseline_total must be an integer; got ${baseline_total}`,
    );
  }
  if (baseline_total < 0) {
    throw new RangeError(
      `baseline_total must be non-negative; got ${baseline_total}`,
    );
  }
  if (baseline_total === 0) {
    throw new Error(
      "Cannot compute saved_pct when baseline_total is zero",
    );
  }
  // BigInt division truncates toward zero — deterministic across runtimes.
  return Number((BigInt(saved_total) * 10000n) / BigInt(baseline_total));
}

/**
 * Convert basis points (0-10000, signed) to percent (0-100.00, signed).
 * 2-decimal-place precision baked in.
 */
export function basisPointsToPct(basis_points: number): number {
  return basis_points / 100;
}

/**
 * Diff matched queries: produces per-query diff data.
 *
 * For each matched query, computes:
 *   baseline_total = baseline.tokens_sent + baseline.tokens_received
 *   active_total = active.tokens_sent + active.tokens_received
 *   saved_total = baseline_total - active_total
 *   saved_pct = (saved_total / baseline_total) × 100 (via BigInt)
 *
 * Returns 0 saved_pct (not throws) when a single query has baseline_total === 0,
 * since per-query math degrades gracefully even when the primitive does not.
 */
export function diffQueries(matched: readonly MatchedQuery[]): QueryDiff[] {
  return matched.map((m) => {
    const baseline_total =
      m.baseline.tokens_sent + m.baseline.tokens_received;
    const active_total = m.active.tokens_sent + m.active.tokens_received;
    const saved_total = baseline_total - active_total;
    const saved_pct =
      baseline_total === 0
        ? 0
        : basisPointsToPct(savedPctBasisPoints(saved_total, baseline_total));
    return {
      query_id: m.query_id,
      workload: m.workload,
      baseline_total,
      active_total,
      saved_total,
      saved_pct,
    };
  });
}

/**
 * Aggregate token totals across matched queries.
 *
 * Returns deterministic zeros for empty input — caller responsibility to interpret
 * "zero baseline" as a meaningful condition (e.g., exit code 3 at the CLI layer).
 */
export function aggregateTokens(
  matched: readonly MatchedQuery[],
): TokenAggregates {
  let baseline_sent_total = 0;
  let active_sent_total = 0;
  let baseline_received_total = 0;
  let active_received_total = 0;

  for (const m of matched) {
    baseline_sent_total += m.baseline.tokens_sent;
    active_sent_total += m.active.tokens_sent;
    baseline_received_total += m.baseline.tokens_received;
    active_received_total += m.active.tokens_received;
  }

  const saved_sent = baseline_sent_total - active_sent_total;
  const saved_received = baseline_received_total - active_received_total;
  const baseline_total = baseline_sent_total + baseline_received_total;
  const active_total = active_sent_total + active_received_total;
  const saved_total = baseline_total - active_total;
  const saved_pct =
    baseline_total === 0
      ? 0
      : basisPointsToPct(savedPctBasisPoints(saved_total, baseline_total));

  return {
    baseline_sent_total,
    active_sent_total,
    saved_sent,
    baseline_received_total,
    active_received_total,
    saved_received,
    baseline_total,
    active_total,
    saved_total,
    saved_pct,
  };
}

/**
 * Group matched queries by workload field; produce per-workload aggregate.
 *
 * Keys in returned record are sorted alphabetically for determinism (so JCS canonicalization
 * downstream produces identical hashes regardless of input order).
 *
 * Queries with `workload === undefined` are bucketed under the sentinel key `__unspecified__`.
 * This makes "missing workload" visible to procurement readers AND keeps the output complete.
 */
export function aggregateByWorkload(
  matched: readonly MatchedQuery[],
): Record<string, PerWorkloadResult> {
  const groups = new Map<string, MatchedQuery[]>();

  for (const m of matched) {
    const wl = m.workload ?? "__unspecified__";
    let list = groups.get(wl);
    if (!list) {
      list = [];
      groups.set(wl, list);
    }
    list.push(m);
  }

  // Alphabetic sort guarantees deterministic key order in output JSON.
  const sortedKeys = Array.from(groups.keys()).sort();
  const result: Record<string, PerWorkloadResult> = {};

  for (const wl of sortedKeys) {
    const group = groups.get(wl);
    if (!group) continue; // unreachable; satisfies noUncheckedIndexedAccess

    let baseline_total = 0;
    let active_total = 0;
    for (const m of group) {
      baseline_total += m.baseline.tokens_sent + m.baseline.tokens_received;
      active_total += m.active.tokens_sent + m.active.tokens_received;
    }
    const saved_total = baseline_total - active_total;
    const saved_pct =
      baseline_total === 0
        ? 0
        : basisPointsToPct(
            savedPctBasisPoints(saved_total, baseline_total),
          );

    result[wl] = {
      matched_queries: group.length,
      baseline_total,
      active_total,
      saved_total,
      saved_pct,
    };
  }

  return result;
}

/**
 * v0.2 — Aggregate USD cost across matched queries using cache-aware pricing.
 *
 * Mirrors aggregateTokens() but computes dollars using the Anthropic pricing
 * snapshot. Each row's cost = (input × rate) + (cache_read × rate × 0.1) +
 * (cache_creation × rate × 1.25) + (output × output_rate). Rows without
 * cache fields contribute zero to cache totals — v0.1.x JSONL back-compat
 * preserved.
 *
 * Reproducibility: USD floats rounded to 4dp at boundary so JCS canonical
 * form is stable across platforms (Node 18/20/22/24, Bun). Cents-precision
 * (2dp) is enough for marketing display; 4dp leaves headroom for fractional
 * cents without losing information.
 *
 * @param matched - paired baseline+active queries
 * @param pricing - model pricing snapshot from pricing.ts (e.g., PRICING_2026_05["claude-sonnet-4-6"])
 * @param meta - pricing provenance embedded in the result for auditability;
 *   defaults to DEFAULT_MODEL + PRICING_VERSION when omitted
 * @returns CostAggregates with provenance + baseline/active/saved/saved_pct + cache totals
 */
export function aggregateCost(
  matched: readonly MatchedQuery[],
  snapshot: Readonly<Record<string, ModelPricing>>,
  opts?: { defaultModel?: string; pricing_version?: string },
): CostAggregates {
  const defaultModel = opts?.defaultModel ?? DEFAULT_MODEL;
  const modelsSeen = new Set<string>();
  let baseline_cost = 0;
  let active_cost = 0;
  let cache_read_total = 0;
  let cache_creation_total = 0;

  // Price each row by ITS OWN model (per-row fix). A JSONL mixing models is
  // priced correctly per row instead of mis-stamped at one CLI-chosen SKU.
  //
  // STRICT per-row resolution (code-review fix 2026-05-30): a row's own `model`
  // must exist in the snapshot, else THROW. We do NOT fall back to defaultModel
  // for an explicit-but-unknown row model — silent fallback would (a) mis-price
  // the row at the cheap default and report a FABRICATED saving, and (b) stamp
  // provenance with a SKU absent from the pricing table, so an auditor cannot
  // reproduce the number. Only a MISSING model field uses defaultModel (which
  // is itself validated: CLI checks --model, DEFAULT_MODEL is in the snapshot).
  const priceRow = (row: LogEntry): number => {
    const model = row.model ?? defaultModel;
    const pricing = snapshot[model];
    if (pricing === undefined) {
      throw new Error(
        `aggregateCost: row model "${model}" is not in the pricing snapshot — ` +
          `cannot price or attest. Add it to the snapshot or fix the JSONL.`,
      );
    }
    modelsSeen.add(model); // record what was ACTUALLY priced, after resolution
    return calculateCost(row, pricing);
  };

  for (const m of matched) {
    baseline_cost += priceRow(m.baseline);
    active_cost += priceRow(m.active);
    cache_read_total +=
      (m.baseline.cache_read_tokens ?? 0) + (m.active.cache_read_tokens ?? 0);
    cache_creation_total +=
      (m.baseline.cache_creation_tokens ?? 0) +
      (m.active.cache_creation_tokens ?? 0);
  }

  // Round USD to 4dp at output boundary for cross-platform JCS hash stability.
  const baseline_cost_usd = round4(baseline_cost);
  const active_cost_usd = round4(active_cost);
  // saved from RAW accumulators (not already-rounded values) — avoids the
  // double-rounding drift an independent review measured (~25% of pairs off by 1e-4).
  const saved_cost_usd = round4(baseline_cost - active_cost);

  // saved_pct from RAW baseline — only exactly 0 when there is genuinely no
  // baseline cost. A tiny-but-nonzero baseline yields a real signed pct instead
  // of being masked to 0 (which contradicted a negative saved_cost_usd).
  const saved_pct =
    baseline_cost === 0
      ? 0
      : round2(((baseline_cost - active_cost) / baseline_cost) * 100);

  // Provenance: single model if uniform, else "mixed" (per-row truth lives in
  // the raw JSONL model fields). Empty input -> defaultModel for a stable stamp.
  const model =
    modelsSeen.size === 0
      ? defaultModel
      : modelsSeen.size === 1
        ? [...modelsSeen][0]!
        : "mixed";

  return {
    model,
    pricing_version: opts?.pricing_version ?? PRICING_VERSION,
    baseline_cost_usd,
    active_cost_usd,
    saved_cost_usd,
    saved_pct,
    cache_read_total,
    cache_creation_total,
  };
}

/** Round to 4 decimal places (USD precision for hash stability). */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Round to 2 decimal places (percentage display precision). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Determine mismatch severity per SPEC v0.1.3 F8 (three-tier exit codes).
 *
 * Maps mismatch percentage (queries present in one log but not both) to severity:
 *   - 'ok'   when mismatch_pct ≤ warn threshold  → CLI exit code 0
 *   - 'warn' when warn < mismatch_pct ≤ high     → CLI exit code 5
 *   - 'high' when mismatch_pct > high            → CLI exit code 6
 *
 * Boundary semantics: comparisons use strict `>` so exactly-at-threshold cases
 * (e.g., 10% mismatch with warn=0.10) classify as the lower tier.
 *
 * Degenerate case: total_unique === 0 (no queries at all) → 'ok'.
 */
export function mismatchSeverity(
  matched_count: number,
  baseline_only: number,
  active_only: number,
  thresholds: { warn: number; high: number },
): MismatchSeverity {
  // Threshold validation per v0.1.4 (adversarial review findings A4, A5):
  // catch NaN/Infinity AND catch inverted thresholds (warn > high).
  // Without these, silent-wrong-answer bugs corrupt severity classification.
  if (!Number.isFinite(thresholds.warn) || !Number.isFinite(thresholds.high)) {
    throw new TypeError(
      "thresholds.warn and thresholds.high must be finite numbers",
    );
  }
  if (thresholds.warn > thresholds.high) {
    throw new RangeError(
      `thresholds.warn (${thresholds.warn}) must be ≤ thresholds.high (${thresholds.high})`,
    );
  }

  const total_unique = matched_count + baseline_only + active_only;
  if (total_unique === 0) return "ok";

  // BigInt basis-point comparison (v0.1.5 closes last IEEE-754 leak per architect P0).
  // Internal computation in basis points (×10000); thresholds converted at boundary.
  const mismatch_bp = Number(
    (BigInt(baseline_only + active_only) * 10000n) / BigInt(total_unique),
  );
  const warn_bp = Math.round(thresholds.warn * 10000);
  const high_bp = Math.round(thresholds.high * 10000);

  if (mismatch_bp > high_bp) return "high";
  if (mismatch_bp > warn_bp) return "warn";
  return "ok";
}

/**
 * Result of join-by-query-id between baseline + active log entries.
 */
export interface JoinResult {
  matched: MatchedQuery[];
  baseline_only: LogEntry[];
  active_only: LogEntry[];
}

/**
 * Join baseline + active LogEntry arrays by query_id, producing:
 *   - matched: MatchedQuery[] (entries present in BOTH) — feeds aggregateTokens
 *   - baseline_only: entries only in baseline (no active counterpart)
 *   - active_only: entries only in active (no baseline counterpart)
 *
 * For matched entries, baseline.workload is preferred over active.workload
 * (baseline establishes the canonical workload classification).
 *
 * Design rationale — surface the seam between parser and counter as a named, tested
 * unit. Previously buried in unwritten CLI code; now testable end-to-end.
 *
 * Performance: O(b + a) using a Map index. Acceptable for 10M-line input
 * budget (max parser limit).
 *
 * Note: if baseline contains duplicate query_ids (parser allows this — last
 * wins is JSON.parse default), only the LAST entry's joined record is kept.
 * v0.2 may add deduplication + warning.
 */
export function joinByQueryId(
  baseline: readonly LogEntry[],
  active: readonly LogEntry[],
): JoinResult {
  const activeMap = new Map<string, LogEntry>();
  for (const e of active) activeMap.set(e.query_id, e);

  const matched: MatchedQuery[] = [];
  const baseline_only: LogEntry[] = [];
  const matched_query_ids = new Set<string>();

  for (const b of baseline) {
    const a = activeMap.get(b.query_id);
    if (a !== undefined) {
      matched.push({
        query_id: b.query_id,
        workload: b.workload, // baseline workload preferred (canonical classification)
        baseline: b,
        active: a,
      });
      matched_query_ids.add(b.query_id);
    } else {
      baseline_only.push(b);
    }
  }

  const active_only: LogEntry[] = [];
  for (const a of active) {
    if (!matched_query_ids.has(a.query_id)) {
      active_only.push(a);
    }
  }

  return { matched, baseline_only, active_only };
}
