/**
 * engram-counter — public library entry point.
 *
 * Re-exports all public APIs from the math + types + schema + parser modules.
 * This is the `main` referenced by package.json; without it, the npm package
 * ships with no programmatic entry point.
 *
 * v0.0.1 — math primitives (counter.ts, types.ts).
 * v0.1.0 (in progress) — schema (schema.ts) + parser (parser.ts).
 * v0.1.0 ship requires: hash.ts (JCS + audit_trail_hash) + cli.ts (argv + exits).
 */

export * from "./counter.js";
export * from "./types.js";
export * from "./schema.js";
export * from "./parser.js";
export * from "./hash.js";
export * from "./cli.js";
