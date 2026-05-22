/**
 * engram-counter v0.1.0 — CLI entry orchestrator.
 *
 * Reads baseline + active JSONL via parser, joins by query_id via counter,
 * computes fingerprint, assembles audit, emits JCS-canonical AuditOutput JSON.
 *
 * Implements:
 *   F7 — strict mode DEFAULT, --no-binary-hash opt-out
 *   F8 — three-tier exit codes (0 clean / 5 warn / 6 high+fingerprint-fail)
 *   F11 — ingestion_contract: "v1" frozen field
 *   Dependency-injected IO (testable without subprocess)
 *
 * Public API:
 *   parseArgv — pure argv state machine
 *   validateArgs — required-field + range validation
 *   determineExitCode — F8 three-tier mapping from AuditBlock
 *   computeBinarySha256 — dist/ + package.json supply-chain anchor
 *   runEngramCounter — full pipeline (parse → join → aggregate → hash)
 *   main — top-level orchestrator (uses process.* by default; tests inject)
 *
 * Zero runtime deps. All IO via injected interfaces for testability.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { joinByQueryId, aggregateTokens, aggregateByWorkload, mismatchSeverity } from "./counter.js";
import { parseJsonlFile, computeWorkloadFingerprint } from "./parser.js";
import { buildAuditOutput, verifyAuditTrailHash } from "./hash.js";
import { DEFAULT_THRESHOLDS, NullLogger } from "./types.js";
import type {
  AuditBlock,
  AuditOutput,
  Logger,
  LogContext,
  Sha256Hex,
  Thresholds,
  Warning,
  WorkloadFingerprint,
} from "./types.js";
import type { BuildAuditInput } from "./hash.js";
import type { FingerprintOutput } from "./parser.js";

// ════════════════════════════════════════════════════════════════════
// Dependency-injected IO interface (testability without subprocess)
// ════════════════════════════════════════════════════════════════════

export interface RuntimeIO {
  argv: readonly string[]; // process.argv.slice(2) — flag args only
  cwd: string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  /**
   * Exit handler. Real impl calls process.exit (never returns).
   * Test mocks just record the code and return. main() has explicit
   * `return` after each exit call to terminate flow either way.
   */
  exit: (code: number) => void;
  /** Optional override for binary_sha256 computation (default: resolve from import.meta.url). */
  distDir?: string;
  /** Optional override for package.json path. */
  packageJsonPath?: string;
}

