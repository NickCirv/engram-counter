# OpenAI → engram-counter JSONL conversion

Recipe for converting OpenAI API logs (Chat Completions, Responses API, Assistants v2, or Usage API exports) into the JSONL format engram-counter expects.

## Target schema

Same as for Anthropic. See `docs/log-conversion/anthropic.md` §1 for the full field list.

---

## 1. Chat Completions / Responses API → JSONL

OpenAI's `/v1/chat/completions` and `/v1/responses` endpoints return usage data:

```json
{
  "id": "chatcmpl-abc...",
  "object": "chat.completion",
  "model": "gpt-4o-2024-08-06",
  "usage": {
    "prompt_tokens": 12450,
    "completion_tokens": 380,
    "total_tokens": 12830,
    "prompt_tokens_details": {
      "cached_tokens": 5200
    }
  }
}
```

**Conversion (Python):**

```python
import json
from datetime import datetime, timezone

def openai_to_engram_counter_line(openai_response, query_id, workload, dev_id=None):
    """
    Convert an OpenAI Chat Completions response to one JSONL line.

    Note: prompt_tokens INCLUDES cached_tokens. OpenAI bills cached at 50%.
    For raw-token savings comparison, use prompt_tokens as-is.
    """
    usage = openai_response.get("usage", {})
    entry = {
        "query_id": query_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "tokens_sent": int(usage.get("prompt_tokens", 0)),
        "tokens_received": int(usage.get("completion_tokens", 0)),
        "workload": workload,
        "model": openai_response.get("model"),
        "provider": "openai",
    }
    if dev_id is not None:
        entry["dev_id"] = dev_id
    return json.dumps(entry, ensure_ascii=False)
```

---

## 2. Assistants API v2 → JSONL

The Assistants API records usage per run via `/v1/threads/{thread_id}/runs/{run_id}`:

```json
{
  "id": "run_abc...",
  "object": "thread.run",
  "model": "gpt-4o",
  "usage": {
    "prompt_tokens": 18500,
    "completion_tokens": 612,
    "total_tokens": 19112
  }
}
```

**Conversion (Python):**

```python
from openai import OpenAI

client = OpenAI()
runs = client.beta.threads.runs.list(thread_id="thread_xyz", limit=100)

out_lines = []
for i, run in enumerate(runs.data, start=1):
    if run.usage is None:
        continue
    entry = {
        "query_id": run.id,  # OpenAI run IDs are stable
        "timestamp": run.created_at,
        "tokens_sent": run.usage.prompt_tokens,
        "tokens_received": run.usage.completion_tokens,
        "workload": "assistant_task",
        "model": run.model,
        "provider": "openai",
    }
    out_lines.append(json.dumps(entry, ensure_ascii=False))

with open("baseline.jsonl", "w") as f:
    f.write("\n".join(out_lines) + "\n")
```

---

## 3. Usage API export → JSONL

The OpenAI Usage API (`/v1/organization/usage/completions`) provides bulk historical usage:

```bash
curl https://api.openai.com/v1/organization/usage/completions?start_time=1714521600&bucket_width=1d \
  -H "Authorization: Bearer $OPENAI_ADMIN_KEY" \
  | jq '.data[].results[] | {
      query_id: .input_tokens_buckets[0].timestamp | tostring,
      timestamp: (.input_tokens_buckets[0].timestamp * 1000 | strftime("%Y-%m-%dT%H:%M:%S.000Z")),
      tokens_sent: .input_tokens,
      tokens_received: .output_tokens,
      workload: "aggregate",
      model: .model,
      provider: "openai"
    }' > baseline.jsonl
```

**Caveat:** the Usage API aggregates by bucket (e.g., daily). Each line represents a bucket, not a single query. For per-query audit precision, use the Chat Completions logs directly.

---

## 4. Reasoning tokens (o-series models)

OpenAI's o-series models (`o1`, `o3`, `o3-mini`) include reasoning tokens in the response:

```json
{
  "usage": {
    "prompt_tokens": 850,
    "completion_tokens": 2300,
    "total_tokens": 3150,
    "completion_tokens_details": {
      "reasoning_tokens": 1800
    }
  }
}
```

**For procurement-grade auditing, decide whether reasoning tokens count toward `tokens_received`:**

- **Option A — Total response tokens** — `tokens_received = completion_tokens` (includes reasoning)
- **Option B — Visible output only** — `tokens_received = completion_tokens - reasoning_tokens`

Option A reflects what you're BILLED. Option B reflects what you SEE. Document the choice in your methodology appendix.

