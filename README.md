![engram-counter — Nicholas Ashkar repository collection](assets/nicholas-ashkar/banner.png)

# engram-counter

Compare paired JSONL usage logs and produce a reproducible audit record of the supplied measurements.












<a id="why-it-exists"></a>

<a id="compile-from-source-recommended-for-procurement-audits"></a>

<a id="generating-compatible-logs"></a>

<a id="generating-query_id"></a>

<a id="converting-llm-provider-logs"></a>

<a id="sample-run-real-output-from-committed-100q-fixture"></a>

<a id="scope"></a>

<a id="methodology"></a>

<a id="hash-algorithm-agility"></a>

<a id="project-links"></a>

<a id="status"></a>

## What it does

Joins baseline and active entries by query_id, aggregates token differences and workload consistency, and hashes a canonical audit block. Optional model pricing includes cache fields; strict mode also fingerprints the built files and package manifest. See the pinned [implementation](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/bin/engram-counter.js).


<a id="install"></a>

## Quickstart

Node requirement from the inspected manifest: **`>=20.18.0`**. Requires Node >=20.18.0 and a source build. The fixture paths exist in the pinned tree, but JSONL payloads were outside this capture filter; the example was not executed. Exit 0 is a clean audit, 5 a partial warning, 6 a failed audit, 2 usage and 1 internal error.

The following example is **source-inspected, not executed**. It uses a pinned checkout; npm package publication is not assumed. Replace project paths or provide the stated input fixtures before running it.

```bash
git clone https://github.com/NickCirv/engram-counter.git
cd engram-counter
git checkout c95e418caade2e3ee04695a3cd2e3519520a9dfa
npm install --ignore-scripts
npm run build
node bin/engram-counter.js --baseline tests/fixtures/baseline-100q.jsonl --active tests/fixtures/active-100q.jsonl --audit-id local-fixture-review --pretty
```

Dependencies are installed with lifecycle scripts disabled in this recipe. Read the package scripts before enabling any lifecycle step required by your environment.

## Usage and reference

`engram-counter` are the executable names declared by the package. [Methodology](docs/methodology.md) explains what the audit digest proves and how to compare runs. [Command reference](docs/REFERENCE.md) covers source-backed options and entry points.


<a id="what-this-tool-does-not-prove-honest-disclosure"></a>

## Limits and operational notes

A SHA-256 digest makes a record comparable; it does not authenticate the log producer or prove causal savings, task equivalence or billing accuracy. Bundled pricing is a dated snapshot. The committed synthetic fixture is not a customer result.



<a id="flagship-benchmark-reproducible"></a>

<a id="reproducibility-caveat-line-endings"></a>

## Development

No runtime checks were executed for this documentation review. A declared test command is available below; its presence is not a passing result.

| Script | Declared command |
| --- | --- |
| `build` | `tsc` |
| `test` | `tsx --test tests/*.test.ts` |
| `test:coverage` | `echo 'coverage tooling will land in v0.2'` |
| `lint` | `tsc --noEmit` |
| `test:watch` | `tsx --test --watch tests/*.test.ts` |
| `typecheck` | `tsc --noEmit` |

Work from the pinned source, keep changes focused, and reproduce the affected behavior with a small fixture before proposing a change. Existing contribution and security policies remain authoritative where present.

## Research and status

[Research record](docs/RESEARCH.md) identifies the inspected revision, source evidence, documentation disposition and verification gaps. Static inspection supports the descriptions here; runtime behavior, dependency installation and current hosted services remain unverified.


<a id="license"></a>

## License and author

[License](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/LICENSE)

[Nicholas Ashkar](https://nicholashkar.com) · Applied AI, systems and consulting.
