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
  LogEntry,
  MatchedQuery,
  MismatchSeverity,
  PerWorkloadResult,
  QueryDiff,
  TokenAggregates,
} from "./types.js";

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
