/**
 * cli.ts tests — argv parsing, exit codes, binary_sha256, main() orchestration.
 *
 * Uses dependency-injected RuntimeIO to avoid subprocess-test pain. Verifies
 * SPEC F7 (strict default) + F8 (three-tier exits) + F11 (ingestion_contract).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgv,
  validateArgs,
  determineExitCode,
  computeBinarySha256,
  runEngramCounter,
  main,
} from "../src/cli.js";
import type { RuntimeIO } from "../src/cli.js";
import type { AuditBlock } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const PKG = join(ROOT, "package.json");

// ════════════════════════════════════════════════════════════════════
// parseArgv (pure)
// ════════════════════════════════════════════════════════════════════

describe("parseArgv", () => {
  it("parses --baseline + --active", () => {
    const r = parseArgv(["--baseline", "b.jsonl", "--active", "a.jsonl"]);
    assert.equal(r.baseline, "b.jsonl");
    assert.equal(r.active, "a.jsonl");
    assert.equal(r.errors.length, 0);
  });

  it("recognizes --help and -h", () => {
    assert.equal(parseArgv(["--help"]).help, true);
    assert.equal(parseArgv(["-h"]).help, true);
  });

  it("recognizes --version and -V", () => {
    assert.equal(parseArgv(["--version"]).version, true);
    assert.equal(parseArgv(["-V"]).version, true);
  });

  it("recognizes --no-binary-hash (F7 opt-out)", () => {
    const r = parseArgv(["--baseline", "b", "--active", "a", "--no-binary-hash"]);
    assert.equal(r.no_binary_hash, true);
  });

  it("defaults no_binary_hash to false (F7 strict default)", () => {
    const r = parseArgv(["--baseline", "b", "--active", "a"]);
    assert.equal(r.no_binary_hash, false);
  });

  it("recognizes --pretty", () => {
    const r = parseArgv(["--pretty"]);
    assert.equal(r.pretty, true);
  });

  it("parses --cost-per-million as a number", () => {
    const r = parseArgv(["--cost-per-million", "5.50"]);
    assert.equal(r.cost_per_million, 5.5);
  });

  it("rejects --cost-per-million with negative value", () => {
    const r = parseArgv(["--cost-per-million", "-1"]);
    assert.ok(r.errors.some((e) => e.includes("--cost-per-million")));
  });

  it("rejects --cost-per-million with non-numeric value", () => {
    const r = parseArgv(["--cost-per-million", "free"]);
    assert.ok(r.errors.some((e) => e.includes("--cost-per-million")));
  });

  it("rejects threshold ratios outside [0, 1]", () => {
    assert.ok(parseArgv(["--mismatch-warn", "1.5"]).errors.length > 0);
    assert.ok(parseArgv(["--workload-absent-fail-closed", "-0.1"]).errors.length > 0);
    assert.ok(parseArgv(["--count-skew-warn", "2"]).errors.length > 0);
  });

  it("accepts threshold ratios at boundaries 0 and 1", () => {
    const r0 = parseArgv(["--mismatch-warn", "0"]);
    const r1 = parseArgv(["--mismatch-warn", "1"]);
    assert.equal(r0.errors.length, 0);
    assert.equal(r1.errors.length, 0);
    assert.equal(r0.mismatch_warn, 0);
    assert.equal(r1.mismatch_warn, 1);
  });

  it("rejects flag missing value (--baseline at end of argv)", () => {
    const r = parseArgv(["--baseline"]);
    assert.ok(r.errors.some((e) => e.includes("--baseline")));
  });

  it("rejects flag where next arg is another flag", () => {
    const r = parseArgv(["--baseline", "--active", "a.jsonl"]);
    // --baseline got no value — should warn
    assert.ok(r.errors.some((e) => e.includes("--baseline")));
  });

  it("rejects unknown flag", () => {
    const r = parseArgv(["--unknown-flag"]);
    assert.ok(r.errors.some((e) => e.includes("--unknown-flag")));
  });

  it("rejects positional arguments", () => {
    const r = parseArgv(["not-a-flag"]);
    assert.ok(r.errors.some((e) => e.toLowerCase().includes("positional")));
  });

  it("preserves --audit-id (reproducibility flag)", () => {
    const r = parseArgv(["--audit-id", "my-custom-id"]);
    assert.equal(r.audit_id, "my-custom-id");
  });

  it("preserves --baseline-file-label + --active-file-label", () => {
    const r = parseArgv([
      "--baseline-file-label",
      "redacted_baseline",
      "--active-file-label",
      "redacted_active",
    ]);
    assert.equal(r.baseline_file_label, "redacted_baseline");
    assert.equal(r.active_file_label, "redacted_active");
  });
});

// ════════════════════════════════════════════════════════════════════
// validateArgs
// ════════════════════════════════════════════════════════════════════

describe("validateArgs", () => {
  it("REJECTS missing --baseline", () => {
    const r = validateArgs(parseArgv(["--active", "a.jsonl"]));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("--baseline")));
    }
  });

  it("REJECTS missing --active", () => {
    const r = validateArgs(parseArgv(["--baseline", "b.jsonl"]));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("--active")));
    }
  });

  it("ACCEPTS both --baseline + --active", () => {
    const r = validateArgs(parseArgv(["--baseline", "b", "--active", "a"]));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.baseline, "b");
      assert.equal(r.value.active, "a");
    }
  });

  it("REJECTS warn ≥ high threshold (cross-validation)", () => {
    const r = validateArgs(
      parseArgv([
        "--baseline",
        "b",
        "--active",
        "a",
        "--mismatch-warn",
        "0.5",
        "--mismatch-high",
        "0.3",
      ]),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("--mismatch-warn") || e.includes("--mismatch-high")));
    }
  });

  it("defaults file labels to file paths when not overridden", () => {
    const r = validateArgs(parseArgv(["--baseline", "b.jsonl", "--active", "a.jsonl"]));
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.baseline_file_label, "b.jsonl");
    assert.equal(r.value.active_file_label, "a.jsonl");
  });

  it("propagates --baseline-file-label / --active-file-label overrides", () => {
    const r = validateArgs(
      parseArgv([
        "--baseline",
        "b.jsonl",
        "--active",
        "a.jsonl",
        "--baseline-file-label",
        "REDACTED_B",
        "--active-file-label",
        "REDACTED_A",
      ]),
    );
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.value.baseline_file_label, "REDACTED_B");
    assert.equal(r.value.active_file_label, "REDACTED_A");
  });

  it("REJECTS --audit-id matching reserved 'ec_<12hex>' format (P0-1 forgery defense)", () => {
    const r = validateArgs(
      parseArgv([
        "--baseline",
        "b.jsonl",
        "--active",
        "a.jsonl",
        "--audit-id",
        "ec_aaaaaaaaaaaa",
      ]),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("ec_") && e.includes("reserved")));
    }
  });

  it("ACCEPTS --audit-id with non-derived format (procurement-label use case)", () => {
    const r = validateArgs(
      parseArgv([
        "--baseline",
        "b.jsonl",
        "--active",
        "a.jsonl",
        "--audit-id",
        "audit-q3-2026",
      ]),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.audit_id, "audit-q3-2026");
  });

  it("REJECTS --audit-id 'ec_<wrong-length>' (boundary test)", () => {
    // Only EXACTLY 12 hex chars after ec_ is reserved. Other lengths are allowed.
    const r = validateArgs(
      parseArgv([
        "--baseline",
        "b.jsonl",
        "--active",
        "a.jsonl",
        "--audit-id",
        "ec_short",
      ]),
    );
    // ec_short is 5 chars — NOT 12-hex format, so should pass
    assert.equal(r.ok, true);
  });
});

// ════════════════════════════════════════════════════════════════════
// determineExitCode (pure)
// ════════════════════════════════════════════════════════════════════

function makeAuditWithSeverity(
  matched: number,
  baseline_only: number,
  active_only: number,
  fingerprint_match: boolean | null,
): AuditBlock {
  return {
    version: "0.1.0",
    counter_version: "0.0.1",
    mode: "dev",
    methodology: "paired-run",
    inputs: {
      baseline_file: "b",
      baseline_sha256: "sha256:0".repeat(64) as string,
      active_file: "a",
      active_sha256: "sha256:0".repeat(64) as string,
      bom_stripped: false,
    },
    counts: {
      baseline_entries: matched + baseline_only,
      active_entries: matched + active_only,
      matched_queries: matched,
      baseline_only_queries: baseline_only,
      active_only_queries: active_only,
    },
    tokens: {
      baseline_sent_total: 0,
      active_sent_total: 0,
      saved_sent: 0,
      baseline_received_total: 0,
      active_received_total: 0,
      saved_received: 0,
      baseline_total: 0,
      active_total: 0,
      saved_total: 0,
      saved_pct: 0,
    },
    cost_usd: null,
    per_workload: {},
    fingerprint: {
      baseline_workloads: "sha256:0".repeat(64),
      active_workloads: "sha256:0".repeat(64),
      fingerprint_match,
      fingerprint_reason: "ok",
      count_per_workload: {},
    },
    thresholds: {
      workload_absent_fail_closed: 0.01,
      mismatch_warn: 0.1,
      mismatch_high: 0.5,
      count_skew_warn: 0.5,
    },
    warnings: [],
  };
}

describe("determineExitCode (F8 three-tier)", () => {
  it("EXIT 0 on clean audit (zero mismatch, fingerprint matches)", () => {
    const audit = makeAuditWithSeverity(100, 0, 0, true);
    assert.equal(determineExitCode(audit), 0);
  });

  it("EXIT 5 on warn-tier mismatch (10-50%)", () => {
    // 80 matched + 10 baseline_only + 10 active_only = 100 total_unique
    // mismatch = 20 / 100 = 0.2 → between warn (0.1) and high (0.5)
    const audit = makeAuditWithSeverity(80, 10, 10, true);
    assert.equal(determineExitCode(audit), 5);
  });

  it("EXIT 6 on high-tier mismatch (>50%)", () => {
    // 30 matched + 40 baseline_only + 40 active_only = 110 total_unique
    // mismatch = 80 / 110 ≈ 0.73 → high
    const audit = makeAuditWithSeverity(30, 40, 40, true);
    assert.equal(determineExitCode(audit), 6);
  });

  it("EXIT 6 on fingerprint_match === null (fail-closed)", () => {
    const audit = makeAuditWithSeverity(100, 0, 0, null);
    assert.equal(determineExitCode(audit), 6);
  });

  it("EXIT 6 on fingerprint_match === false (set mismatch)", () => {
    const audit = makeAuditWithSeverity(100, 0, 0, false);
    assert.equal(determineExitCode(audit), 6);
  });

  it("FINGERPRINT FAILURE TAKES PRECEDENCE over clean mismatch", () => {
    // Mismatch is fine, but fingerprint failed → still exit 6
    const audit = makeAuditWithSeverity(100, 0, 0, false);
    assert.equal(determineExitCode(audit), 6);
  });

  it("EXIT 6 on empty audit (no entries) — adversarial P0-3 no-evidence forgery", () => {
    // matched=0 + baseline_only=0 + active_only=0 = zero entries on both sides.
    // Previously returned 0 (clean) silently — now exits 6 (insufficient evidence).
    const audit = makeAuditWithSeverity(0, 0, 0, true);
    assert.equal(determineExitCode(audit), 6);
  });
});

// ════════════════════════════════════════════════════════════════════
// computeBinarySha256
// ════════════════════════════════════════════════════════════════════

describe("computeBinarySha256", () => {
  it("produces sha256:-prefixed hex format", () => {
    const h = computeBinarySha256(DIST, PKG);
    assert.match(h, /^sha256:[0-9a-f]{64}$/);
  });

  it("is DETERMINISTIC (same dist + pkg → same hash)", () => {
    const h1 = computeBinarySha256(DIST, PKG);
    const h2 = computeBinarySha256(DIST, PKG);
    assert.equal(h1, h2);
  });

  it("differs when dist directory differs (empty vs populated)", () => {
    const h1 = computeBinarySha256(DIST, PKG);
    const h2 = computeBinarySha256(FIX, PKG); // fixtures dir has no .js
    assert.notEqual(h1, h2);
  });

  it("MUTATION GUARD — byte-level change in dist content → hash changes", () => {
    // Create temp dir with controlled .js content; mutate one byte; verify hash differs.
    // This is the strong invariant: any dist mutation propagates to binary_sha256.
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "engram-counter-bin-sha-"));
    try {
      writeFileSync(join(tmp, "foo.js"), "console.log('hello');", "utf8");
      const before = computeBinarySha256(tmp, PKG);
      writeFileSync(join(tmp, "foo.js"), "console.log('hello!');", "utf8"); // 1 byte added
      const after = computeBinarySha256(tmp, PKG);
      assert.notEqual(before, after);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("MUTATION GUARD — adding a .js file → hash changes (defends against file injection)", () => {
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "engram-counter-bin-sha-add-"));
    try {
      writeFileSync(join(tmp, "a.js"), "// a", "utf8");
      const before = computeBinarySha256(tmp, PKG);
      writeFileSync(join(tmp, "b.js"), "// b", "utf8"); // new file injected
      const after = computeBinarySha256(tmp, PKG);
      assert.notEqual(before, after);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("adversarial P0-2: detects .cjs / .mjs / .node / postinstall injection (polyglot defense)", () => {
    // Prior .endsWith('.js') filter let fork inject non-.js files that Node still loads.
    // Now hash ALL regular files in dist/.
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "engram-counter-polyglot-"));
    try {
      writeFileSync(join(tmp, "cli.js"), "// engram cli", "utf8");
      const before = computeBinarySha256(tmp, PKG);

      // Inject a .cjs polyglot — Node's module resolution can load this
      writeFileSync(join(tmp, "preload.cjs"), "// EVIL preload", "utf8");
      const afterCjs = computeBinarySha256(tmp, PKG);
      assert.notEqual(before, afterCjs);

      // Inject .mjs
      writeFileSync(join(tmp, "shim.mjs"), "// EVIL shim", "utf8");
      const afterMjs = computeBinarySha256(tmp, PKG);
      assert.notEqual(afterCjs, afterMjs);

      // Inject postinstall.sh
      writeFileSync(join(tmp, "postinstall.sh"), "#!/bin/sh\necho evil", "utf8");
      const afterPostinstall = computeBinarySha256(tmp, PKG);
      assert.notEqual(afterMjs, afterPostinstall);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles missing dist gracefully (returns valid sha256:- format)", () => {
    const h = computeBinarySha256("/nonexistent/path", "/nonexistent/pkg.json");
    assert.match(h, /^sha256:[0-9a-f]{64}$/);
  });
});

// ════════════════════════════════════════════════════════════════════
// runEngramCounter — end-to-end via 10q fixture
// ════════════════════════════════════════════════════════════════════

describe("runEngramCounter (E2E via fixture)", () => {
  it("produces clean AuditOutput from the 10q fixture", () => {
    const r = runEngramCounter(
      {
        baseline: join(FIX, "baseline-10q.jsonl"),
        active: join(FIX, "active-10q.jsonl"),
        cost_per_million: null,
        no_binary_hash: true, // skip binary_sha256 for test determinism
        thresholds: {
          workload_absent_fail_closed: 0.01,
          mismatch_warn: 0.1,
          mismatch_high: 0.5,
          count_skew_warn: 0.5,
        },
        baseline_file_label: "baseline-10q.jsonl",
        active_file_label: "active-10q.jsonl",
        pretty: false,
      },
      { counter_version: "0.0.1" },
    );

    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.audit.tokens.saved_pct, 90);
    assert.equal(r.value.audit.counts.matched_queries, 10);
    assert.equal(r.value.audit.fingerprint.fingerprint_match, true);
    assert.equal(r.value.audit.mode, "dev"); // because no_binary_hash: true
  });

  it("computes cost_usd when --cost-per-million provided", () => {
    const r = runEngramCounter(
      {
        baseline: join(FIX, "baseline-10q.jsonl"),
        active: join(FIX, "active-10q.jsonl"),
        cost_per_million: 5.0,
        no_binary_hash: true,
        thresholds: {
          workload_absent_fail_closed: 0.01,
          mismatch_warn: 0.1,
          mismatch_high: 0.5,
          count_skew_warn: 0.5,
        },
        baseline_file_label: "baseline-10q.jsonl",
        active_file_label: "active-10q.jsonl",
        pretty: false,
      },
      { counter_version: "0.0.1" },
    );

    if (!r.ok) throw new Error("expected ok");
    assert.ok(r.value.audit.cost_usd !== null);
    assert.ok(r.value.audit.cost_usd > 0);
  });

  it("returns Err on missing baseline file", () => {
    const r = runEngramCounter(
      {
        baseline: "/nonexistent/baseline.jsonl",
        active: join(FIX, "active-10q.jsonl"),
        cost_per_million: null,
        no_binary_hash: true,
        thresholds: {
          workload_absent_fail_closed: 0.01,
          mismatch_warn: 0.1,
          mismatch_high: 0.5,
          count_skew_warn: 0.5,
        },
        baseline_file_label: "missing",
        active_file_label: "a",
        pretty: false,
      },
      { counter_version: "0.0.1" },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.exitCode, 6);
      assert.match(r.error.message, /baseline/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// main(io) — top-level orchestrator
// ════════════════════════════════════════════════════════════════════

interface Harness {
  io: RuntimeIO;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
}

function makeMockIO(argv: string[]): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const io: RuntimeIO = {
    argv,
    cwd: ROOT,
    stdout: {
      write(s: string) {
        stdout.push(s);
      },
    },
    stderr: {
      write(s: string) {
        stderr.push(s);
      },
    },
    exit: (code: number) => {
      // Record-only mock. main() has explicit `return` after each exit call,
      // so control flow terminates without us throwing.
      exitCodes.push(code);
    },
    distDir: DIST,
    packageJsonPath: PKG,
  };
  return { io, stdout, stderr, exitCodes };
}

/** First exit code recorded — the "intent" of main's flow. */
function firstExit(h: Harness): number | undefined {
  return h.exitCodes[0];
}

