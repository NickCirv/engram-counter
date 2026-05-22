# engram-counter

> **Audit AI token savings yourself. Apache 2.0. Zero runtime dependencies. Tamper-evident.**

`engram-counter` is the open-source primitive that converts AI savings claims into JCS-canonicalized SHA-256 attestations. Take two log files. Diff them. Get an `audit_trail_hash` your finance team can independently reproduce.

If you're evaluating an enterprise contract that quotes a savings percentage, this is the tool that lets you check the number yourself, on your own machine, without trusting anyone's dashboard.

---

## Flagship benchmark (reproducible)

On the committed 100-query fixture (`tests/fixtures/baseline-100q.jsonl` + `active-100q.jsonl`):

| Metric | Value |
|---|---|
| **saved_pct** | **85.45%** (honest non-round; SYNTHETIC fixture) |
| baseline_total | 2,679,451 tokens |
| active_total | 389,833 tokens |
| saved_total | 2,289,618 tokens |
| matched_queries | 100 / 100 (full overlap) |
| fingerprint_match | true |
| **audit_trail_hash** | `sha256:b0f8e4030dcfb91c27a3faf647e8fe061cbfd67bb707671d5331e8186b518819` |

Cost projection at $5/M tokens (Anthropic Sonnet typical): **$11.45 saved per session** → **~$418K/year at 100-dev daily scale**.

Verify it yourself in three commands — see `bench/100q-summary.md`.

> **Procurement honesty:** the 100q fixture is SYNTHETIC. engramx v4.0 measured 89.1% on REAL workloads (documented in v4.0 release notes). The 100q fixture verifies engram-counter's correct behavior, NOT engram's real-world savings.

---

## What it does

`engram-counter audit --baseline baseline.jsonl --active active.jsonl` produces a deterministic JSON output containing:

- Per-query, per-workload, and aggregate token savings
- SHA-256 hashes of both input files (over raw bytes)
- A canonical `audit_trail_hash` over the audit data (JCS-canonicalized, RFC 8785)
- Workload-fingerprint cross-check (detects baseline/active workload mismatches)
- Optional cost projection in USD

The output is independently verifiable. Re-run the same inputs on a different machine, get the same hash. If the hash differs from what was published, the data was tampered with.

---

## Why it exists

EngramX claims 89.1% token reduction. That number means nothing if no one can check it.

The conventional way to audit a vendor's savings claim is to ingest your data into the vendor's dashboard and trust their math. `engram-counter` inverts this: the math is open source, the tool runs on your machine, and the output is cryptographically verifiable against the inputs you control.

This is the Sigstore-grade trust model applied to cost attestation. Same canonicalization standard (RFC 8785). Same hash chain pattern as in-toto, CycloneDX, and Sigstore Bundle.

---

## Install

```bash
npx engram-counter@latest --baseline baseline.jsonl --active active.jsonl
```

Or install globally:

```bash
npm install -g engram-counter
engram-counter --baseline baseline.jsonl --active active.jsonl
```

Requires Node.js ≥20.18.0. Zero runtime dependencies.

---

## Compile from source (recommended for procurement audits)

For maximum trust, do not use the npm artifact. Compile from source:

```bash
git clone https://github.com/NickCirv/engram-counter
cd engram-counter
git checkout v0.1.0   # or the specific tag you want to audit
npm ci
npm run build
./bin/engram-counter audit --baseline baseline.jsonl --active active.jsonl
```

Every published release also includes:

- npm `--provenance` attestation (Sigstore signature linking the npm artifact to the GitHub Actions run that built it)
- The exact SHA-256 of `bin/engram-counter.js` published in the GitHub Release notes
- An `--strict` mode that includes the binary SHA-256 in the audit hash, so the audit attests to the specific binary version that ran

If a published binary's SHA-256 does not match the one in the release notes, the npm artifact has been tampered with.

---

## Generating compatible logs

`engram-counter` takes two JSONL files. Each line is one LLM call event:

