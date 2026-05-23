# Changelog

All notable changes to `engram-counter` are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-22

First production release. Single squashed commit on `main` (`2e90a93`).

### Added — v0.1.0 ship documentation (2026-05-21)
- `docs/methodology.md` (~250 lines) — procurement-grade methodology document covering:
  - 11-row threat model (vendor inflation / fork modification / customer manipulation / JSONL smuggling / fingerprint forgery / BOM grinding / no-evidence audit / audit_id forgery)
  - 10-step algorithm walkthrough (parse → hash inputs → normalize → strip BOM → validate → join → fingerprint → aggregate → assemble → JCS+SHA-256)
  - 3-property trust hierarchy (determinism, tamper-evidence, envelope linkage)
  - Honest "what this does NOT prove" section (7-row matrix)
  - Reproduction recipe in 3 commands
  - Cryptographic primitives table
  - Schema contract (frozen at v1) reference
  - F-numbered hardening cross-reference (F1-F13)
  - Full adversarial review history (24 P0 attacks closed across 4 independent module reviews)
  - 6 open questions for v0.2 (documented defensive-depth gaps)
- `docs/log-conversion/anthropic.md` (~270 lines) — covers:
  - Claude API direct (`/v1/messages`)
  - Claude Code session log conversion (jq-based)
  - Claude API Console CSV export → JSONL
  - Cache token handling (raw vs effective-billed methodology)
  - Pairing strategies (same input twice / weekly A-B / shadow capture)
  - Validation checklist + common pitfalls
- `docs/log-conversion/openai.md` (~300 lines) — covers:
  - Chat Completions + Responses API
  - Assistants API v2
  - Usage API bulk exports
  - Reasoning token handling (o-series)
  - Cached input tokens (50% billed methodology)
  - Pairing strategy for OpenAI-specific identifiers
  - 3 workload classification approaches (request-time tag / cwd-based / git-branch-based)
  - OpenAI-specific pitfalls table