async function runMain(argv: string[]): Promise<Harness> {
  const h = makeMockIO(argv);
  await main(h.io);
  return h;
}

describe("main(io) — top-level orchestrator", () => {
  it("prints HELP to stdout + exits 0 on --help", async () => {
    const h = await runMain(["--help"]);
    assert.equal(firstExit(h), 0);
    assert.ok(h.stdout.join("").includes("engram-counter"));
    assert.ok(h.stdout.join("").includes("--baseline"));
  });

  it("prints VERSION to stdout + exits 0 on --version", async () => {
    const h = await runMain(["--version"]);
    assert.equal(firstExit(h), 0);
    assert.match(h.stdout.join(""), /engram-counter\s+\d/);
  });

  it("EXITS 2 on missing --baseline/--active (usage error)", async () => {
    const h = await runMain([]);
    assert.equal(firstExit(h), 2);
    assert.ok(h.stderr.join("").includes("--baseline"));
  });

  it("EXITS 2 on unknown flag", async () => {
    const h = await runMain(["--bogus-flag"]);
    assert.equal(firstExit(h), 2);
  });

  it("emits AuditOutput JSON to stdout + exits 0 on clean 10q fixture", async () => {
    const h = await runMain([
      "--baseline",
      join(FIX, "baseline-10q.jsonl"),
      "--active",
      join(FIX, "active-10q.jsonl"),
      "--audit-id",
      "cli-test-clean",
      "--no-binary-hash",
    ]);
    assert.equal(firstExit(h), 0);
    const out = JSON.parse(h.stdout.join(""));
    assert.equal(out.audit.tokens.saved_pct, 90);
    assert.equal(out.envelope.audit_id, "cli-test-clean");
    assert.equal(out.envelope.reproducible_mode, true);
  });

  it("EXITS 6 on parser error (missing baseline file)", async () => {
    const h = await runMain([
      "--baseline",
      "/nonexistent/baseline.jsonl",
      "--active",
      join(FIX, "active-10q.jsonl"),
      "--no-binary-hash",
    ]);
    assert.equal(firstExit(h), 6);
    assert.ok(h.stderr.join("").includes("baseline"));
  });

  it("DOES NOT pollute stdout with stderr content", async () => {
    const h = await runMain([
      "--baseline",
      "/nonexistent",
      "--active",
      join(FIX, "active-10q.jsonl"),
      "--no-binary-hash",
    ]);
    // stderr has the error message
    assert.ok(h.stderr.length > 0);
    // stdout should NOT contain "[ERROR]" or "[WARN]"
    assert.ok(!h.stdout.join("").includes("[ERROR]"));
    assert.ok(!h.stdout.join("").includes("[WARN]"));
  });

  it("emits --pretty JSON with indentation", async () => {
    const h = await runMain([
      "--baseline",
      join(FIX, "baseline-10q.jsonl"),
      "--active",
      join(FIX, "active-10q.jsonl"),
      "--audit-id",
      "cli-pretty-test",
      "--no-binary-hash",
      "--pretty",
    ]);
    assert.equal(firstExit(h), 0);
    // Pretty JSON has newlines
    assert.ok(h.stdout.join("").includes("\n  "));
  });

  it("REPRODUCIBLE audit_trail_hash across two invocations (procurement imperative)", async () => {
    // The procurement-killer property: same inputs → identical audit_trail_hash.
    // envelope.computed_at WILL differ across invocations (wall-clock time changes
    // between runs — that's intentional per F6 envelope isolation). The reproducibility
    // contract is on audit_trail_hash, NOT on full JSON byte-identity.
    const args = [
      "--baseline",
      join(FIX, "baseline-10q.jsonl"),
      "--active",
      join(FIX, "active-10q.jsonl"),
      "--audit-id",
      "cli-reproducibility-test",
      "--no-binary-hash",
    ];
    const h1 = await runMain(args);
    const h2 = await runMain(args);
    assert.equal(firstExit(h1), 0);
    assert.equal(firstExit(h2), 0);
    const out1 = JSON.parse(h1.stdout.join(""));
    const out2 = JSON.parse(h2.stdout.join(""));
    assert.equal(out1.audit_trail_hash, out2.audit_trail_hash);
    assert.equal(out1.envelope.audit_id, out2.envelope.audit_id);
    // Sanity: computed_at SHOULD differ across runs (wall-clock changes)
    // — but if it happens to match by sub-millisecond timing, that's fine too.
    // The key invariant is the hash, not the timestamp.
  });

  it("strict mode (default — no --no-binary-hash) embeds binary_sha256", async () => {
    const h = await runMain([
      "--baseline",
      join(FIX, "baseline-10q.jsonl"),
      "--active",
      join(FIX, "active-10q.jsonl"),
      "--audit-id",
      "cli-strict-test",
      // intentionally NO --no-binary-hash → strict default
    ]);
    assert.equal(firstExit(h), 0);
    const out = JSON.parse(h.stdout.join(""));
    assert.equal(out.audit.mode, "strict");
    assert.match(out.audit.binary_sha256, /^sha256:[0-9a-f]{64}$/);
  });
});