```json
{"query_id": "q_abc123", "timestamp": "2026-05-21T10:00:00Z", "tokens_sent": 12345, "tokens_received": 678, "workload": "refactor"}
```

Required fields: `query_id`, `timestamp`, `tokens_sent`, `tokens_received`.
Optional fields: `workload`, `model`, `provider`, `dev_id`, `metadata`.

### Generating `query_id`

`query_id` is the JOIN KEY between baseline and active logs. The customer is responsible for generating stable IDs that correlate the same logical query across both runs.

Recommended:

```js
query_id = sha256(prompt_text + dev_id + iso_date_bucket).slice(0, 16)
```

Same prompt + same developer + same hour bucket = same `query_id` across both runs.

### Converting LLM provider logs

- **Anthropic Claude API logs** → [`docs/log-conversion/anthropic.md`](./docs/log-conversion/anthropic.md) — covers Claude API direct, Claude Code session logs, Console exports, cache token handling
- **OpenAI API logs** → [`docs/log-conversion/openai.md`](./docs/log-conversion/openai.md) — covers Chat Completions, Responses API, Assistants v2, reasoning tokens (o-series), cache tokens (50% billed)

Both recipes ship in v0.1.0 with Python + Bash code snippets.

---

## Sample run (real output from committed 100q fixture)

```bash
$ engram-counter \
    --baseline tests/fixtures/baseline-100q.jsonl \
    --active tests/fixtures/active-100q.jsonl \
    --audit-id audit-100q-flagship-bench \
    --cost-per-million 5 \
    --no-binary-hash > audit.json

$ jq '{
    saved_pct: .audit.tokens.saved_pct,
    matched: .audit.counts.matched_queries,
    cost_usd: .audit.cost_usd,
    fingerprint: .audit.fingerprint.fingerprint_match,
    hash: .audit_trail_hash
  }' audit.json

{
  "saved_pct": 85.45,
  "matched": 100,
  "cost_usd": 11.4481,
  "fingerprint": true,
  "hash": "sha256:b0f8e4030dcfb91c27a3faf647e8fe061cbfd67bb707671d5331e8186b518819"
}
```

Share `audit.json` with your finance team. They can verify it programmatically via the library:

```js
const { verifyAuditTrailHash } = require("engram-counter");
const audit = JSON.parse(fs.readFileSync("audit.json"));
const result = verifyAuditTrailHash(audit);
if (!result.ok) throw new Error(result.error.message);
```

Or re-run engram-counter with the same inputs and `diff` the `audit_trail_hash` field. Identical hash = audit is reproducible.

**Exit codes (per SPEC F8):**

- `0` — clean audit (mismatch ≤ warn threshold)
- `5` — partial audit warning (warn < mismatch ≤ high)
- `6` — failed audit (mismatch > high OR fingerprint fail-closed OR empty input)
- `2` — usage error (invalid argv)
- `1` — internal error

---

## What this tool does NOT prove (honest disclosure)

A matching workload fingerprint proves only that baseline and active logs contain the same logical workload set. It does **NOT** prove that the token counts within those logs are truthful. Auditing token-count honesty requires:

- **(a) Vendor cross-validation against LLM-provider invoices** — Anthropic / OpenAI billing reconciliation. This belongs to the procurement-workflow layer, not the math primitive, and is not part of v0.1.0.
- **(b) Third-party-controlled log generation** — procurement-mode pilots where the customer's CI generates both logs under conditions the vendor cannot influence.

`engram-counter v0.1.0` explicitly does **NOT** defend against an attacker who controls both inputs (baseline + active). That defense lives at the procurement-workflow layer, not at the math primitive. Read [SECURITY.md](./SECURITY.md) §"Threat Model" for the complete trust boundary.

## Scope

`engram-counter v0.1.0` is the **math primitive**: it deterministically converts two paired log files into a tamper-evident audit attestation. Submission workflows, billing reconciliation, LLM-provider invoice cross-validation, and multi-party signatures are out of scope for this repository.

## Methodology