- `README.md` v0.1.0 update:
  - Removed v0.0.1 scaffold banner
  - Added Flagship Benchmark table with 100q numbers (saved_pct 85.45%, audit_trail_hash sha256:b0f8e4...)
  - Updated install instructions (Node ≥20.18.0, zero deps)
  - Updated sample run output to match REAL CLI output (no more "ships in v0.2" caveats)
  - Updated scope section to reflect v0.1.0 SHIPPED
  - Updated Status footer to "v0.1.0 SHIPPED"
  - Added direct links to docs/methodology.md + log-conversion/*.md + bench/100q-summary.md

### Verified — convergence audit
- 294/294 tests passing (62 suites)
- Typecheck clean (tsc --noEmit exit 0)
- All 9 cross-referenced docs exist and ship in tarball
- npm tarball: 44 files, 79.1KB packed, 308KB unpacked
- Subprocess --help + --version + 10q + 100q + strict mode + cost projection + error paths all work
- Documentation references the canonical CLI hash (sha256:b0f8e4030dcfb91c27a3faf647e8fe061cbfd67bb707671d5331e8186b518819) — committed reproducibility lock

### NEXT TURN — Nick's 2FA publish step
- Bump `package.json` version from `0.0.1` → `0.1.0`
- Run `npm run build && npm test` (final pre-publish triple-audit)
- `git tag v0.1.0 && git push origin v0.1.0`
- `gh release create v0.1.0` with full CHANGELOG body
- `npm publish` via Nick's 2FA → ships with Sigstore --provenance attestation
- `npm view engram-counter@0.1.0` — verify the public registry hash

### Added — flagship 100q benchmark + golden hash + reproducibility (2026-05-21)
- `scripts/generate-fixture.js` — deterministic LCG-seeded fixture generator (SEED=1729, Hardy-Ramanujan). Auditors can rerun to verify byte-identical fixtures.
- `tests/fixtures/baseline-100q.jsonl` + `tests/fixtures/active-100q.jsonl` — committed 100-query paired JSONL across 5 workload categories (refactor 28% / feature_add 24% / debug 22% / doc_lookup 14% / test_writing 12%). Honest non-round saved_pct = **85.45%** (not curated to match engramx v4.0's 89.1% real-workload number).
- `bench/100q-benchmark.json` — full AuditOutput committed as procurement-grade reproducibility artifact (3.4KB).
- `bench/100q-summary.md` — human-readable summary with per-workload breakdown, cost projection ($5/M Anthropic Sonnet rate → $11.45 saved per session, $418K/year at 100-dev scale), reproduction instructions, AND the procurement-honest framing distinguishing engramx measurements from engram-counter verification.
- Integration test `tests/integration.test.ts` extends to 100q: matches all 100 queries, fingerprint across 5 workloads, byte-identical reproducibility, golden hash locked.
- `package.json` `files[]` extended to ship `bench/` + `scripts/generate-fixture.js` in npm tarball.

### Verified — 100q reproducibility contract
- Triple-run subprocess reproducibility: identical `sha256:b0f8e4030dcfb91c27a3faf647e8fe061cbfd67bb707671d5331e8186b518819` for CLI invocation on 100q fixture across 3 invocations.
- Integration test golden hash: `sha256:ab1ba82dd629f275451916c827edf2bdfbb41faab35de44eee5d6dd6ff0240f7` (uses basename file labels — differs from CLI hash because `inputs.baseline_file` is in the audit block).
- Generator regeneration: `cp $FIXTURES /tmp/; node scripts/generate-fixture.js; diff /tmp/ $FIXTURES` — identical.

### Added — cli.ts user-facing surface (2026-05-21)
- `src/cli.ts` (~580 LoC, 0 runtime deps) — the CLI orchestrator:
  - `parseArgv` — hand-rolled long-flags + `-h`/`-V` argv parser, strict allow-list
  - `validateArgs` — required-field + range checks + cross-validation (warn < high)
  - `determineExitCode` — F8 three-tier mapping (0 clean / 5 warn / 6 high+fingerprint-fail)
  - `computeBinarySha256` — F2/F7 supply-chain anchor: hash of `dist/*.js` + `package.json`
  - `runEngramCounter` — full pipeline (parse → join → fingerprint → aggregate → hash → self-verify)
  - `main(io)` — top-level orchestrator with dependency-injected `RuntimeIO`
- `RuntimeIO` interface — argv / cwd / stdout / stderr / exit / distDir / packageJsonPath. Tests inject fakes; production uses `defaultIO()` from process.*
- `tests/cli.test.ts` (NEW, ~400 LoC, 46 tests) — argv parsing edge cases, validateArgs, F8 exit codes, computeBinarySha256 determinism, runEngramCounter E2E via 10q fixture, main(io) with fixture happy path + error paths + --help + --version + --pretty + reproducibility
- `bin/engram-counter.js` — production CommonJS bin stub delegating to `dist/cli.js`
- Updated `src/index.ts` barrel to export cli surface

### Security — cli.ts adversarial security hardenings
Adversarial security review (adversarial 0.55 BLOCK / code-quality 0.88 / earlier verifier). Adversarial found 3 P0s — ALL patched before commit:
- **adv-cli-01 — Forged audit_id via `--audit-id ec_<12hex>`:** The envelope-linkage check was bypassed whenever `reproducible_mode=true`, which the CLI sets whenever `--audit-id` is provided. An attacker passing `--audit-id ec_aaaaaaaaaaaa` forged an audit with a derived-looking ID that verifyAuditTrailHash skipped checking. **Fix:** (a) CLI now rejects `--audit-id` values matching `^ec_[0-9a-f]{12}$` (reserved prefix); (b) hash.ts verifyAuditTrailHash now enforces linkage **regardless of reproducible_mode** whenever `audit_id` starts with `ec_`. User-provided labels (no `ec_` prefix) skip the check as designed.
- **adv-cli-02 — `binary_sha256` only hashed `.js` files** allowing fork to inject `.mjs`/`.cjs`/`.node`/postinstall.sh that Node's module resolution still loads. **Fix:** computeBinarySha256 now hashes ALL regular files in dist/, no extension filter. Polyglot file injection defeated.
- **adv-cli-03 — Empty-input audit silently exited 0** ("no-evidence" forgery): two empty (or non-overlapping) JSONL files produced `saved_total=0` + `fingerprint_match=true` (empty sets equal) + exit 0. Procurement could be fooled into "audit passed" without checking the numbers. **Fix:** determineExitCode returns 6 whenever `matched_queries=0 AND baseline_only_queries=0 AND active_only_queries=0` (zero entries = insufficient evidence).

### Security — cli.ts strict-mode hardenings
- **F7 strict mode is DEFAULT.** `binary_sha256` is computed automatically over `dist/*.js` + `package.json` and embedded in `audit.binary_sha256`. Opt out only via `--no-binary-hash` (sets `mode="dev"`).
- **F8 three-tier exit codes:** 0 (clean) / 5 (mismatch warn ≤ ratio < high) / 6 (mismatch ≥ high OR fingerprint fail-closed OR set_mismatch). Plus 2 (usage) and 1 (internal). Procurement-grade CI: `if engram-counter ... ; then ...` succeeds ONLY on clean audit.
- **stdout/stderr discipline:** stdout receives ONLY the AuditOutput JSON (machine-parseable). All warnings/errors/progress write to stderr. Verified by test: stdout never contains `[ERROR]` or `[WARN]`.
- **Internal-error path:** uncaught exception in `main()` writes `[INTERNAL]` + stack to stderr, exits 1. Defends against silent success on internal failures.
- **self-verification:** `runEngramCounter` calls `verifyAuditTrailHash` on its own output before emitting. Defends against internal bug producing inconsistent audit_trail_hash vs audit block.
- **--audit-id triggers reproducible_mode=true** (per F6) so two auditors providing the same `--audit-id` on same inputs produce byte-identical envelope.audit_id + audit_trail_hash. Verified end-to-end via cli.test.ts reproducibility test.

### Added — hash.ts + integration tests + golden hash lock (2026-05-21)
- `src/hash.ts` (~365 LoC, 0 runtime deps) — THE trust-anchor module:
  - `canonicalizeJcs` — hand-rolled RFC 8785 JCS canonicalizer (~150 LoC, depth limit 64)
  - `sha256OverString` / `sha256OverBuffer` — Brand-typed wrappers over node:crypto
  - `buildAuditBlock` / `computeAuditTrailHash` — F6 inner-canonical hash anchor
  - `deriveAuditId` — content-addressed `ec_<12-hex>` from audit_trail_hash (reproducibility imperative)
  - `buildEnvelope` — F6 outer-presentation layer (computed_at NOT hashed)
  - `buildAuditOutput` — end-to-end assembly
  - `verifyAuditTrailHash` — auditor re-verification (format guard + recompute + envelope linkage)
- `counter.joinByQueryId` — explicit parser→counter seam, was previously buried in unwritten CLI code
- `tests/hash.test.ts` (~700 LoC, 70+ tests) — RFC 8785 hand-derived vectors + F6 isolation + reproducibility
- `tests/integration.test.ts` (NEW, ~230 LoC, 12 tests) — parser→counter→hash E2E with the 10q golden fixtures
- **GOLDEN HASH LOCKED:** `sha256:f5fe2b17396a6e4ec5583162f20774188f66eca72b22d16df5f75da67052a88f` for the 10q fixture pipeline. Any future drift = regression that MUST be acknowledged in changelog.

### Security — hash.ts adversarial security hardenings
Adversarial security review (adversarial 0.78 BLOCK / correctness 0.91 / testing 0.62 BLOCK-V0.1.0) found 6 P0 issues. All patched before commit:
- **Lone surrogate collision (Adversarial P0-1+P0-2 / Correctness C2)** — `jcsString` emitted raw lone surrogates which Node's UTF-8 encoder replaced with U+FFFD, enabling SHA-256 collisions between distinct lone-surrogate inputs + RFC 8785 divergence from Go/Java reference impls. Fixed: detect unpaired high/low surrogates, escape as `\uXXXX` per JSON.stringify convention.
- **Non-plain-object degeneration (Adversarial P0-3 / Correctness C1)** — `Date`, `Map`, `Set`, `Buffer`, `RegExp`, class instances all `typeof === "object"` with empty `Object.keys()` would silently canonicalize to `"{}"` (data loss) or array of byte values (Buffer). Fixed: `Object.getPrototypeOf(value) !== Object.prototype && proto !== null` throws.
- **No fixture→AuditOutput E2E (Testing P0 #1+#2+#3)** — modules tested in isolation; the seam where 99% of production bugs hide was untested. Fixed: tests/integration.test.ts reads fixtures, runs parse→join→aggregate→fingerprint→hash, asserts saved_pct=90, fingerprint_match=true, byte-identical reproducibility across 2 invocations.
- **No committed golden hash (Testing P0 #4)** — reproducibility contract had no anchor. Fixed: GOLDEN HASH locked in integration test assertion. Future hash drift fails CI.
- **Correctness C3** — `verifyAuditTrailHash` now format-guards malformed `audit_trail_hash` before recompute (returns structured `constraint_violation` not silent miscomputation).
- **Correctness C4** — `deriveAuditId` now format-guards input at runtime (defense against `as Sha256Hex` cast bypass).
- **Adversarial P1-4** — `verifyAuditTrailHash` now also checks `envelope.audit_id === deriveAuditId(audit_trail_hash)` when `reproducible_mode=false`. Closes envelope-to-audit swap attack.

### Added — parser.ts + workload fingerprint (2026-05-21)
- `src/parser.ts` — JSONL ingest with hard limits + Unicode line-terminator normalization + UTF-8 BOM handling + workload fingerprint (~510 lines, zero runtime deps)
- `parseJsonlString` / `parseJsonlFile` — main ingest path; `Result<ParseResult, ValidationError>` return
- `normalizeLineTerminators` — 7-sequence pre-processor (CRLF, CR, LF, U+2028, U+2029, U+0085, U+000C)
- `stripBom` — multi-strip BOM detection (returns count, not boolean — defeats SHA-grinding)
- `walkValidate` — recursive hard-limit walker (depth 8 / fields 64 / string 4096) + prototype-pollution defense (PROTO_KEYS rejection + `Object.getPrototypeOf` belt-and-braces check)
- `computeWorkloadFingerprint` — SPEC F1 (redesigned per surrogate-S1 bypass): JSON.stringify-canonical tuples, Unicode NFC normalization, fail-closed on workload-absent, collect-all count-skews
- Dual SHA in `ParseResult`: `file_sha256` (raw bytes, detects on-disk changes) + `normalized_content_sha256` (post-BOM-strip + post-line-normalize, defeats BOM-stacking SHA-grinding)
- 63 new tests on parser + fingerprint (147/147 total passing)

### Security — parser.ts adversarial security hardenings
Adversarial security review (adversarial 0.78 / code 0.83 / sec 0.88) found 6 P0 attack vectors. All patched before commit:
- **P0-1A** — Fingerprint join-character collision: attacker exploits legal `:` / `|` characters in `query_id` / `workload` to forge set-equivalence. Fixed via `JSON.stringify([id, workload])` tuples + `\n`-join (cryptographically infeasible collision).
- **P0-2A** — Token MAX_SAFE_INTEGER smuggling: `tokens_sent: 9007199254740993` (2^53+1) silently loses precision in JSON.parse → off-by-one savings. Fixed via guard rejecting tokens beyond `±Number.MAX_SAFE_INTEGER`.
- **P0-3A** — BOM-mediated SHA grinding: prepending stacked BOMs makes `file_sha256` adversary-controllable. Fixed via multi-BOM strip + new `normalized_content_sha256` field (auditor cross-checks both).
- **P0-4A / P0-1C** — `count_skew` early-return hid multiple skewed workloads alphabetically. Fixed: collect ALL skews into `skewed_workloads[]` array.
- **P0-2C** — `set_mismatch` path suppressed `count_per_workload` diagnostics. Fixed: surface skew warnings even on set_mismatch.
- **P0-3C** — Type-narrowing through `let` indexed-access. Fixed via const-extraction before typeof checks.
- **Sec P1-C** — Integer check ran AFTER negative clamp, losing non-integer signal on `-3.7` inputs. Fixed via reorder.
- **P1-d** — Workload normalization missing Unicode NFC pass (composed/decomposed bypass). Fixed via `.normalize("NFC")` before lowercase.
- **P0-5A (downgraded)** — Empirically verified on Node ≥20.18 that `JSON.parse` correctly enumerates `__proto__` as an own property (no prototype mutation). Existing `PROTO_KEYS` rejection works. Added `Object.getPrototypeOf` belt-and-braces check defense-in-depth.

### Added — architecture foundations (2026-05-21)
- `Result<T, E>` discriminated union + `ok` / `err` / `mapResult` / `flatMapResult` helpers for fallible-operation threading across parser/hash/cli pipeline (no megacatches at module seams)
- Brand types: `QueryId`, `Sha256Hex`, `BasisPoints` with safe constructors (`asQueryId`, `asSha256Hex`, `asBasisPoints`) — prevents primitive-confusion bugs at scale
- `Logger` interface + `NullLogger` implementation — downstream consumers capture warnings programmatically (replaces `console.error` sprinkles)
- Structured `Warning` type with frozen `WarningCode` enum (13 codes) — replaces opaque `string[]` warnings; downstream consumers can categorize + filter
- `ValidationError` + `ValidationErrorCode` (7 codes) — typed validation errors with JSON-pointer paths
- Outer envelope alignment with in-toto Statement v1: `_type`, `predicateType`, `schema_url` fields (Sigstore / cosign / slsa-verifier recognize)
- `schemas/ingestion-contract-v1.schema.json` — frozen JSON Schema (draft 2020-12) for the downstream ingestion contract; published at `https://cirvgreen.com/engram-counter/schemas/ingestion-contract-v1.json`
- `src/schema.ts` — hand-rolled `validateIngestionV1()` structural validator (zero runtime deps) + frozen URI constants
- 27 new type+schema tests covering Result helpers, Brand constructors, Logger contract, validateIngestionV1 (rejects unknown codes, mode/strict consistency, _type/predicateType URI mismatches)

### Added — v0.1.0 build target (in progress)
- Paired-run methodology: take baseline + active JSONL logs, produce JCS-canonicalized SHA-256 audit attestation
- Two-layer output envelope: outer (`computed_at`, `audit_id`) and inner canonical `audit` block (the hashed payload)
- Workload-fingerprint cross-check with fail-closed semantics on missing/sparse `workload` field
- Integer math for `saved_pct` (no IEEE-754 drift across Node versions)
- `--strict` mode: hashes the binary SHA-256 into the audit
- JSONL parser with hard limits (depth 8, fields 64, string 4096) and line-terminator normalization
- `counter_version` derived at runtime from `package.json`
- npm publish with `--provenance` (Sigstore attestation)
- Per-workload aggregation
- Optional cost projection via `--cost-per-million`
- Cross-impl test against `cyberphone/json-canonicalization` reference
- README with compile-from-source trust statement + methodology + CR/LF caveat + hash-algorithm agility note
- `docs/focus-mapping.md` with FOCUS v1.3 column equivalence table
- `docs/log-conversion/anthropic.md` and `docs/log-conversion/openai.md`
- 95% test coverage on counter math, 100% on parser + hash, ≥90% overall

### Why
Procurement teams evaluating AI vendor savings claims need a way to verify those claims without trusting the vendor's dashboard. `engram-counter` is the open-source primitive that closes that trust gap.

## [0.0.1] — 2026-05-21

### Added
- Initial scaffold: LICENSE (Apache 2.0), README, package.json, tsconfig.json, CHANGELOG
- Repository structure per SPEC v0.1.2 (src, tests, bin, docs, examples, .github)
- v0.1.0 spec finalized after formal multi-reviewer audit (CONDITIONAL_PASS aggregate verdict, 6 P0 fixes applied to SPEC v0.1.2 before code starts)

[Unreleased]: https://github.com/NickCirv/engram-counter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NickCirv/engram-counter/releases/tag/v0.1.0
