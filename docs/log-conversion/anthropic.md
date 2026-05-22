# Anthropic → engram-counter JSONL conversion

Recipe for converting Anthropic API logs (Claude API direct, Claude Code CLI, or Claude API Console exports) into the JSONL format engram-counter expects.

## Target schema

Each JSONL line must be a JSON object with these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `query_id` | string | YES | Stable identifier matching baseline ↔ active runs |
| `timestamp` | string | YES | ISO-8601 (any format with `T` separator) |
| `tokens_sent` | integer | YES | Input tokens (≤ Number.MAX_SAFE_INTEGER) |
| `tokens_received` | integer | YES | Output tokens (≤ Number.MAX_SAFE_INTEGER) |
| `workload` | string | RECOMMENDED | Workload classification — required for fingerprint defense |
| `model` | string | optional | e.g., `claude-opus-4-7` |
| `provider` | string | optional | e.g., `anthropic` |
| `dev_id` | string | optional | Engineer identifier |
| `metadata` | object | optional | Arbitrary additional context |

---

## 1. Claude API (direct REST/SDK) → JSONL

Anthropic's `/v1/messages` endpoint returns a `usage` block:

```json
{
  "id": "msg_01ABC...",
  "type": "message",
  "model": "claude-opus-4-7",
  "usage": {
    "input_tokens": 12450,
    "output_tokens": 380,
    "cache_creation_input_tokens": 8500,
    "cache_read_input_tokens": 0
  }
}
```

**Conversion (Python):**

```python
import json
import sys
from datetime import datetime, timezone

def anthropic_to_engram_counter_line(anthropic_response, query_id, workload, dev_id=None):
    """
    Convert an Anthropic /v1/messages response to one JSONL line.

    Note: input_tokens already INCLUDES cache_read_input_tokens per Anthropic docs.
    cache_creation_input_tokens is BILLED but already accounted in input_tokens.
    """
    usage = anthropic_response.get("usage", {})
    entry = {
        "query_id": query_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "tokens_sent": int(usage.get("input_tokens", 0)),
        "tokens_received": int(usage.get("output_tokens", 0)),
        "workload": workload,
        "model": anthropic_response.get("model"),
        "provider": "anthropic",
    }
    if dev_id is not None:
        entry["dev_id"] = dev_id
    return json.dumps(entry, ensure_ascii=False)

# Example: collect from request session
responses = []  # populated from your API client
out_lines = [
    anthropic_to_engram_counter_line(r, query_id=f"q_{i:04d}", workload="refactor")
    for i, r in enumerate(responses, start=1)
]
with open("baseline.jsonl", "w") as f:
    f.write("\n".join(out_lines) + "\n")
```

---

## 2. Claude Code CLI session → JSONL

Claude Code logs sessions in `~/.claude/projects/<encoded-path>/<session-id>.jsonl`. Each line is a JSON object with `message` containing usage data on assistant turns:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-7",
    "usage": {
      "input_tokens": 12450,
      "output_tokens": 380,
      "cache_creation_input_tokens": 8500,
      "cache_read_input_tokens": 5200
    }
  },
  "timestamp": "2026-05-21T12:34:56.789Z",
  "sessionId": "abc-123",
  "cwd": "/Users/foo/myproject"
}
```

**Conversion (Bash + jq):**

```bash
SESSION_LOG="$HOME/.claude/projects/-Users-nicholas-Desktop-Projects-myproject/abc123.jsonl"

