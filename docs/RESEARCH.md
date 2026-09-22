# engram-counter — research record

## Revision and scope

- Repository: [NickCirv/engram-counter](https://github.com/NickCirv/engram-counter)
- Commit: `c95e418caade2e3ee04695a3cd2e3519520a9dfa`
- Tree: `4f0231a731b5ed6cd6bbb974942b73b79835d69e`
- Captured: 35 of 35 eligible text files (all eligible text files).
- Recursive tree truncated: `False`.
- Runtime verification: **unverified**; no repository code, installation or test command was executed.

The captured file inventory is broader than the semantic review. Authoring inspected package metadata, entrypoint/argument handling and implementation paths relevant to the claims below, plus test declarations. This is documentation research, not a line-by-line security audit. Generated/binary artifacts, lockfiles and file types outside the acquisition filter were not inspected.

## Claim and evidence

| Claim | Pinned evidence | Status |
| --- | --- | --- |
| Runtime requirement and executable mapping | [package.json](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/package.json) | verified in manifest; installation unverified |
| Compare paired JSONL usage logs and produce a reproducible audit record of the supplied measurements. | [implementation](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/bin/engram-counter.js) | partially verified by static implementation review |
| Operational limits and side effects | [implementation](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/bin/engram-counter.js) and source map in [reference](REFERENCE.md) | partially verified; runtime unverified |
| Test command definition | [package.json](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/package.json) | verified as a declaration only |

## Findings carried into the rewrite

A SHA-256 digest makes a record comparable; it does not authenticate the log producer or prove causal savings, task equivalence or billing accuracy. Bundled pricing is a dated snapshot. The committed synthetic fixture is not a customer result.

No runtime checks were executed for this documentation review. A declared test command is available below; its presence is not a passing result.

## Documentation inventory and disposition

| Existing document | Disposition |
| --- | --- |
| [CHANGELOG.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/CHANGELOG.md) | Preserved policy, legal/specification or historical release text; no overlay replacement. |
| [README.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/README.md) | Rewritten overview; historical copy remains at this pinned URL. |
| [SECURITY.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/SECURITY.md) | Preserved policy, legal/specification or historical release text; no overlay replacement. |
| [bench/100q-summary.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/bench/100q-summary.md) | Preserved historical design, ADR, plan, release or measurement artifact; not asserted as current implementation guidance. |
| [docs/log-conversion/anthropic.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/docs/log-conversion/anthropic.md) | Rewritten from pinned source; examples and integrations unexecuted. |
| [docs/log-conversion/openai.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/docs/log-conversion/openai.md) | Rewritten from pinned source; examples and integrations unexecuted. |
| [docs/methodology.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/docs/methodology.md) | Rewritten against the captured source; protected license metadata retained. |
| [tests/fixtures/README.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/fixtures/README.md) | Rewritten from pinned source; examples and integrations unexecuted. |

New supporting documents: `docs/REFERENCE.md` and `docs/RESEARCH.md`. No original source or protected legal/security file was changed.

## Protected-file evidence

- `LICENSE` SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.
- `SECURITY.md` SHA-256 `208127add8c4b88a35b78c551b380d72834d70e5f525a4da3d6ceea1627e8cf9`.
- `CHANGELOG.md` SHA-256 `76e59addfa93372b05b52c5157e2a59446cb8097106eb94aaf39401c3a4bca49`.
- `NOTICE` SHA-256 `5da49f6befc8708c1e5794340b673432a3d189c87c197ed16b0d595d9d00bc07`.

## Remaining verification

Clean installation, useful-command execution, malformed input, side-effect boundaries, platform compatibility and end-to-end tests remain unverified. Package-registry availability and live API destinations were not checked. No performance, customer-adoption, compliance or production-readiness claim is made.

## Captured evidence index

- [LICENSE](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/LICENSE) · blob `d645695673349e3947e8e5ae42332d0ac3164cd7`.
- [README.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/README.md) · blob `6ad8454d8566a2b58e008e9a5c50efeb411eae16`.
- [SECURITY.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/SECURITY.md) · blob `f0432fa8ffe35b26e948071843633cca4e541dc9`.
- [package.json](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/package.json) · blob `99a79ace2af831a5f950b1a520655d18c5bfeb11`.
- [.github/workflows/release.yml](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/.github/workflows/release.yml) · blob `c5b2afb0de3d417b15215e1f5e299b571b0c6845`.
- [CHANGELOG.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/CHANGELOG.md) · blob `d6f10f4d1c2283d17e543bd567635595b0f295fe`.
- [NOTICE](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/NOTICE) · blob `591bba960fa0a6e398bb51b79e3645f0b2302621`.
- [bin/engram-counter.js](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/bin/engram-counter.js) · blob `0096c8e79e0fcd31501b41ef44a2a388c33275f7`.
- [src/cli.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/cli.ts) · blob `d8a7bf6f3eb5fe9546b65528d899f2d2648a8d6f`.
- [tsconfig.json](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tsconfig.json) · blob `e3cea7adcb638bdfadb2f4056fdc6fcf819ac513`.
- [bench/100q-summary.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/bench/100q-summary.md) · blob `c6db0c3936426b8ee0a3a58be6247f8381b81ed3`.
- [docs/log-conversion/anthropic.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/docs/log-conversion/anthropic.md) · blob `2f9bd3ea3b5a4d248ba0c62c603e64141e1992b4`.
- [docs/log-conversion/openai.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/docs/log-conversion/openai.md) · blob `65b65c15de3d212239e4c85c2d9e1a7c13ce3394`.
- [docs/methodology.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/docs/methodology.md) · blob `da17fcac2f663c17b574b7f738418d403f47f6fb`.
- [tests/fixtures/README.md](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/fixtures/README.md) · blob `5fd16e3ece7c69a8f3319f69bad80890747f28b7`.
- [bench/100q-benchmark.json](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/bench/100q-benchmark.json) · blob `0467863c39b22ef1340f5d10363f9f4413360c11`.
- [schemas/ingestion-contract-v1.schema.json](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/schemas/ingestion-contract-v1.schema.json) · blob `ec70e30a28bb2a12a71ad72c8937787914562dee`.
- [scripts/generate-fixture.js](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/scripts/generate-fixture.js) · blob `77bbb7d58488a0979924a32d6d1877a673513ef7`.
- [src/counter.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/counter.ts) · blob `a837983aa6e0f885f50fcc102a32ac24fefaf716`.
- [src/hash.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/hash.ts) · blob `c1d8e5738ba3427ceec2fd1f4b0cc8b8c8ac7e41`.
- [src/index.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/index.ts) · blob `5f7529453061e61d09b1ebf020621683af9c2f31`.
- [src/parser.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/parser.ts) · blob `ad433fcfa59cdb753a1b52d533db3d765f8029b7`.
- [src/pricing.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/pricing.ts) · blob `48372e23bf5e295f50727982c1837a8a32169e70`.
- [src/schema.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/schema.ts) · blob `344340c83ac2467656c6de43a002869e9306800d`.
- [src/types.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/types.ts) · blob `25c46bf7c120601523df169e55a6876194453863`.
- [tests/cli.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/cli.test.ts) · blob `3876ee0fd70124c65759d67ff2ca71b5da4f94f9`.
- [tests/counter-cost.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/counter-cost.test.ts) · blob `273108c4f3b49cd4a3fce2d55713b8a136e542db`.
- [tests/counter.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/counter.test.ts) · blob `4668b8c4cdd3a1ea42ba5b843defe38c29c6f3b0`.
- [tests/hash-v0.2-cost.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/hash-v0.2-cost.test.ts) · blob `66b7ec6f33a126b71cc25abf0b2d1b81797d6fb1`.
- [tests/hash.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/hash.test.ts) · blob `09b32092d11d742ac70db8782edd5da029323fbb`.
- [tests/integration.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/integration.test.ts) · blob `5b09a105486ad047b317834d7a05c1265260359d`.
- [tests/parser-cache-fields.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/parser-cache-fields.test.ts) · blob `7aa834b4ba39beb0561445e4e53c29355e57588a`.
- [tests/parser.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/parser.test.ts) · blob `d856e4503bb2b40a5b7c3d6fbd62b68d322ec714`.
- [tests/pricing.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/pricing.test.ts) · blob `57b1487e77b0c3aeb257f68c24ca90ac2da7a0be`.
- [tests/types.test.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/types.test.ts) · blob `4e70295348963c74a7611e528569f04f462b6783`.

## Additional authored documents

- `docs/methodology.md` — current source-backed guide/entrypoint.

## Tree files outside the captured text set

These paths were mapped but their contents were not acquired in this research pass:

- `.gitignore`
- `CODEOWNERS`
- `docs/log-conversion/.gitkeep`
- `examples/.gitkeep`
- `package-lock.json`
- `tests/fixtures/.gitkeep`
- `tests/fixtures/active-100q.jsonl`
- `tests/fixtures/active-10q.jsonl`
- `tests/fixtures/baseline-100q.jsonl`
- `tests/fixtures/baseline-10q.jsonl`

## Cache accounting review

`src/pricing.ts` adds ordinary input and separate cache categories. `src/counter.ts` raw token totals sum only `tokens_sent + tokens_received`. Conversion guides now distinguish these metrics and flag double-counting or omission risks. No live provider API, current pricing, conversion execution or JSONL fixture payload was verified.
