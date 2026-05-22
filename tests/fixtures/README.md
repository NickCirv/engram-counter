# engram-counter test fixtures

## 10-query happy-path fixture

`baseline-10q.jsonl` + `active-10q.jsonl` are designed to produce **exactly 90.00% saved_pct** across all aggregates (total + per-workload). The math is hand-verified to land on whole basis-points.

### Workload distribution

| Workload | Queries | Baseline tokens | Active tokens | Saved % |
|---|---|---|---|---|
| refactor | 3 (q_001-q_003) | 156,000 | 15,600 | 90.00% |
| debug | 3 (q_004-q_006) | 94,500 | 9,450 | 90.00% |
| feature_add | 4 (q_007-q_010) | 293,050 | 29,305 | 90.00% |
| **TOTAL** | **10** | **543,550** | **54,355** | **90.00%** |

### BigInt math verification (per SPEC v0.1.3 F9)

- `saved_total = 543550 - 54355 = 489195`
- `basis_points = (BigInt(489195) * 10000n) / BigInt(543550) = 9000n`
- `saved_pct = 9000 / 100 = 90.00`

Exact integer division — no IEEE 754 drift. Same result on Node 18/20/22/Bun.

### Future fixtures

- `baseline-zero.jsonl` — empty file (test exit 2)
- `baseline-zero-tokens.jsonl` — all queries have 0 tokens (test exit 3)
- `baseline-negative.jsonl` — negative `tokens_sent` (test C5 clamp + anomalies field)
- `baseline-malformed.jsonl` — bad JSONL lines (test parser skip + warn)
- `baseline-fortune100.jsonl` — 2000-dev × 365-day scale (test F9 BigInt overflow safety)
- `unicode-terminators.jsonl` — uses U+2028 / U+2029 / U+0085 / U+000C (test F10)
