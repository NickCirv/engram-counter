# Anthropic log conversion

Normalize an existing usage export into the counter's JSONL contract. This guide is grounded in the counter parser and arithmetic, not a verification of the provider's current API or prices.

An Anthropic-shaped usage export may distinguish ordinary input, cache reads, cache creation and output. Preserve these categories independently; do not assume that an input field already includes cache categories.

## Required record contract

```json
{"query_id":"task-001","timestamp":"2026-04-24T12:00:00Z","tokens_sent":100,"tokens_received":20,"workload":"refactor"}
```

This is synthetic input, not a captured provider response. `query_id` must identify the same task in baseline and active logs; unrelated provider response IDs do not establish pairing. Retain the original observation timestamp. Use finite integer token counts and a consistent workload label. Keep raw exports alongside the conversion script for traceability.

## Cache accounting boundary

Optional `cache_read_tokens` and `cache_creation_tokens` are parsed separately. The cost calculation charges `tokens_sent` as ordinary input **and adds** both cache categories. If the export's input count already includes cached tokens, passing that total plus cache fields double-counts cost. Verify the export's semantics and derive disjoint categories before cost calculation. Reject missing or contradictory usage instead of replacing it with zero.

The raw token aggregate sums `tokens_sent + tokens_received`; it does not add the separate cache fields. Therefore cost-oriented disjoint categories do not simultaneously represent a cache-inclusive total-token comparison. State which metric the conversion supports and retain a separately derived total if required. This source behavior is a limitation to resolve before interpreting cache-heavy comparisons.

## Conversion review

1. Identify the exact endpoint/export version and verify its usage-field definitions.
2. Assign paired task IDs and consistent workload labels before joining logs.
3. Preserve model/provider metadata and original cache categories. Do not infer missing values.
4. Validate nonnegative integer counts, timestamp presence, duplicates, and task-set mismatches.
5. Compare converted rows with the raw export, then run the built CLI on a small fixture.

The bundled price table is a versioned implementation input, not a current provider quote; unknown models and differing cache policies require explicit review. A SHA-256 digest identifies supplied bytes but cannot prove an export is complete or authentic.

## Evidence

- [Parser](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/parser.ts)
- [Token aggregation](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/counter.ts)
- [Cost arithmetic](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/pricing.ts)

No conversion, provider request, or counter invocation was executed for this review.
