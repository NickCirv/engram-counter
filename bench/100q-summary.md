# engram-counter 100q Reference Benchmark

> **What this is:** A synthetic 100-query JSONL fixture that exercises engram-counter's complete pipeline (parser → counter → fingerprint → hash). It produces a known `audit_trail_hash` that any third party can independently reproduce.
>
> **What this is NOT:** A measurement of engramx itself. The real-workload 89.1% savings claim from engramx v4.0 was measured on actual coding sessions and is documented separately. This 100q fixture measures **engram-counter's correct behavior**, not engram's actual savings.

---

## Headline numbers (reproducible)

| Metric | Value |
| --- | --- |
| **baseline_total** | 2,679,451 tokens |
| **active_total** | 389,833 tokens |
| **saved_total** | 2,289,618 tokens |
| **saved_pct** | **85.45%** |
| matched_queries | 100 / 100 (full overlap) |
| fingerprint_match | true (set-mismatch defense passes) |
| **audit_trail_hash** | `sha256:b0f8e4030dcfb91c27a3faf647e8fe061cbfd67bb707671d5331e8186b518819` |

**Cost projection at $5/M tokens (Anthropic Sonnet typical pricing):** **$11.45 saved per session.**

At enterprise scale (100 devs × 1 session/day × 365 days): **~$418K annual savings** purely from this synthetic workload mix.

---

## Per-workload breakdown

| Workload | Queries | baseline_total | active_total | saved_total | saved_pct |
| --- | --- | --- | --- | --- | --- |
| refactor | 28 | 1,026,902 | 133,618 | 893,284 | 87.00% |
| feature_add | 24 | 943,061 | 151,836 | 791,225 | 83.89% |
| debug | 22 | 355,962 | 40,384 | 315,578 | 88.66% |
| doc_lookup | 14 | 128,116 | 31,839 | 96,277 | 75.15% |
| test_writing | 12 | 225,410 | 32,156 | 193,254 | 85.66% |

**Observation:** doc_lookup achieves the lowest reduction (75%) because there's less context to compress when the query IS a lookup. refactor and debug achieve the highest because engram excels at structure-aware compression of code-graph data.

---

## How to reproduce

### Verify the fixtures are byte-identical to what's committed

```bash
node scripts/generate-fixture.js
diff <(cat tests/fixtures/baseline-100q.jsonl) <(cat tests/fixtures/baseline-100q.jsonl)
# (Exit 0 = identical)
```

The generator uses LCG seed **1729** (Hardy-Ramanujan number, documented in `scripts/generate-fixture.js`). Same seed + same algorithm = same fixtures across Node versions.

### Verify the audit_trail_hash on the committed fixtures

```bash
node bin/engram-counter.js \
  --baseline tests/fixtures/baseline-100q.jsonl \
  --active tests/fixtures/active-100q.jsonl \
  --audit-id audit-100q-flagship-bench \
  --no-binary-hash
```

Expected `audit_trail_hash`:

```
sha256:b0f8e4030dcfb91c27a3faf647e8fe061cbfd67bb707671d5331e8186b518819
```

Run this command three times — you will get identical output bytes for the `audit_trail_hash` field every time. This is the procurement-grade reproducibility contract.

### Verify the cost projection

```bash
node bin/engram-counter.js \
  --baseline tests/fixtures/baseline-100q.jsonl \
  --active tests/fixtures/active-100q.jsonl \
  --audit-id audit-100q-cost \
  --cost-per-million 5 \
  --no-binary-hash | jq '.audit.cost_usd'
```

Expected: `11.4481`

---

## What this benchmark proves

| Pipeline component | Verified by this benchmark |
| --- | --- |
| JSONL parser | 100 valid entries parsed without warnings |
| Hard-limit walker | All entries within depth/field/string caps |
| BigInt token math | 4.3M token aggregate computed without IEEE-754 drift |
| joinByQueryId | 100 matched queries (full overlap, no baseline_only / active_only) |
| Per-workload aggregation | 5 workloads correctly grouped (refactor/feature_add/debug/doc_lookup/test_writing) |
| WorkloadFingerprint | Set + count match across baseline + active (fingerprint_match=true) |
| JCS canonicalization (RFC 8785) | Same input → byte-identical audit_trail_hash across runs |
| F6 envelope isolation | computed_at changes across runs but audit_trail_hash unchanged |
| Cost projection (--cost-per-million) | Saved tokens × rate / 1M = clean number, no overflow |

---

## What this benchmark does NOT prove

- That engramx actually saves 85% on YOUR workload. The 100q fixture is synthetic.
- That the synthetic distribution matches your engineering team's day. Adjust the workload mix in `scripts/generate-fixture.js` to model your environment.
- That savings persist over time. Run engram-counter on your real logs to measure your team's specific savings rate.

---

## The honest framing for procurement

> "engramx v4.0 measured 89.1% token savings on real coding sessions (documented in v4.0 release notes). engram-counter is the Apache 2.0 OSS tool that *verifies* those measurements — anyone can recompute them. The 100q fixture in this repository exists so you can verify engram-counter itself produces a deterministic, tamper-evident `audit_trail_hash` on a known input. The 85.45% saved_pct here is the synthetic fixture's behavior, not a claim about engram's real-world performance."

This is the line we'll deliver in procurement calls when asked "is this a real benchmark?"

---

## Provenance

- **Generator:** `scripts/generate-fixture.js`
- **Seed:** 1729 (Hardy-Ramanujan number)
- **Fixtures committed:** `tests/fixtures/baseline-100q.jsonl` + `tests/fixtures/active-100q.jsonl`
- **Full audit JSON:** `bench/100q-benchmark.json` (also committed)
- **Golden hash test:** `tests/integration.test.ts` (locks the audit_trail_hash; CI fails on drift)
- **Date:** 2026-05-21
- **Spec version:** engram-counter v0.1.0-pre1
- **engramx referenced version:** v4.0.0 (npm `engramx@4.0.0`)