/** Construct default RuntimeIO from process.* — used by bin/engram-counter.js. */
export function defaultIO(): RuntimeIO {
  return {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code: number) => {
      process.exit(code);
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// argv parser (pure)
// ════════════════════════════════════════════════════════════════════

export interface ParsedArgs {
  baseline?: string;
  active?: string;
  audit_id?: string;
  cost_per_million?: number;
  no_binary_hash: boolean;
  workload_absent_fail_closed?: number;
  count_skew_warn?: number;
  mismatch_warn?: number;
  mismatch_high?: number;
  baseline_file_label?: string;
  active_file_label?: string;
  pretty: boolean;
  help: boolean;
  version: boolean;
  /** Unknown / malformed flags accumulated for error reporting. */
  errors: string[];
}

const FLAG_REQUIRES_VALUE = new Set([
  "--baseline",
  "--active",
  "--audit-id",
  "--cost-per-million",
  "--workload-absent-fail-closed",
  "--count-skew-warn",
  "--mismatch-warn",
  "--mismatch-high",
  "--baseline-file-label",
  "--active-file-label",
]);

const FLAG_BOOLEAN = new Set([
  "--no-binary-hash",
  "--pretty",
  "--help",
  "-h",
  "--version",
  "-V",
]);

function parseNumber(s: string): number | undefined {
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse argv into a ParsedArgs structure.
 *
 * Recognizes long-flags (`--name value`) + two short shortcuts (`-h`, `-V`).
 * Unknown flags accumulate in `errors[]` — caller decides whether to abort.
 *
 * Pure-functional: no side effects, no process.* access.
 */
export function parseArgv(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    no_binary_hash: false,
    pretty: false,
    help: false,
    version: false,
    errors: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (!arg.startsWith("-")) {
      parsed.errors.push(`Unexpected positional argument: "${arg}"`);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      parsed.version = true;
      continue;
    }
    if (arg === "--no-binary-hash") {
      parsed.no_binary_hash = true;
      continue;
    }
    if (arg === "--pretty") {
      parsed.pretty = true;
      continue;
    }

    if (FLAG_REQUIRES_VALUE.has(arg)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        parsed.errors.push(`Flag ${arg} requires a value`);
        continue;
      }
      i++;

      switch (arg) {
        case "--baseline":
          parsed.baseline = next;
          break;
        case "--active":
          parsed.active = next;
          break;
        case "--audit-id":
          parsed.audit_id = next;
          break;
        case "--cost-per-million": {
          const n = parseNumber(next);
          if (n === undefined || n < 0) {
            parsed.errors.push(`--cost-per-million requires non-negative number; got "${next}"`);
          } else {
            parsed.cost_per_million = n;
          }
          break;
        }
        case "--workload-absent-fail-closed": {
          const n = parseNumber(next);
          if (n === undefined || n < 0 || n > 1) {
            parsed.errors.push(`--workload-absent-fail-closed requires ratio in [0, 1]; got "${next}"`);
          } else {
            parsed.workload_absent_fail_closed = n;
          }
          break;
        }
        case "--count-skew-warn": {
          const n = parseNumber(next);
          if (n === undefined || n < 0 || n > 1) {
            parsed.errors.push(`--count-skew-warn requires ratio in [0, 1]; got "${next}"`);
          } else {
            parsed.count_skew_warn = n;
          }
          break;
        }
        case "--mismatch-warn": {
          const n = parseNumber(next);
          if (n === undefined || n < 0 || n > 1) {
            parsed.errors.push(`--mismatch-warn requires ratio in [0, 1]; got "${next}"`);
          } else {
            parsed.mismatch_warn = n;
          }
          break;
        }
        case "--mismatch-high": {
          const n = parseNumber(next);
          if (n === undefined || n < 0 || n > 1) {
            parsed.errors.push(`--mismatch-high requires ratio in [0, 1]; got "${next}"`);
          } else {
            parsed.mismatch_high = n;
          }
          break;
        }
        case "--baseline-file-label":
          parsed.baseline_file_label = next;
          break;
        case "--active-file-label":
          parsed.active_file_label = next;
          break;
      }
      continue;
    }

    if (FLAG_BOOLEAN.has(arg)) {
      // Already handled above (defensive — should be unreachable)
      continue;
    }

    parsed.errors.push(`Unknown flag: ${arg}`);
  }

  return parsed;
}

// ════════════════════════════════════════════════════════════════════
// Validation
// ════════════════════════════════════════════════════════════════════

export interface ValidatedArgs {
  baseline: string;
  active: string;
  audit_id?: string;
  cost_per_million: number | null;
  no_binary_hash: boolean;
  thresholds: Thresholds;
  baseline_file_label: string;
  active_file_label: string;
  pretty: boolean;
}

export type UsageError = string;

/**
 * Validate ParsedArgs and produce a ValidatedArgs (or list of usage errors).
 *
 * Required: --baseline + --active.
 * Threshold ranges: enforced by parseArgv; cross-validation here for warn < high.
 */
export function validateArgs(parsed: ParsedArgs): { ok: true; value: ValidatedArgs } | { ok: false; errors: UsageError[] } {
  const errors: UsageError[] = [...parsed.errors];

  if (parsed.baseline === undefined) {
    errors.push("Missing required flag: --baseline <path>");
  }
  if (parsed.active === undefined) {
    errors.push("Missing required flag: --active <path>");
  }

  // adversarial P0-1: reject --audit-id matching the reserved derived-id
  // format `ec_<12hex>`. Without this gate, a forged audit can claim a derived
  // audit_id pattern that bypasses the linkage check via reproducible_mode=true.
  if (parsed.audit_id !== undefined && /^ec_[0-9a-f]{12}$/.test(parsed.audit_id)) {
    errors.push(
      `--audit-id "${parsed.audit_id}" uses the reserved 'ec_<12hex>' format which is for content-derived ids only. ` +
        `Use a different format (e.g., 'audit-q3-2026', 'customer-foo-batch').`,
    );
  }

  // Cross-validate warn < high if both provided
  const warn = parsed.mismatch_warn ?? DEFAULT_THRESHOLDS.mismatch_warn;
  const high = parsed.mismatch_high ?? DEFAULT_THRESHOLDS.mismatch_high;
  if (warn >= high) {
    errors.push(`--mismatch-warn (${warn}) must be < --mismatch-high (${high})`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const thresholds: Thresholds = {
    workload_absent_fail_closed:
      parsed.workload_absent_fail_closed ?? DEFAULT_THRESHOLDS.workload_absent_fail_closed,
    mismatch_warn: warn,
    mismatch_high: high,
    count_skew_warn: parsed.count_skew_warn ?? DEFAULT_THRESHOLDS.count_skew_warn,
  };

  const validated: ValidatedArgs = {
    baseline: parsed.baseline as string,
    active: parsed.active as string,
    cost_per_million: parsed.cost_per_million ?? null,
    no_binary_hash: parsed.no_binary_hash,
    thresholds,
    baseline_file_label: parsed.baseline_file_label ?? (parsed.baseline as string),
    active_file_label: parsed.active_file_label ?? (parsed.active as string),
    pretty: parsed.pretty,
  };
  if (parsed.audit_id !== undefined) validated.audit_id = parsed.audit_id;

  return { ok: true, value: validated };
}

// ════════════════════════════════════════════════════════════════════
// F8 three-tier exit-code mapping (pure)
// ════════════════════════════════════════════════════════════════════

/**
 * Per SPEC F8:
 *   0 — clean: mismatch ≤ thresholds.mismatch_warn, fingerprint matches
 *   5 — warn: mismatch_warn < ratio ≤ mismatch_high, OR
 *              fingerprint detected count_skew but sets match
 *   6 — failed: mismatch > high, OR
 *               fingerprint_match === null (workload_field_absent fail-closed), OR
 *               fingerprint_match === false (set_mismatch / count_skew + sets differ)
 */
export function determineExitCode(audit: AuditBlock): 0 | 5 | 6 {
  // adversarial P0-3 — empty audit is a "no-evidence" forgery vector.
  // An attacker feeding two empty (or non-overlapping) JSONL files produces
  // mismatch_severity="ok", fingerprint_match=true (empty sets are equal),
  // exit 0 — but with saved_total=0 + 0 matched queries. Procurement could
  // be misled into believing "audit passed" without checking numbers.
  // Failed audit signal: any audit with zero matched + zero baseline_only +
  // zero active_only is insufficient evidence — exit 6.
  if (
    audit.counts.matched_queries === 0 &&
    audit.counts.baseline_only_queries === 0 &&
    audit.counts.active_only_queries === 0
  ) {
    return 6;
  }

  // Fingerprint fail-closed has highest priority
  if (audit.fingerprint.fingerprint_match === null) return 6;
  if (audit.fingerprint.fingerprint_match === false) return 6;

  const severity = mismatchSeverity(
    audit.counts.matched_queries,
    audit.counts.baseline_only_queries,
    audit.counts.active_only_queries,
    {
      warn: audit.thresholds.mismatch_warn,
      high: audit.thresholds.mismatch_high,
    },
  );

  if (severity === "high") return 6;
  if (severity === "warn") return 5;
  return 0;
}

// ════════════════════════════════════════════════════════════════════
// binary_sha256 — supply-chain anchor
// ════════════════════════════════════════════════════════════════════

/**
 * Compute SHA-256 over (filename + bytes) of every dist/*.js + package.json.
 *
 * Procurement-friendly: anyone with access to the binary can recompute the
 * same hash via `sha256sum dist/*.js package.json | sort | sha256sum` (or
 * with our exact algorithm). A fork that modifies any code file produces
 * a DIFFERENT binary_sha256, defeating "claim engram-counter v0.1.0 ran
 * but actually ran a modified build" attacks.
 *
 * Note: this hashes the BUILD ARTIFACT (dist/), not the SOURCE (src/).
 * Sigstore --provenance attestation links the dist hash to the source git
 * commit via the npm publish transparency log.
 */
export function computeBinarySha256(
  distDir: string,
  packageJsonPath?: string,
  logger?: Logger,
): Sha256Hex {
  const hash = createHash("sha256");
  const log = logger ?? new NullLogger();

  // adversarial P0-2: hash ALL regular files in dist/, not just .js.
  // Previous .endsWith('.js') filter allowed fork to inject .mjs/.cjs/.node/
  // postinstall.sh files that wouldn't affect binary_sha256 but WOULD be loaded
  // by Node module resolution. Include every regular file to defeat polyglot
  // file injection.
  let files: string[] = [];
  try {
    files = readdirSync(distDir).sort();
  } catch {
    log.warn(`computeBinarySha256: dist directory not found at ${distDir}`);
    hash.update("(no-dist)");
  }

  if (files.length === 0 && logger !== undefined) {
    log.warn(
      `computeBinarySha256: dist directory ${distDir} contains 0 files — binary_sha256 will be a no-dist sentinel hash`,
    );
  }

  for (const file of files) {
    const filePath = join(distDir, file);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        log.warn(`computeBinarySha256: skipping non-regular file ${filePath}`);
        continue;
      }
      const contents = readFileSync(filePath);
      hash.update(file);
      hash.update("\n");
      hash.update(contents);
      hash.update("\n");
    } catch (e) {
      log.warn(
        `computeBinarySha256: failed to read ${filePath}: ${(e as Error).message}`,
      );
    }
  }

  // 2. Hash package.json (contains version, dependencies — supply-chain critical)
  const pkgPath = packageJsonPath ?? join(distDir, "..", "package.json");
  try {
    const pkg = readFileSync(pkgPath);
    hash.update("package.json\n");
    hash.update(pkg);
  } catch {
    log.warn(`computeBinarySha256: package.json not found at ${pkgPath}`);
  }

  return `sha256:${hash.digest("hex")}` as Sha256Hex;
}

// ════════════════════════════════════════════════════════════════════
// Logger that writes to injected stderr
// ════════════════════════════════════════════════════════════════════

class StderrLogger implements Logger {
  constructor(private readonly stderr: { write(s: string): void }) {}

  info(message: string, _context?: LogContext): void {
    this.stderr.write(`[INFO] ${message}\n`);
  }

  warn(message: string, _context?: LogContext): void {
    this.stderr.write(`[WARN] ${message}\n`);
  }

  debug(message: string, _context?: LogContext): void {
    this.stderr.write(`[DEBUG] ${message}\n`);
  }
}

// ════════════════════════════════════════════════════════════════════
// FingerprintOutput → WorkloadFingerprint mapping (parser → audit shape)
// ════════════════════════════════════════════════════════════════════

function fingerprintForAudit(fp: FingerprintOutput): WorkloadFingerprint {
  // empty_input maps to workload_field_absent for v0.1.0 enum compat.
  const reason =
    fp.fingerprint_reason === "empty_input"
      ? "workload_field_absent"
      : fp.fingerprint_reason;
  return {
    baseline_workloads: fp.baseline_workloads,
    active_workloads: fp.active_workloads,
    fingerprint_match: fp.fingerprint_match,
    fingerprint_reason: reason,
    count_per_workload: fp.count_per_workload,
  };
}

// ════════════════════════════════════════════════════════════════════
// Pipeline orchestration — pure-ish (only IO is via injected logger)
// ════════════════════════════════════════════════════════════════════

export interface AuditError {
  message: string;
  exitCode: 2 | 6;
}

export interface RunOptions {
  counter_version: string;
  binary_sha256?: string;
  logger?: Logger;
}

/**
 * Run the complete engram-counter pipeline:
 *   1. parseJsonlFile(baseline) + parseJsonlFile(active)
 *   2. joinByQueryId
 *   3. computeWorkloadFingerprint
 *   4. aggregateTokens + aggregateByWorkload
 *   5. cost_usd if --cost-per-million given
 *   6. buildAuditOutput (JCS + SHA-256)
 *   7. verifyAuditTrailHash self-check
 *
 * Returns AuditOutput on success or AuditError on failure (parser error,
 * verifier failure, etc).
 */
export function runEngramCounter(
  validated: ValidatedArgs,
  options: RunOptions,
): { ok: true; value: AuditOutput } | { ok: false; error: AuditError } {
  const logger = options.logger ?? new NullLogger();

  // 1. Parse baseline + active
  const b = parseJsonlFile(validated.baseline, { logger });
  if (!b.ok) {
    return {
      ok: false,
      error: { message: `Failed to parse baseline: ${b.error.message}`, exitCode: 6 },
    };
  }

  const a = parseJsonlFile(validated.active, { logger });
  if (!a.ok) {
    return {
      ok: false,
      error: { message: `Failed to parse active: ${a.error.message}`, exitCode: 6 },
    };
  }

  // 2. Join by query_id
  const { matched, baseline_only, active_only } = joinByQueryId(
    b.value.entries,
    a.value.entries,
  );

  // 3. Workload fingerprint
  const fp = computeWorkloadFingerprint({
    baseline: b.value.entries,
    active: a.value.entries,
    workloadAbsentFailClosed: validated.thresholds.workload_absent_fail_closed,
    countSkewWarn: validated.thresholds.count_skew_warn,
  });

  // 4. Aggregate
  const tokens = aggregateTokens(matched);
  const per_workload = aggregateByWorkload(matched);

  // 5. Cost USD (if --cost-per-million provided)
  let cost_usd: number | null = null;
  if (validated.cost_per_million !== null) {
    // saved_total tokens × (cost / 1M tokens)
    cost_usd = (tokens.saved_total * validated.cost_per_million) / 1_000_000;
  }

  // 6. Collect all warnings (parser baseline + active + fingerprint)
  const warnings: Warning[] = [
    ...b.value.warnings,
    ...a.value.warnings,
    ...fp.warnings,
  ];

  // 7. Build audit input
  const input: BuildAuditInput = {
    counter_version: options.counter_version,
    mode: validated.no_binary_hash ? "dev" : "strict",
    inputs: {
      baseline_file: validated.baseline_file_label,
      baseline_sha256: b.value.file_sha256,
      active_file: validated.active_file_label,
      active_sha256: a.value.file_sha256,
      bom_stripped: b.value.bom_stripped || a.value.bom_stripped,
    },
    counts: {
      baseline_entries: b.value.entries.length,
      active_entries: a.value.entries.length,
      matched_queries: matched.length,
      baseline_only_queries: baseline_only.length,
      active_only_queries: active_only.length,
    },
    tokens,
    cost_usd,
    per_workload,
    fingerprint: fingerprintForAudit(fp),
    thresholds: validated.thresholds,
    warnings,
  };

  if (options.binary_sha256 !== undefined) {
    input.binary_sha256 = options.binary_sha256;
  }

  // 8. Build output (JCS + SHA-256)
  const out = buildAuditOutput(input, {
    ...(validated.audit_id !== undefined && {
      audit_id: validated.audit_id,
      reproducible_mode: true,
    }),
  });

  // 9. Self-verify (defense against internal bug producing inconsistent output)
  const verify = verifyAuditTrailHash(out);
  if (!verify.ok) {
    return {
      ok: false,
      error: {
        message: `Internal verification failure: ${verify.error.message}`,
        exitCode: 6,
      },
    };
  }

  return { ok: true, value: out };
}

// ════════════════════════════════════════════════════════════════════
// Emit + help + version
// ════════════════════════════════════════════════════════════════════

function emit(output: AuditOutput, io: RuntimeIO, pretty: boolean): void {
  const json = pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
  io.stdout.write(json);
  io.stdout.write("\n");
}

const HELP_TEXT = `engram-counter — open-source AI token savings auditor

USAGE:
  engram-counter --baseline <path> --active <path> [options]

REQUIRED:
  --baseline <path>            JSONL log file (engram OFF, baseline window)
  --active <path>              JSONL log file (engram ON, active window)

OPTIONS:
  --audit-id <string>          Explicit audit_id (enables reproducible_mode)
  --cost-per-million <number>  Compute cost_usd from saved tokens
  --no-binary-hash             Skip binary_sha256 (mode="dev"; default is "strict")
  --workload-absent-fail-closed <ratio>   Fail-closed threshold (default 0.01)
  --count-skew-warn <ratio>    Count skew warn threshold (default 0.5)
  --mismatch-warn <ratio>      Mismatch warn threshold (default 0.1)
  --mismatch-high <ratio>      Mismatch high threshold (default 0.5)
  --baseline-file-label <s>    Override file label in audit (redacted reporting)
  --active-file-label <s>      Override file label in audit
  --pretty                     Pretty-print JSON output
  --help, -h                   Show this help
  --version, -V                Show version

EXIT CODES (per SPEC F8):
  0   Clean audit (mismatch ≤ warn threshold, fingerprint matches)
  5   Partial audit warning (warn < mismatch ≤ high)
  6   Failed audit (mismatch > high OR fingerprint fail-closed/false)
  2   Usage error (invalid argv)
  1   Internal error

OUTPUT:
  AuditOutput JSON on stdout.
  [WARN]/[ERROR] messages on stderr.

REPRODUCIBILITY:
  With --audit-id provided, two invocations on the same input bytes
  produce byte-identical audit_trail_hash. The Apache 2.0 source is
  auditable at https://github.com/NickCirv/engram-counter.

For SPEC + methodology: https://github.com/NickCirv/engram-counter
`;

// ════════════════════════════════════════════════════════════════════
// main — top-level orchestrator with dependency-injected IO
// ════════════════════════════════════════════════════════════════════

export async function main(io: RuntimeIO = defaultIO()): Promise<void> {
  try {
    const parsed = parseArgv(io.argv);

    if (parsed.help) {
      io.stdout.write(HELP_TEXT);
      io.exit(0);
      return;
    }

    if (parsed.version) {
      const pkgPath =
        io.packageJsonPath ?? resolveDefaultPackageJsonPath(io);
      let version = "unknown";
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
        version = pkg.version ?? "unknown";
      } catch {
        // Fall through with "unknown"
      }
      io.stdout.write(`engram-counter ${version}\n`);
      io.exit(0);
      return;
    }

    const valid = validateArgs(parsed);
    if (!valid.ok) {
      for (const e of valid.errors) {
        io.stderr.write(`[ERROR] ${e}\n`);
      }
      io.stderr.write("\nRun with --help for usage.\n");
      io.exit(2);
      return;
    }

    // Compute binary_sha256 in strict mode (default)
    let binary_sha256: string | undefined;
    if (!valid.value.no_binary_hash) {
      const distDir =
        io.distDir ?? resolveDefaultDistDir(io);
      binary_sha256 = computeBinarySha256(distDir, io.packageJsonPath);
    }

    // Read counter_version from package.json
    const pkgPath = io.packageJsonPath ?? resolveDefaultPackageJsonPath(io);
    let counter_version = "unknown";
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      counter_version = pkg.version ?? "unknown";
    } catch {
      // Fall through
    }

    const logger = new StderrLogger(io.stderr);

    const result = runEngramCounter(valid.value, {
      counter_version,
      ...(binary_sha256 !== undefined && { binary_sha256 }),
      logger,
    });

    if (!result.ok) {
      io.stderr.write(`[ERROR] ${result.error.message}\n`);
      io.exit(result.error.exitCode);
      return;
    }

    emit(result.value, io, valid.value.pretty);

    const exitCode = determineExitCode(result.value.audit);
    io.exit(exitCode);
  } catch (err) {
    // F8 internal-error path
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";
    io.stderr.write(`[INTERNAL] ${msg}\n`);
    if (stack) io.stderr.write(stack + "\n");
    io.exit(1);
  }
}

// ════════════════════════════════════════════════════════════════════
// Resolvers — find dist/ and package.json relative to compiled module
// ════════════════════════════════════════════════════════════════════

function resolveDefaultDistDir(io: RuntimeIO): string {
  // When compiled to dist/cli.js, __dirname points to dist/.
  // When run via tsx for tests, __dirname points to src/, so dist/ is a sibling.
  // Caller can override via io.distDir.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const here = typeof __dirname === "string" ? __dirname : io.cwd;
  // If here ends in /dist, it IS the dist dir; otherwise look for sibling dist/
  if (here.endsWith("/dist") || here.endsWith("\\dist")) return here;
  return join(here, "..", "dist");
}

function resolveDefaultPackageJsonPath(io: RuntimeIO): string {
  // Same resolution whether compiled (dist/cli.js → ../package.json) or in src (src/cli.ts → ../package.json).
  const here = typeof __dirname === "string" ? __dirname : io.cwd;
  return join(here, "..", "package.json");
}
