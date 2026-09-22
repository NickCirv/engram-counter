# engram-counter — command reference

[Overview](../README.md) · [Research record](RESEARCH.md)

Describes revision `c95e418caade2e3ee04695a3cd2e3519520a9dfa`. Commands are source-inspected; no execution results are asserted.

## Workflow

Joins baseline and active entries by query_id, aggregates token differences and workload consistency, and hashes a canonical audit block. Optional model pricing includes cache fields; strict mode also fingerprints the built files and package manifest.

Requires Node >=20.18.0 and a source build. The fixture paths exist in the pinned tree, but JSONL payloads were outside this capture filter; the example was not executed. Exit 0 is a clean audit, 5 a partial warning, 6 a failed audit, 2 usage and 1 internal error.

```bash
node bin/engram-counter.js --baseline tests/fixtures/baseline-100q.jsonl --active tests/fixtures/active-100q.jsonl --audit-id local-fixture-review --pretty
```

## Commands and controls

| Control | Behavior in the inspected implementation |
| --- | --- |
| `--baseline PATH` | Read baseline JSONL |
| `--active PATH` | Read active JSONL |
| `--audit-id ID` | Supply the reproducibility identifier |
| `--model ID` | Select fallback pricing model for rows lacking one |
| `--no-binary-hash` | Use development mode without build fingerprint |
| `--pretty` | Indent emitted JSON |

## Interpretation and side effects

A SHA-256 digest makes a record comparable; it does not authenticate the log producer or prove causal savings, task equivalence or billing accuracy. Bundled pricing is a dated snapshot. The committed synthetic fixture is not a customer result.

## Implementation reference

- [package.json](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/package.json)
- [bin/engram-counter.js](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/bin/engram-counter.js)
- [src/cli.ts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/src/cli.ts)