`engram-counter` uses **paired-run methodology**:

1. **Baseline pilot.** Customer runs their normal dev workloads WITHOUT engram. LLM provider logs token spend per query.
2. **Engram pilot.** Same customer runs the same workloads WITH engram active. LLM provider logs token spend per query.
3. **Pair queries by `query_id`** across the two log files. Diff tokens.
4. **Aggregate** into per-workload + total savings. Compute `saved_pct` via deterministic integer math (no IEEE-754 drift across Node versions).
5. **Canonicalize** the audit block per RFC 8785 (JCS).
6. **Hash** the canonical bytes with SHA-256. The `audit_trail_hash` is over the inner `audit` object only — `computed_at` lives in the outer `envelope` so the same logical audit produces the same hash regardless of when it ran.

`engram-counter` does NOT instrument engramx, does NOT call cloud services, does NOT phone home. It is a pure math primitive over local files.

### Reproducibility caveat (line endings)

Input file SHA-256 is over RAW BYTES. If you commit logs to git with `\r\n` (CRLF — Windows) on one machine and `\n` (LF — Unix/macOS) on another, the SHA-256 will differ across machines because the byte contents differ. The `audit_trail_hash` over the canonical audit block will still MATCH because the parser normalizes 7 line-terminator sequences (CRLF, CR, LF, U+2028, U+2029, U+0085, U+000C) internally before computing the math. The two SHAs serve different purposes: `inputs.*_sha256` proves "the file you ran on" (byte-exact); `audit_trail_hash` proves "the math is correct" (logical content).

For deterministic procurement re-runs across machines:

- Pass `--audit-id <stable-uuid>` so the `audit_id` is the same across runs
- Compare `audit_trail_hash`, not byte-identical JSON output

---

## Hash-algorithm agility

The `audit_trail_hash` is prefixed `sha256:` intentionally. If SHA-256 ever weakens (post-quantum, future collision finding), a future release can introduce `sha3-256:` or `blake3:` prefixes without breaking existing v0.1 attestations. Procurement re-verification will support both for an explicit deprecation window.

---

## License

Apache 2.0. See `LICENSE`.

Patents: the Apache 2.0 patent grant covers the algorithm and methodology described in this README and `docs/methodology.md`.

---

## Project links

- Repository: [`github.com/NickCirv/engram-counter`](https://github.com/NickCirv/engram-counter)
- npm: `engram-counter` (with `--provenance` attestation from v0.1.0)
- **Methodology deep-dive:** [`docs/methodology.md`](./docs/methodology.md) — algorithm + threat model + reproduction recipe + 24 P0 attacks closed
- **Log conversion recipes:** [`docs/log-conversion/anthropic.md`](./docs/log-conversion/anthropic.md) + [`docs/log-conversion/openai.md`](./docs/log-conversion/openai.md)
- **Flagship benchmark:** [`bench/100q-summary.md`](./bench/100q-summary.md)
- **Frozen JSON Schema:** [`schemas/ingestion-contract-v1.schema.json`](./schemas/ingestion-contract-v1.schema.json)
- Parent project (EngramX): [`github.com/NickCirv/engram`](https://github.com/NickCirv/engram)
- Enterprise: [`cirvgreen.com/engram/enterprise`](https://cirvgreen.com/engram/enterprise)

---

## Status

**v0.1.0 SHIPPED — production-ready.** 294/294 tests passing across 62 suites. 5 source modules (counter/types/schema/parser/hash/cli). Independently security-reviewed per core module + benchmark. 24 P0 attacks closed during build. Two golden hashes locked (10q + 100q fixtures).

Reproducibility verified: triple-run subprocess produces byte-identical `audit_trail_hash` across invocations. The 100q fixture is committed + the deterministic generator script ships in the npm tarball — anyone can regenerate fixtures and recompute hash for procurement-grade verification.

Next: v0.2 streaming parser + cross-impl JCS test against `cyberphone/json-canonicalization` Go reference (defensive depth, no new attack defenses required).
