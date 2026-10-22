/**
 * services/gitService.ts — Worktree-based git operations.
 *
 * Phase 1 (Analysis): runs against MONOREPO_ROOT read-only. No worktree.
 * Phase 2 (Execution): creates a worktree via `git worktree add`.
 * Phases 3/3b/4: all operate inside that worktree.
 * Cleanup: `git worktree remove` on completion or failure.
 *
 * All operations are async (execFile). Symlinks node_modules from
 * the main repo. Sets NX_CACHE_DIRECTORY per worktree to avoid
 * cache contention.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG, assertValidBranchName, isPathInScope } from "../config.js";
import { buildConventionalCommitMessage } from "../schemas.js";
import type { TaskType } from "../schemas.js";
import { createLogger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000; // 30 seconds
const MAX_BUFFER = 1024 * 1024 * 50; // 50 MB

const log = createLogger("Git");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if `cwd` is inside the worktree base directory.
 * Used to decide whether to disable hooks (husky breaks in worktrees
 * because `.husky/_/husky.sh` resolves relative to the worktree, not
 * the main repo).
 */
export function isWorktreePath(cwd: string): boolean {
  // Segment-aware: "/tmp/ecr-worktrees-other" is NOT inside "/tmp/ecr-worktrees".
  const rel = path.relative(path.resolve(CONFIG.pipeline.worktreeBaseDir), path.resolve(cwd));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function git(
  args: string[],
  cwd: string = CONFIG.repo.root
): Promise<string> {
  // When running inside a worktree, disable all hooks globally via
  // core.hooksPath=/dev/null. This avoids husky failures for EVERY git
  // command (commit, push, merge, etc.) without needing --no-verify on
  // each one individually.
  const effectiveArgs = isWorktreePath(cwd)
    ? ["-c", "core.hooksPath=/dev/null", ...args]
    : args;

  log.debug(`git ${effectiveArgs.join(" ")}`, { cwd });
  const { stdout } = await execFileAsync("git", effectiveArgs, {
    cwd,
    timeout: GIT_TIMEOUT,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env },
  });
  return stdout.trim();
}

// ─── Worktree operations ──────────────────────────────────────────────────────

/**
 * Create a git worktree for a task.
 *
 * 1. Fetches latest from remote
 * 2. Creates worktree at WORKTREE_BASE_DIR/{taskId}
 * 3. Creates branch from remote base
 * 4. Symlinks node_modules from main repo
 *
 * Returns the absolute path to the worktree.
 */
export async function createWorktree(
  taskId: string,
  branchName: string
): Promise<string> {
  assertValidBranchName(branchName);

  const worktreePath = path.join(CONFIG.pipeline.worktreeBaseDir, taskId);
  log.info("Creating worktree", { taskId, branchName, worktreePath });

  // Ensure base dir exists
  await fs.mkdir(CONFIG.pipeline.worktreeBaseDir, { recursive: true });

  // Fetch latest
  log.info("Fetching latest from remote", { remote: CONFIG.repo.remote, branch: CONFIG.repo.baseBranch });
  await git(["fetch", CONFIG.repo.remote, CONFIG.repo.baseBranch]);

  // Create worktree with new branch from remote base
  await git([
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    `${CONFIG.repo.remote}/${CONFIG.repo.baseBranch}`,
  ]);

  // Symlink node_modules from main repo to avoid reinstalling
  const mainNodeModules = path.join(CONFIG.repo.root, "node_modules");
  const wtNodeModules = path.join(worktreePath, "node_modules");
  try {
    await fs.symlink(mainNodeModules, wtNodeModules, "dir");
    log.debug("Symlinked node_modules into worktree");
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    // Symlink may already exist if node_modules is tracked or pre-existing
    if (error.code !== "EEXIST") {
      log.warn("Could not symlink node_modules", { error: error.message });
    }
  }

  log.info("Worktree ready", { worktreePath });
  return worktreePath;
}

/**
 * Remove a worktree and its branch.
 * Best-effort — logs errors but does not throw.
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  log.info("Removing worktree", { worktreePath });

  // Remove the node_modules symlink we created in createWorktree.
  // git worktree remove won't delete untracked files/symlinks, causing
  // "Directory not empty" errors.
  const wtNodeModules = path.join(worktreePath, "node_modules");
  try {
    const stat = await fs.lstat(wtNodeModules);
    if (stat.isSymbolicLink()) {
      await fs.unlink(wtNodeModules);
      log.debug("Removed node_modules symlink from worktree");
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      log.warn("Could not remove node_modules symlink", { error: error.message });
    }
  }

  // Try git worktree remove
  try {
    await git(["worktree", "remove", "--force", worktreePath]);
    log.info("Worktree removed", { worktreePath });
  } catch (err) {
    log.warn("git worktree remove failed, falling back to fs.rm", {
      worktreePath,
      error: String(err),
    });

    // Fallback: force-delete the directory if git can't handle it
    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
      log.info("Worktree directory force-deleted", { worktreePath });
    } catch (rmErr) {
      log.error("Failed to force-delete worktree directory", {
        worktreePath,
        error: String(rmErr),
      });
    }
  }

  // Always prune stale worktree refs
  try {
    await git(["worktree", "prune"]);
  } catch {
    // Best effort
  }
}

/**
 * Clean up on failure: remove worktree and delete branch.
 */
