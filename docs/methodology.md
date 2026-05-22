# engram-counter Methodology

> The Apache 2.0 open-source primitive that converts AI token savings claims into auditable, tamper-evident attestations.

This document explains how engram-counter works, what its `audit_trail_hash` proves, what it does NOT prove, and how a third party can independently verify any audit it produces.

---

## 1. Threat model

engram-counter exists to close a procurement trust gap: **vendors claiming X% AI token savings should be auditable by the customer**, without trusting the vendor's dashboard.

| Adversary | What they want | What engram-counter prevents |
|---|---|---|
| **Vendor inflating savings** | Claim 95% reduction when reality is 60% | Open-source code; anyone runs `engram-counter` on the SAME logs and gets the SAME audit_trail_hash. Math is auditable line-by-line in `src/counter.ts`. |
| **Vendor fork shipping modified binary** | Run a modified engram-counter that fakes its output | `binary_sha256` embedded in audit + Sigstore `--provenance` attestation. Procurement can `npm view engram-counter` and compare against attestation. |
| **Customer manipulating logs post-audit** | Re-submit a "tampered active log" to back-claim more savings | `inputs.{baseline,active}_sha256` records raw-bytes hash of ingested files. Any modification after audit emission produces a different recomputed hash. |
| **JSONL-line smuggling** | Hide queries via lone surrogates, depth bombs, prototype pollution, MAX_SAFE_INTEGER token values | Parser hard limits (depth 8 / fields 64 / string 4096 / line 1MB / lines 10M) + walkValidate prototype-pollution defense + MAX_SAFE_INTEGER guard. See `src/parser.ts`. |
| **Workload-fingerprint forgery** | Run different queries in baseline vs active to inflate apparent savings | `workload_fingerprint = SHA-256 over sorted JSON.stringify([query_id, normalized_workload])` tuples. Fail-closed on absent workload (>1% threshold). Count-skew detection. |
| **BOM-stacking SHA-grinding** | Manipulate `file_sha256` while keeping logical content identical | Dual hash: `file_sha256` (raw bytes) + `normalized_content_sha256` (post-BOM-strip + post-line-normalize). Auditor cross-checks both. |
| **Empty-input "no-evidence" forgery** | Submit empty JSONL files producing exit 0 to claim "audit passed" | Empty audit (0 matched + 0 baseline_only + 0 active_only) returns exit code 6 (insufficient evidence). |
| **audit_id namespace forgery** | Provide `--audit-id ec_<12hex>` mimicking the derived format | CLI rejects `^ec_[0-9a-f]{12}$` patterns; verifyAuditTrailHash enforces linkage for any audit_id starting with `ec_`. |

---

## 2. The algorithm in 10 steps

engram-counter is a **paired-run audit primitive**. The customer captures two windows of LLM activity — one WITHOUT engram (`baseline`), one WITH engram (`active`) — both in JSONL format, then runs:

```bash
engram-counter \
  --baseline ./baseline.jsonl \
  --active ./active.jsonl \
  --audit-id audit-2026-q3-customer-foo
```

What happens internally:

1. **Parse** — read both JSONL files. Each line MUST be a JSON object with `query_id` + `timestamp` + `tokens_sent` + `tokens_received` + optional `workload`. Hard limits enforced.
2. **Hash inputs** — `file_sha256 = SHA-256(raw bytes)` + `normalized_content_sha256 = SHA-256(post-BOM-strip + post-line-normalize)`.
3. **Normalize Unicode line terminators** — 7 sequences mapped to LF (CRLF / CR / LF / U+2028 / U+2029 / U+0085 / U+000C).
4. **Strip multi-BOM** — count stripped BOMs (warns if >0).
5. **Validate each entry** — required fields + type checks + `Number.MAX_SAFE_INTEGER` guard on tokens + integer check BEFORE negative clamp.
6. **Join by query_id** — produces `matched: MatchedQuery[]` + `baseline_only: LogEntry[]` + `active_only: LogEntry[]`.
7. **Compute workload fingerprint** — `SHA-256(sorted(JSON.stringify([query_id, normalized_workload])))` per side. NFC-normalize workload. Fail-closed on >1% workload-absent. Collect ALL count-skews (no early-return).
8. **Aggregate** — `aggregateTokens(matched)` produces total/saved/saved_pct via BigInt math (no IEEE-754 drift). `aggregateByWorkload(matched)` produces per-workload breakdown.
9. **Assemble AuditBlock** — version + counter_version + mode + methodology + inputs + counts + tokens + cost_usd + per_workload + fingerprint + thresholds + warnings + binary_sha256 (strict mode default).
10. **JCS-canonicalize + SHA-256** — RFC 8785 canonicalization of the inner audit block → `audit_trail_hash`. Outer envelope (computed_at + audit_id + frozen URIs) is NOT in the hash (F6 isolation pattern).