```python
# Option A (billed view, recommended for cost-oriented audits):
tokens_received = int(usage["completion_tokens"])

# Option B (visible output only):
reasoning = usage.get("completion_tokens_details", {}).get("reasoning_tokens", 0)
tokens_received = int(usage["completion_tokens"] - reasoning)
```

---

## 5. Cached input tokens (50% billed)

OpenAI caches input contexts >1024 tokens for ~5-10 minutes. Cached tokens are billed at 50%:

```json
{
  "usage": {
    "prompt_tokens": 12450,
    "completion_tokens": 380,
    "prompt_tokens_details": {
      "cached_tokens": 5200
    }
  }
}
```

### Option A: Raw token comparison (simple)

```python
tokens_sent = usage["prompt_tokens"]  # includes cached tokens
```

### Option B: Effective billed cost

```python
RATE_PROMPT = 2.50  # $/M (gpt-4o typical)
RATE_CACHED = 1.25  # $/M (50% of prompt rate)

cached = usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
non_cached = usage["prompt_tokens"] - cached
effective_tokens = non_cached + cached * 0.5  # weight cached at 50%
tokens_sent = int(effective_tokens)
```

**Critical for procurement consistency:** baseline AND active must use the SAME methodology. Document the choice in the audit appendix.

---

## 6. Pairing baseline ↔ active (OpenAI specifics)

OpenAI's stable identifiers:

- Chat Completions: `id` field (e.g., `chatcmpl-abc...`)
- Responses: `id` field (e.g., `resp_abc...`)
- Assistants Runs: `run.id`

For paired-run audits with the SAME prompt twice, derive `query_id` from prompt content rather than OpenAI's response ID (which is unique per call):

```python
import hashlib

def stable_query_id(messages):
    """Stable query_id for paired runs — derived from prompt content, not API response ID."""
    canonical = json.dumps(messages, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]
```

---

## 7. Workload classification

OpenAI usage logs don't carry workload metadata — you must classify externally. Common approaches:

### Approach A: Tag at request time

```python
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "..."}],
    extra_headers={"X-Engram-Workload": "refactor"}  # custom header
)
# Store the header value alongside the response.id for later JSONL emission.
```

### Approach B: Tag from repo path / cwd

If the OpenAI calls originate from your IDE / Claude Code / etc., the originating repo path is a workload proxy:

```python
def classify_workload(cwd: str) -> str:
    if "test" in cwd or "spec" in cwd:
        return "test_writing"
    if "docs" in cwd or "README" in cwd:
        return "doc_lookup"
    if "fix-" in cwd or "bug-" in cwd:
        return "debug"
    return "refactor"
```

### Approach C: Tag from git branch

```python
import subprocess

def classify_workload_from_branch() -> str:
    branch = subprocess.check_output(["git", "branch", "--show-current"]).decode().strip()
    if branch.startswith("feature/"): return "feature_add"
    if branch.startswith("bugfix/"): return "debug"
    if branch.startswith("docs/"): return "doc_lookup"
    return "refactor"
```

---

## 8. Validation checklist

Same as Anthropic — see `docs/log-conversion/anthropic.md` §6. Additionally:

- [ ] If using reasoning models (o-series), decide and document Option A vs Option B
- [ ] If using cached tokens, decide and document Option A vs Option B for billing-effective view
- [ ] Verify `prompt_tokens` ≥ `cached_tokens` (sanity check — cached should never exceed prompt)

```bash
# OpenAI-specific sanity: prompt_tokens >= cached_tokens
jq -c 'select((.prompt_tokens // 0) < (.cached_tokens // 0))' baseline.jsonl
# Empty output = all entries consistent.
```

---

## 9. Common OpenAI-specific pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Very high `tokens_received` on o1/o3 runs | Reasoning tokens included | Choose Option A vs B explicitly per §4 |
| `tokens_sent` differs between two identical prompts | Caching kicked in on second call | Use Option B for billing-effective view, OR run baseline + active back-to-back to keep cache state consistent |
| `query_id` not stable across paired runs | Using `chatcmpl-*` IDs (unique per call) | Derive from prompt hash per §6 |
| Workload column missing | OpenAI doesn't capture workload | Classify externally per §7 |
| `total_tokens` ≠ `prompt_tokens + completion_tokens` (o-series) | Reasoning tokens not in completion_tokens | This is normal — reasoning is BILLED via completion_tokens for o-series |

---

## See also

- `docs/log-conversion/anthropic.md` — Anthropic provider recipe
- `docs/methodology.md` — engram-counter algorithm + threat model
- `bench/100q-summary.md` — flagship benchmark
- `schemas/ingestion-contract-v1.schema.json` — frozen JSON Schema
