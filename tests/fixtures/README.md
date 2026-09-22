# Counter fixtures

The JSONL fixtures provide synthetic inputs for parser, aggregation and CLI tests. They are not usage records from customers or evidence of measured savings.

The historical 10-query pair is `baseline-10q.jsonl` and `active-10q.jsonl`. Preserve fixture bytes when changing documentation: tests can depend on row identity, ordering and counts. The documentation acquisition did not include JSONL payloads, so their numerical totals were not independently recomputed here.

## Test coverage to inspect

- `parser.test.ts` and `parser-cache-fields.test.ts`: input validation and cache fields.
- `counter.test.ts` and `counter-cost.test.ts`: aggregation and cost handling.
- `hash.test.ts` and `hash-v0.2-cost.test.ts`: deterministic digest behavior.
- `cli.test.ts` and `integration.test.ts`: command-level expectations.

Run the package's declared test command after installing and building under its supported Node version (manifest: `>=20.18`). No Node-version matrix, Bun compatibility, expected percentage or passing result is asserted by this review.

[Package scripts](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/package.json) · [Parser tests](https://github.com/NickCirv/engram-counter/blob/c95e418caade2e3ee04695a3cd2e3519520a9dfa/tests/parser.test.ts)
