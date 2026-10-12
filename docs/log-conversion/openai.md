# Openai log conversion

Normalize an existing usage export into the counter's JSONL contract. This guide is grounded in the counter parser and arithmetic, not a verification of the provider's current API or prices.

OpenAI export formats differ across endpoints. A Chat Completions-shaped export may use `prompt_tokens`, `completion_tokens`, and nested cached-token details; other response formats must use their own explicit adapter. Do not apply one field map to every endpoint.

## Required record contract

```json
{"query_id":"task-001","timestamp":"2026-04-24T12:00:00Z","tokens_sent":100,"tokens_received":20,"workload":"refactor"}
```

This is synthetic input, not a captured provider response. `query_id` must identify the same task in baseline and active logs; unrelated provider response IDs do not establish pairing. Retain the original observation timestamp. Use finite integer token counts and a consistent workload label. Keep raw exports alongside the conversion script for traceability.

## Cache accounting boundary

Optional `cache_read_tokens` and `cache_creation_tokens` are parsed separately. The cost calculation charges `tokens_sent` as ordinary input **and adds** both cache categories. If the export's input count already includes cached tokens, passing that total plus cache fields double-counts cost. Verify the export's semantics and derive disjoint categories before cost calculation. Reject missing or contradictory usage instead of replacing it with zero.

The raw token aggregate sums `tokens_sent + tokens_received`; it does not add the separate cache fields. This is a defined metric, not an accident: token totals measure uncached traffic, and cache traffic is reported separately (`cache_read_total` / `cache_creation_total` in the cost block). For a Chat Completions-shaped export, `prompt_tokens` includes `prompt_tokens_details.cached_tokens` (see the provider's prompt caching documentation), so the correct mapping is `tokens_sent = prompt_tokens - cached_tokens` and `cache_read_tokens = cached_tokens`. `tests/provider-examples.test.ts` proves this mapping prices each token exactly once and quantifies the double-count the naive mapping produces.

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