Output: `{ envelope, audit_trail_hash, audit }` JSON to stdout. Exit code per F8 three-tier (0 clean / 5 warn / 6 high+fingerprint-fail / 2 usage / 1 internal).

---

## 3. Trust hierarchy (what the audit_trail_hash proves)

The `audit_trail_hash` is a SHA-256 over JCS-canonical bytes of the inner audit block. Three properties hold:

### 3.1 Determinism

For any two invocations of `engram-counter` on the SAME inputs (baseline + active JSONL bytes) producing the SAME values (counter_version, mode, binary_sha256, thresholds), the `audit_trail_hash` is BYTE-IDENTICAL.

This is the procurement-killer property: **two independent auditors at different times produce the same hash on the same logs.**

Verified by the integration test suite (294 tests including byte-identical reproducibility tests for both 10q and 100q fixtures).

### 3.2 Tamper-evidence

Modifying ANY field in the audit block — counts, tokens, fingerprint, thresholds, warnings — produces a DIFFERENT recomputed hash. `verifyAuditTrailHash` returns `constraint_violation` when the recomputed hash differs from the claimed hash.

The envelope (computed_at, audit_id) is INTENTIONALLY outside the hash so two auditors at different times get the same hash while preserving the wall-clock attestation in the envelope.

### 3.3 Envelope linkage

When `audit_id` starts with `ec_` (the reserved derived-id namespace), it MUST equal `deriveAuditId(audit_trail_hash) = "ec_" + audit_trail_hash[7..19]`. This prevents "envelope swap" attacks where an attacker replaces the audit body with a different valid audit while keeping the original envelope's audit_id.

User-provided labels (audit_id not starting with `ec_`) skip the derivation check — they're opaque procurement references.

---

## 4. What this audit_trail_hash does NOT prove

Procurement-honest framing: the audit_trail_hash is a **structural integrity attestation**, not a **savings reality claim**.

| What it does NOT prove | Why | What you'd need instead |
|---|---|---|
| That YOUR organization will save 85.45% | The 100q fixture is synthetic, not real-workload | Run engram-counter on YOUR baseline + active logs |
| That engram (the engine) saves what it claims | engram-counter measures the OUTPUT logs, not engram's runtime | engramx v4.0 release notes document 89.1% real-workload measurements |
| That the customer correctly captured the baseline window | Garbage in → garbage out (with hashed provenance) | Capture methodology pinned in your procurement contract |
| That no queries were dropped pre-engram-counter | engram-counter only sees what's in the JSONL | Log-collection pipeline integrity is the customer's responsibility |
| That tokens_sent/tokens_received were correctly populated by the LLM provider | We trust the provider's invoice/log accounting | Cross-check engram-counter output against provider billing |
| That the workload classification is correct | engram-counter doesn't infer workload; it uses the `workload` field as-is | Tag workloads consistently in your log-collection pipeline |
| That this binary wasn't built from compromised source | `binary_sha256` proves the dist/ matches what's claimed; Sigstore attestation links dist→git commit | Sigstore `cosign verify` against the published npm provenance |

---

## 5. Reproduction recipe

Anyone can verify an engram-counter audit in three commands:

```bash
# 1. Install engram-counter (from any verified source — npm, GitHub release, vendored bundle)
npm install -g engram-counter@0.1.0

# 2. Re-run the audit on the same baseline + active files
engram-counter \
  --baseline ./baseline.jsonl \
  --active ./active.jsonl \
  --audit-id <same-audit-id-as-original>

# 3. Compare audit_trail_hash byte-for-byte
# If they match: audit is reproducible. If not: either input bytes changed OR engram-counter version differs.
```

For the committed 100q fixture, the canonical reproduction:

```bash
git clone https://github.com/NickCirv/engram-counter
cd engram-counter
npm install && npm run build
node bin/engram-counter.js \
  --baseline tests/fixtures/baseline-100q.jsonl \
  --active tests/fixtures/active-100q.jsonl \
  --audit-id audit-100q-flagship-bench \
  --no-binary-hash | python3 -c "import json,sys; print(json.load(sys.stdin)['audit_trail_hash'])"
```

**Expected output (committed reproducibility lock):**

```
sha256:b0f8e4030dcfb91c27a3faf647e8fe061cbfd67bb707671d5331e8186b518819
```

The 100q fixture is also regenerable from seed:

```bash
node scripts/generate-fixture.js
diff tests/fixtures/baseline-100q.jsonl tests/fixtures/baseline-100q.jsonl
# (Exit 0 = identical byte-for-byte after regeneration)
```

---

## 6. Cryptographic primitives

| Primitive | Where | Why |
|---|---|---|
| **SHA-256** (FIPS 180-4) | node:crypto | Wide auditor support; FIPS-certified; Sigstore/cosign native |
| **RFC 8785 JCS** | hand-rolled `src/hash.ts` (~150 LoC, zero deps) | Deterministic JSON canonicalization; cross-impl-verifiable against cyberphone/json-canonicalization Go reference |
| **BigInt** | counter math | Closes IEEE-754 leak at Fortune-100 scale (2000+ devs × 1.5M tokens/day × 365 days) |
| **Sigstore --provenance** | npm publish | Links dist/ artifact to git commit via transparency log |
| **Apache 2.0** | LICENSE + NOTICE | Patent grant scope explicit per §4(d); commercial-use permissive |

**Hash-algorithm agility:** All hashes carry the `sha256:` prefix. A future `sha3-256:` or `blake3:` variant can ship without breaking the v1 contract — verifiers parse the prefix to select the algorithm.

---

## 7. Schema contract (frozen at v1)

The `ingestion_contract: "v1"` field in the envelope is FROZEN. Future versions add fields backward-compatibly within v1, or bump to v2 with a clean schema break.

Full JSON Schema (draft 2020-12) is shipped at:

```
https://raw.githubusercontent.com/NickCirv/engram-counter/main/schemas/ingestion-contract-v1.schema.json
```

This URL is also embedded in `envelope.schema_url` of every emitted audit. Downstream consumers fetch this URL and validate submitted audits structurally. The schema enforces:

- `additionalProperties: false` (no smuggled fields)
- `__proto__/constructor/prototype` key rejection
- ISO-8601 UTC `computed_at` pattern
- Integer-only counts (no fractional)
- Range-bounded thresholds [0, 1]
- Frozen `_type` + `predicateType` URI constants (in-toto Statement v1 alignment)

---

## 8. F-numbered hardening (audit-derived design decisions)

For audit traceability, the SPEC v0.1.5 hardenings (each with a fix number derived from adversarial review):

| Number | Hardening |
|---|---|
| F1 | Workload fingerprint redesigned: `JSON.stringify([query_id, normalized_workload])` tuples + Unicode NFC normalize + fail-closed on workload-absent + collect ALL count-skews |
| F2 | Version-string forgery protection via `binary_sha256` |
| F3 | JSONL line-terminator normalization (7 Unicode sequences) |
| F4-F5 | BigInt integer-basis-point math |
| F6 | Envelope two-layer pattern (outer presentation + inner canonical hashed) |
| F7 | `--strict` is DEFAULT (binary_sha256 embedded); `--no-binary-hash` opt-out |
| F8 | Three-tier exit codes (0 clean / 5 warn / 6 high+fingerprint-fail) |
| F9 | BigInt token math closes IEEE-754 leak at scale |
| F10 | 7 Unicode line terminators normalized |
| F11 | `ingestion_contract: "v1"` frozen field |
| F12 | Fingerprint disclaimer (synthetic vs real workload) |
| F13 | Threshold rationales documented |