jq -c 'select(.type == "assistant" and .message.usage != null) | {
  query_id: (.uuid // .sessionId),
  timestamp: .timestamp,
  tokens_sent: (.message.usage.input_tokens // 0),
  tokens_received: (.message.usage.output_tokens // 0),
  workload: (
    if .cwd | test("test|spec") then "test_writing"
    elif .cwd | test("docs|README") then "doc_lookup"
    else "refactor"
    end
  ),
  model: .message.model,
  provider: "anthropic"
}' "$SESSION_LOG" > baseline.jsonl
```

The `workload` derivation above is a placeholder — you should classify by your team's actual workload taxonomy. Common patterns:

- **By task type** — refactor, feature_add, debug, doc_lookup, test_writing
- **By repo path** — `cwd` contains `test/` → `test_writing`, `docs/` → `doc_lookup`
- **By git branch** — `feature/*` → `feature_add`, `bugfix/*` → `debug`

---

## 3. Claude API Console export → JSONL

The Anthropic Console (console.anthropic.com) exports session data as CSV with columns including `input_tokens`, `output_tokens`, `model`, `created_at`.

**Conversion (Python pandas):**

```python
import json
import pandas as pd

df = pd.read_csv("anthropic-console-export.csv")

with open("baseline.jsonl", "w") as f:
    for i, row in df.iterrows():
        entry = {
            "query_id": f"q_{i+1:04d}",
            "timestamp": row["created_at"],
            "tokens_sent": int(row["input_tokens"]),
            "tokens_received": int(row["output_tokens"]),
            "workload": classify_workload(row),  # your function
            "model": row["model"],
            "provider": "anthropic",
        }
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
```

---

## 4. Cache token handling (CRITICAL for accurate savings)

Anthropic's cache pricing is nuanced:

- `input_tokens` includes the FULL input (cache hits + cache writes + non-cached)
- `cache_creation_input_tokens` is billed at a different rate (cache writes)
- `cache_read_input_tokens` is billed at ~10% of normal rate (cache reads)

**For engram-counter, choose ONE billing methodology and stick with it across baseline + active:**

### Option A: Raw token comparison (simple, default)

Treat all input_tokens equally. saved_pct reflects RAW token reduction.

```python
tokens_sent = usage["input_tokens"]  # includes cache reads + writes + non-cached
```

### Option B: Effective billed cost (more accurate $-savings)

Weight tokens by their actual cost:

```python
# Approximate Anthropic Sonnet pricing (verify current rates):
RATE_NORMAL = 3.0  # $/M input tokens (uncached)
RATE_CACHE_WRITE = 3.75  # $/M (25% premium)
RATE_CACHE_READ = 0.30  # $/M (90% discount)

non_cached = usage["input_tokens"] - usage.get("cache_creation_input_tokens", 0) - usage.get("cache_read_input_tokens", 0)
effective_tokens = (
    non_cached  # billed at normal rate; representative
    + usage.get("cache_creation_input_tokens", 0) * (RATE_CACHE_WRITE / RATE_NORMAL)
    + usage.get("cache_read_input_tokens", 0) * (RATE_CACHE_READ / RATE_NORMAL)
)
tokens_sent = int(effective_tokens)
```

**For procurement audit purposes, document which option you chose** in the audit metadata or methodology appendix.

---

## 5. Pairing baseline ↔ active queries

For engram-counter to detect savings, the SAME query_id must appear in BOTH baseline AND active. Common pairing strategies:

### 5.1 Same input → run twice

Most rigorous. Capture the same prompt with engram OFF, then with engram ON:

```python
baseline_response = client.messages.create(model=..., messages=[same_prompt])
active_response = engram_enabled_client.messages.create(model=..., messages=[same_prompt])

# Both share query_id derived from the prompt hash:
query_id = hashlib.sha256(json.dumps(same_prompt).encode()).hexdigest()[:16]
```

### 5.2 A/B by week

Less rigorous but operationally simpler. Capture week 1 with engram OFF, week 2 with engram ON. query_id matches by activity hash within each week.

### 5.3 Shadow capture

Most operationally complex. engram-enabled production captures BOTH the engram-pruned context AND the would-have-been full context (shadow). query_id = production request ID.

For procurement audits, document your pairing strategy in the audit methodology appendix.

---

## 6. Validation checklist

Before submitting the JSONL to engram-counter, verify:

- [ ] Every line is a valid JSON object (one per line)
- [ ] No blank lines (parser skips them but document anyway)
- [ ] `query_id` strings are stable across baseline ↔ active
- [ ] `tokens_sent` + `tokens_received` are non-negative integers ≤ `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991)
- [ ] `timestamp` is ISO-8601
- [ ] `workload` is set on >99% of entries (else fail-closed fingerprint triggers)
- [ ] File is UTF-8 (BOM optional — multi-strip handles it)
- [ ] Same total `query_id` set in baseline ↔ active for clean fingerprint match

**Sanity check before audit:**

```bash
jq -c '[.query_id, .tokens_sent, .tokens_received, .workload]' baseline.jsonl | head
jq '.workload' baseline.jsonl | sort | uniq -c
wc -l baseline.jsonl active.jsonl
```

---

## 7. Common pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| `fingerprint_match: false`, reason `set_mismatch` | query_id sets differ between baseline + active | Verify pairing strategy; check for missing queries |
| `fingerprint_match: null`, reason `workload_field_absent` | `workload` missing on >1% of entries | Classify ALL queries (don't leave blank) |
| `parser_limit_exceeded` warnings | Some lines exceed 1MB or have >64 fields | Inspect the offending line: `awk 'length > 100000 {print NR}' baseline.jsonl` |
| `negative_token_clamped` warnings | tokens_sent or tokens_received < 0 | API response had cache-related negative; check provider docs |
| Exit code 6 with `matched_queries: 0` | Empty input | Run sanity check above; verify file paths |
| `binary_sha256` differs across machines | Different engram-counter version OR tampered dist/ | Pin `engram-counter@X.Y.Z`; verify Sigstore attestation |

---

## See also

- `docs/log-conversion/openai.md` — OpenAI provider recipe
- `docs/methodology.md` — engram-counter algorithm + threat model
- `bench/100q-summary.md` — flagship benchmark + reproducibility instructions
- `schemas/ingestion-contract-v1.schema.json` — frozen JSON Schema
