#!/usr/bin/env node
/**
 * engram-counter CLI entry — v0.1.0 production.
 *
 * Thin stub that delegates to the compiled cli.js. All argv parsing, F7/F8
 * exit logic, audit assembly, and JCS hashing live in dist/cli.js.
 *
 * The binary_sha256 emitted in strict mode (default) is computed over
 * dist/*.js + package.json — a fork modifying any file produces a different
 * binary_sha256 that procurement teams independently verify.
 */

"use strict";

const { main } = require("../dist/cli.js");

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? err.stack : "";
  process.stderr.write("[INTERNAL] " + msg + "\n");
  if (stack) process.stderr.write(stack + "\n");
  process.exit(1);
});