export async function cleanupOnFailure(
  worktreePath: string | null,
  branchName: string | null
): Promise<void> {
  log.info("Cleaning up on failure", { worktreePath, branchName });
  if (worktreePath) {
    await removeWorktree(worktreePath);
  }

  if (branchName) {
    try {
      // Validate before handing the name to git: "-D --foo" style injection.
      assertValidBranchName(branchName);
      await git(["branch", "-D", branchName]);
      log.info("Deleted branch", { branchName });
    } catch {
      // Branch may not exist yet
    }
  }
}

// ─── Staging / Commit / Push ──────────────────────────────────────────────────

/**
 * Stage, commit, and push changes from a worktree.
 * Only stages files within the service scope.
 * Returns the short commit hash.
 */
export async function commitAndPush(
  worktreePath: string,
  branchName: string,
  title: string,
  taskType: TaskType = "bugfix",
): Promise<string> {
  assertValidBranchName(branchName);
  log.info("Staging, committing, and pushing", { branchName, title });

  // Stage all allowed service paths
  const allowedPaths = CONFIG.allowedServicePaths;
  for (const svcPath of allowedPaths) {
    await git(["add", "--", svcPath + "/"], worktreePath);
  }

  // Safety net: unstage anything outside scope
  const staged = await git(["diff", "--cached", "--name-only"], worktreePath);
  const outOfScope = staged
    .split("\n")
    .filter((f) => f && !isPathInScope(f, allowedPaths));

  if (outOfScope.length > 0) {
    log.warn("Unstaging out-of-scope files", { files: outOfScope });
  }
  for (const f of outOfScope) {
    // "--" so a file name starting with "-" is never parsed as an option.
    await git(["reset", "HEAD", "--", f], worktreePath);
  }

  // Check if there are any staged changes to commit.
  // `git diff --cached --quiet` exits 0 if nothing staged, 1 if there are changes.
  // This makes commitAndPush idempotent — safe to call on retry after a
  // prior run that committed but failed at push.
  let hasChanges = false;
  try {
    await git(["diff", "--cached", "--quiet"], worktreePath);
    // Exit 0 means nothing staged
    hasChanges = false;
  } catch {
    // Exit 1 means there are staged changes
    hasChanges = true;
  }

  if (hasChanges) {
    // Commit via the git() helper which automatically disables hooks in
    // worktrees by setting core.hooksPath=/dev/null.
    const msg = buildConventionalCommitMessage(taskType, CONFIG.service.name, title);
    await git(["commit", "-m", msg], worktreePath);
  } else {
    log.info("Nothing to commit, skipping to push");
  }

  // Always push regardless — the commit may already exist from a prior run
  log.info("Pushing to remote", { remote: CONFIG.repo.remote, branchName });
  await git(["push", CONFIG.repo.remote, branchName], worktreePath);

  // Return short hash
  const hash = await git(["rev-parse", "--short", "HEAD"], worktreePath);
  log.info("Commit and push complete", { commitHash: hash });
  return hash;
}

// ─── Diff helpers ─────────────────────────────────────────────────────────────

/**
 * Get the full scoped diff between base branch and the worktree HEAD.
 */
export async function getScopedDiff(worktreePath: string): Promise<string> {
  const pathArgs = CONFIG.allowedServicePaths.map((p) => p + "/");
  return git(
    [
      "diff",
      `${CONFIG.repo.remote}/${CONFIG.repo.baseBranch}...HEAD`,
      "--",
      ...pathArgs,
    ],
    worktreePath
  );
}

/**
 * Get diff stats (summary) for the scoped changes.
 */
export async function getScopedDiffStat(worktreePath: string): Promise<string> {
  const pathArgs = CONFIG.allowedServicePaths.map((p) => p + "/");
  return git(
    [
      "diff",
      `${CONFIG.repo.remote}/${CONFIG.repo.baseBranch}...HEAD`,
      "--stat",
      "--",
      ...pathArgs,
    ],
    worktreePath
  );
}
