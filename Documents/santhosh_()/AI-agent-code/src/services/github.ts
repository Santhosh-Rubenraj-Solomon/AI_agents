/**
 * services/github.ts — GitHub repo cloning and management.
 *
 * Clones public/private repos locally for analysis.
 * Uses simple-git for git operations.
 */

import path from "node:path";
import fs from "node:fs";
import { simpleGit } from "simple-git";
import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import type { RepoInfo } from "../types.js";

const log = createLogger("GitHub");

/**
 * Parse a GitHub URL into owner/name.
 * Supports: https://github.com/owner/repo, https://github.com/owner/repo.git
 */
export function parseGitHubUrl(
  url: string
): { owner: string; name: string } | null {
  // Strip query params, fragments, and trailing slashes before matching
  const cleaned = url.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const match = cleaned.match(
    /github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?(?:\/.*)?$/
  );
  if (match) return { owner: match[1], name: match[2] };
  return null;
}

/**
 * Clone or pull a GitHub repo locally.
 * Returns RepoInfo with local path and metadata.
 */
export async function cloneOrPullRepo(repoUrl: string): Promise<RepoInfo> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  }

  const localPath = path.join(
    CONFIG.paths.reposBase,
    parsed.owner,
    parsed.name
  );

  // Ensure base directory exists
  if (!fs.existsSync(CONFIG.paths.reposBase)) {
    fs.mkdirSync(CONFIG.paths.reposBase, { recursive: true });
  }

  const git = simpleGit();
  let defaultBranch = "main";

  if (fs.existsSync(path.join(localPath, ".git"))) {
    // Repo already exists — pull latest
    log.info("Pulling latest changes", {
      repo: `${parsed.owner}/${parsed.name}`
    });
    const localGit = simpleGit(localPath);
    try {
      await localGit.pull();
      const branchResult = await localGit.branch();
      defaultBranch = branchResult.current;
    } catch (err) {
      log.warn("Pull failed, will use existing state", { error: String(err) });
    }
  } else {
    // Clone fresh
    log.info("Cloning repository", {
      repo: `${parsed.owner}/${parsed.name}`,
      to: localPath
    });

    const cloneUrl = CONFIG.github.token
      ? repoUrl.replace(/https?:\/\//, `https://${CONFIG.github.token}@`)
      : repoUrl;

    await git.clone(cloneUrl, localPath, ["--depth", "50"]);

    const localGit = simpleGit(localPath);
    const branchResult = await localGit.branch();
    defaultBranch = branchResult.current;
  }

  log.info("Repo ready", { path: localPath, branch: defaultBranch });

  return {
    owner: parsed.owner,
    name: parsed.name,
    url: repoUrl,
    localPath,
    defaultBranch
  };
}

/**
 * Get the git diff for the last N commits (for breaking change detection).
 */
export async function getRecentDiff(
  repoPath: string,
  commits: number = 1
): Promise<string> {
  const git = simpleGit(repoPath);
  try {
    const diff = await git.diff([`HEAD~${commits}`, "HEAD"]);
    return diff;
  } catch {
    // Fallback — get all staged/unstaged changes
    try {
      return await git.diff();
    } catch {
      return "";
    }
  }
}

/**
 * Get recent commit log messages.
 */
export async function getRecentCommits(
  repoPath: string,
  count: number = 10
): Promise<string> {
  const git = simpleGit(repoPath);
  try {
    const logResult = await git.log({ maxCount: count });
    return logResult.all
      .map((c) => `${c.hash.slice(0, 7)} ${c.date} ${c.message}`)
      .join("\n");
  } catch {
    return "(no commits available)";
  }
}

/**
 * Get the list of changed files in the last N commits.
 */
export async function getChangedFiles(
  repoPath: string,
  commits: number = 1
): Promise<string[]> {
  const git = simpleGit(repoPath);
  try {
    const diff = await git.diffSummary([`HEAD~${commits}`, "HEAD"]);
    return diff.files.map((f) => f.file);
  } catch {
    return [];
  }
}

/**
 * Clean up a cloned repo directory.
 */
export function cleanupRepo(repoPath: string): void {
  try {
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
      log.info("Cleaned up repo", { path: repoPath });
    }
  } catch (err) {
    log.warn("Cleanup failed", { path: repoPath, error: String(err) });
  }
}
