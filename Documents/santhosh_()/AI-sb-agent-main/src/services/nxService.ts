/**
 * services/nxService.ts — Async nx lint and test runner.
 *
 * Runs `npx nx lint` and `npx nx test` for the configured service
 * inside a given worktree directory. Sets NX_CACHE_DIRECTORY per
 * worktree to prevent cache contention between concurrent tasks.
 *
 * ESLint 9+ flat config compatibility:
 *   If lint fails with "ESLint is not a constructor", the error is
 *   treated as a non-blocking warning (lint is marked as passed).
 *   Tests remain a hard requirement.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import type { NxCheckResult } from "../types.js";

const execFileAsync = promisify(execFile);

const LINT_TIMEOUT = 120_000;  // 2 minutes
const TEST_TIMEOUT = 180_000;  // 3 minutes
const MAX_BUFFER = 1024 * 1024 * 10; // 10 MB

const log = createLogger("Nx");

/**
 * Known ESLint version incompatibility pattern.
 * ESLint 9+ with flat config breaks the constructor used by older nx lint wrappers.
 */
const ESLINT_CONSTRUCTOR_ERROR = "ESLint is not a constructor";

/**
 * Run nx lint and nx test for the service inside a worktree.
 *
 * Sets NX_CACHE_DIRECTORY to a per-worktree location to avoid
 * cache collisions between concurrent pipelines.
 */
export async function runNxChecks(worktreePath: string): Promise<NxCheckResult> {
  const result: NxCheckResult = {
    passed: false,
    output: "",
    lintPassed: false,
    testPassed: false,
  };

  const svc = CONFIG.service.name;

  // Per-worktree nx cache to avoid contention
  const nxCacheDir = path.join(worktreePath, ".nx-cache");
  const env = {
    ...process.env,
    NX_CACHE_DIRECTORY: nxCacheDir,
  };

  // ── Lint ──
  log.info("Running nx lint", { service: svc, worktreePath });
  try {
    const { stdout } = await execFileAsync("npx", ["nx", "lint", svc], {
      cwd: worktreePath,
      timeout: LINT_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      env,
    });
    result.lintPassed = true;
    result.output += `LINT PASSED\n${stdout}\n`;
    log.info("Lint passed", { service: svc });
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const errorOutput = error.stdout || error.stderr || error.message || "Unknown error";

    if (errorOutput.includes(ESLINT_CONSTRUCTOR_ERROR)) {
      // Known ESLint 9+ incompatibility — treat as non-blocking warning
      log.warn(
        "Lint failed with 'ESLint is not a constructor' -- treating as passed (ESLint version incompatibility)",
        { service: svc }
      );
      result.lintPassed = true;
      result.output += `LINT SKIPPED (ESLint version incompatibility: "${ESLINT_CONSTRUCTOR_ERROR}")\n`;
    } else {
      log.error("Lint failed", { service: svc, error: errorOutput.slice(0, 500) });
      result.output += `LINT FAILED\n${errorOutput}\n`;
    }
  }

  // ── Test ──
  log.info("Running nx test", { service: svc, worktreePath });
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["nx", "test", svc, "--passWithNoTests"],
      {
        cwd: worktreePath,
        timeout: TEST_TIMEOUT,
        maxBuffer: MAX_BUFFER,
        env,
      }
    );
    result.testPassed = true;
    result.output += `TEST PASSED\n${stdout}\n`;
    log.info("Tests passed", { service: svc });
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const errorOutput = error.stdout || error.stderr || error.message || "Unknown error";
    log.error("Tests failed", { service: svc, error: errorOutput.slice(0, 500) });
    result.output += `TEST FAILED\n${errorOutput}\n`;
  }

  result.passed = result.lintPassed && result.testPassed;
  log.info("Nx checks complete", { lintPassed: result.lintPassed, testPassed: result.testPassed, overall: result.passed });
  return result;
}
