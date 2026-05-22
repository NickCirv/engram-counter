# Security Policy

## Supported Versions

| Version | Status | Notes |
|---------|--------|-------|
| **v0.1.x** | TBD upon v0.1.0 release | First production-ready release |
| v0.0.x   | **Scaffold only** | NOT for production use |

## Threat Model

engram-counter produces tamper-evident audit attestations of AI token savings via JCS
(RFC 8785) canonicalization + SHA-256. The trust model:

- **Math primitives** (`counter.ts`) — pure functions, deterministic, no IO
- **Audit hash** — over JCS-canonical inner `audit` block; outer `envelope`
  (`computed_at`, `audit_id`) is NOT hashed
- **Trust boundary** — the npm artifact's `binary_sha256` (in `--strict` mode, default
  from v0.1.0) is the anchor. Cross-check against the SHA-256 published in the
  corresponding GitHub Release notes.

## What This Software Does NOT Defend Against

Documented honestly so enterprise procurement can scope correctly:

- **Attacker controlling both input files.** Workload-fingerprint catches workload-set
  mismatches but cannot detect token-count fraud when an attacker writes both baseline
  and active logs. Token-honesty verification requires vendor cross-validation against
  LLM-provider invoices (future procurement-workflow work) or third-party-controlled log generation.
- **Compromised npm artifact.** Despite Sigstore `--provenance` (planned v0.1.0),
  procurement teams in high-assurance contexts should `git clone` the tagged release
  and run `npm ci && npm run build` themselves rather than trust the npm artifact.

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security findings.**

1. Email **nick@cirvgreen.com** with subject "engram-counter security disclosure"
2. Include:
   - Vulnerability description
   - Reproduction steps (versions, environment, inputs)
   - Impact assessment (procurement-facing or code-execution risk?)
3. We'll acknowledge within **48 hours**

## Disclosure Timeline

- **T+0:** Report received, acknowledged within 48 hours
- **T+1–14:** Investigation + patch development
- **T+14–30:** Patch release + GHSA advisory published
- **T+30:** Full public disclosure

For critical findings (active exploitation, supply chain compromise), expedited
timeline applies.

## Cryptographic Disclosures

- **Hash:** SHA-256 (FIPS 180-4). Future agility planned via `sha256:`/`sha3-256:`/
  `blake3:` prefix on `audit_trail_hash`.
- **Canonicalization:** JCS per RFC 8785. Hand-rolled (~150 LoC) for zero-runtime-dep
  trust. Cross-impl tested against `cyberphone/json-canonicalization` reference (v0.1.0).
- **Signing:** None at v0.1.0. Sigstore via npm `--provenance` provides build-pipeline
  attestation. DSSE envelope wrap planned for V0.2.

## Acknowledgments

We thank security researchers responsible for prior engramx disclosures
(see GHSA-2r2p-4cgf-hv7h for the v2.0.2 advisory pattern).