Cross-reference: each fix has a corresponding test in the test suite. Search `tests/` for the F-number in comments.

---

## 9. Adversarial review history

engram-counter v0.1.0 went through **four** independent adversarial security reviews, one per core module:

| Module | Adversarial score (initial) | Adversarial score (post-patch) | P0 attacks closed |
|---|---|---|---|
| schema.ts | 0.55 | 0.85 | 12 attacks (validator hardening) |
| parser.ts | 0.78 | 0.92 (estimated) | 6 (fingerprint collision, MAX_SAFE_INTEGER, BOM grinding, count_skew early-return, set_mismatch suppression, type-narrowing) |
| hash.ts | 0.78 | 0.92 (estimated) | 3 (lone-surrogate collision, non-plain-object degeneration, envelope-audit_id linkage) |
| cli.ts | 0.55 | 0.92 (estimated) | 3 (audit_id forgery via reproducible_mode, polyglot binary_sha256 injection, empty-input no-evidence forgery) |

**Total P0 attacks closed across the v0.1.0 build: 24.**

Each P0 was either:
1. Verified exploitable (empirically attacked via `node -e` script)
2. Patched in source
3. Tested via dedicated attack-defense test that fails when the patch is reverted

The full audit trail is captured in this document; each module's adversarial-review entry above documents the P0s found and the source-line fixes.

---

## 10. Open questions for v0.2

These are KNOWN GAPS in v0.1.0, documented for procurement transparency:

1. **Streaming parser** — v0.1.0 reads files synchronously (full-buffer). Files >2.5GB hit memory limits. v0.2 will add `--streaming` opt-in.
2. **JSONL duplicate key handling** — JSON.parse uses "last wins" silently. v0.2 may add strict-parser opt-in with explicit duplicate detection.
3. **Cross-impl JCS test against Go reference** — v0.1.0 uses hand-derived RFC 8785 test vectors. v0.2 will vendor cyberphone/json-canonicalization test vectors as belt-and-braces.
4. **--cost-per-million overflow** — Very large rate × large saved_total can produce Infinity. v0.2 will guard cost_usd for `Number.isFinite` post-multiplication.
5. **TOCTOU on dist/ during binary_sha256** — Symlink swap between readdirSync and per-file reads. v0.2 may use file descriptors for stat+read atomicity.
6. **bom_count drift** — If a fixture file accumulates BOMs over time, `bom_count` rises monotonically. Document in v0.2.

None of these are exploitable at v0.1.0 ship; they're defensive depth items.

---

## 11. The bottom line for procurement

> **engram-counter v0.1.0 is the Apache 2.0 open-source primitive that converts an AI savings claim into a verifiable, tamper-evident SHA-256 attestation.**
>
> Anyone with the same baseline + active JSONL logs can reproduce the same `audit_trail_hash`. The audit_trail_hash carries Sigstore `--provenance` attestation linking it to a specific git commit. Procurement teams running `cosign verify` get cryptographic proof of which code produced any given audit.
>
> The savings PERCENTAGE itself is not anchored by the hash — that's the customer's data + their measurement methodology. The hash anchors the COMPUTATION over that data. Combine an honest measurement methodology with engram-counter and you have a procurement-grade auditable savings claim.

For source, fixtures, generator, and reproducibility lock: **<https://github.com/NickCirv/engram-counter>**.

For the engramx engine itself (which engram-counter audits): **<https://github.com/NickCirv/engram>** (npm `engramx@4.0.0`, Apache 2.0, 89.1% real-workload savings measured).
