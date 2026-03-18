/**
 * config.ts — Zod-validated environment configuration.
 *
 * All env vars are validated at import time. If any required var is
 * missing or malformed, the process exits immediately with a clear
 * error message. No silent failures.
 */

import path from "node:path";
import { z } from "zod";
import "dotenv/config";

// ─── Env schema ───────────────────────────────────────────────────────────────

const EnvSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-", "Must be a bot token"),
  SLACK_SIGNING_SECRET: z.string().min(1, "Required"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-", "Must be an app-level token"),

  // Monorepo
  MONOREPO_ROOT: z.string().min(1, "Required"),
  MY_SERVICE: z.string().min(1, "Required"),
  MY_SERVICE_PATH: z.string().min(1, "Required"),
  // Comma-separated list of service paths the pipeline is allowed to touch.
  // Defaults to MY_SERVICE_PATH if not set.
  ALLOWED_SERVICE_PATHS: z.string().optional(),

  // Git
  GITHUB_REMOTE: z.string().default("origin"),
  DEFAULT_BASE_BRANCH: z.string().default("main"),

  // GitLab
  GITLAB_PROJECT_ID: z.string().min(1, "Required"),
  GITLAB_HOST: z.string().url("Must be a valid URL"),
  GITLAB_TOKEN: z.string().min(1, "Required"),

  // Access Control — single admin user who approves pipeline requests
  ADMIN_USER_ID: z.string().min(1, "Required — Slack user ID of the admin who approves requests"),

  // Reviewer user IDs (optional) — comma-separated Slack user IDs for MR reviewer dropdown.
  // If unset, the reviewer field shows all workspace members.
  REVIEWER_USER_IDS: z.string().optional(),

  // Pipeline (optional with defaults)
  MAX_REVIEW_ITERATIONS: z.coerce.number().int().min(1).max(10).default(3),
  WORKTREE_BASE_DIR: z.string().default("/tmp/ecr-worktrees"),
  TASK_TTL_MINUTES: z.coerce.number().int().min(5).default(60),
  RATE_LIMIT_SECONDS: z.coerce.number().int().min(5).default(30),
  DB_PATH: z.string().default("./data/ecr-factory.db"),
});

// ─── Parse and validate ───────────────────────────────────────────────────────

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`\nConfiguration validation failed:\n${issues}\n`);
  console.error("Copy .env.example to .env and fill in all required values.\n");
  process.exit(1);
}

const env = parsed.data;

// ─── Exported config object ───────────────────────────────────────────────────

export const CONFIG = {
  slack: {
    botToken: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    appToken: env.SLACK_APP_TOKEN,
  },
  repo: {
    root: env.MONOREPO_ROOT,
    remote: env.GITHUB_REMOTE,
    baseBranch: env.DEFAULT_BASE_BRANCH,
  },
  service: {
    name: env.MY_SERVICE,
    path: env.MY_SERVICE_PATH,
    fullPath: path.join(env.MONOREPO_ROOT, env.MY_SERVICE_PATH),
  },
  allowedServicePaths: env.ALLOWED_SERVICE_PATHS
    ? env.ALLOWED_SERVICE_PATHS.split(",").map((s) => s.trim()).filter(Boolean)
    : [env.MY_SERVICE_PATH],
  gitlab: {
    projectId: env.GITLAB_PROJECT_ID,
    host: env.GITLAB_HOST,
    token: env.GITLAB_TOKEN,
  },
  adminUserId: env.ADMIN_USER_ID,
  reviewerUserIds: env.REVIEWER_USER_IDS
    ? env.REVIEWER_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
    : [],
  pipeline: {
    maxReviewIterations: env.MAX_REVIEW_ITERATIONS,
    worktreeBaseDir: env.WORKTREE_BASE_DIR,
    taskTtlMinutes: env.TASK_TTL_MINUTES,
    rateLimitSeconds: env.RATE_LIMIT_SECONDS,
  },
  db: {
    path: env.DB_PATH,
  },
} as const;

// ─── Path safety ──────────────────────────────────────────────────────────────

/**
 * Validates that all file paths are within the allowed service boundaries.
 * Checks against all paths in ALLOWED_SERVICE_PATHS.
 * Throws immediately if any file is out of scope.
 */
export function assertPathsInScope(files: string[]): void {
  const allowed = CONFIG.allowedServicePaths;
  for (const file of files) {
    const normalized = file.replace(/^\//, "");
    const inScope = allowed.some((p) => normalized.startsWith(p));
    if (!inScope) {
      throw new Error(
        `SCOPE VIOLATION: "${file}" is outside allowed paths: ${allowed.join(", ")}`
      );
    }
  }
}

// ─── Branch name validation ───────────────────────────────────────────────────

const BRANCH_NAME_REGEX = /^[a-zA-Z0-9\-_/]+$/;

/**
 * Validates a branch name against the allowed character set.
 * Throws if the name contains characters that could cause issues.
 */
export function assertValidBranchName(name: string): void {
  if (!BRANCH_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid branch name "${name}" — only alphanumeric, hyphens, underscores, and slashes allowed`
    );
  }
}
